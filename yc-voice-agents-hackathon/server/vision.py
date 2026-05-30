"""CourtLine vision routes — mounted onto the Pipecat FastAPI app.

Exports `router` (APIRouter) so main.py can do:
    from pipecat.runner.run import app
    from vision import router
    app.include_router(router)

Endpoints:
  POST /analyze-photo  — base64 image → FER (local) → GPT-4o text → observation
  POST /brief          — load case facts into shared state
  GET  /state          — dump current state (debug)
  WS   /ws/transcript  — live transcript + vision events
  WS   /ws/decisions   — live agent decision log

Analysis flow (avoids GPT-4o face/content-policy refusals):
  1. FER runs locally on the raw image, producing emotion scores.
  2. Those scores (text only) are sent to GPT-4o for a courtroom-relevant observation.
"""

import asyncio
import base64
import json
import os

import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fer.fer import FER
from loguru import logger
from openai import AsyncOpenAI
from pydantic import BaseModel

from case_store import state

router = APIRouter()

_openai = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

# Initialise once at module load — loading the model is expensive.
# mtcnn=False uses OpenCV Haar cascades (fast, no extra dep);
# set mtcnn=True for higher accuracy if the mtcnn package is installed.
_fer = FER(mtcnn=False)


def _run_fer_sync(img_bytes: bytes) -> dict | None:
    """Decode image bytes and run FER. Returns emotion dict or None if no face found.
    Called via run_in_executor so it doesn't block the async loop."""
    img_array = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if img is None:
        return None
    results = _fer.detect_emotions(img)
    if not results:
        return None
    # Use the face with the highest detection confidence
    best = max(results, key=lambda r: r.get("box", [0, 0, 0, 0])[2])  # widest box = closest
    return best["emotions"]


class PhotoRequest(BaseModel):
    image_b64: str  # raw base64 or data-URI


class CaseInfo(BaseModel):
    caseName: str = ""
    defendantName: str = ""
    charges: str = ""
    jurisdiction: str = ""


class FileUpload(BaseModel):
    name: str
    type: str
    b64: str


class BriefRequest(BaseModel):
    # Structured format from the 3-step UI
    case_info: CaseInfo | None = None
    notes: str = ""
    files: list[FileUpload] = []
    # Legacy plain-text format
    brief: str | None = None


@router.post("/analyze-photo")
async def analyze_photo(req: PhotoRequest):
    b64 = req.image_b64
    if "," in b64:
        b64 = b64.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(b64)
    except Exception:
        return {"error": "Invalid base64 payload"}

    # ── Step 1: run FER locally (CPU-bound → thread pool) ────────────────────
    loop = asyncio.get_event_loop()
    try:
        emotions = await loop.run_in_executor(None, _run_fer_sync, img_bytes)
    except Exception as e:
        logger.error(f"FER error: {e}")
        emotions = None

    if not emotions:
        analysis = "No face detected in frame — ensure the subject is clearly visible."
        state.latest_vision_result = analysis
        _push_vision(analysis)
        return {"analysis": analysis}

    # ── Step 2: format FER output as text ────────────────────────────────────
    dominant = max(emotions, key=emotions.get)
    confidence = round(emotions[dominant] * 100)
    secondary = {
        k: round(v * 100)
        for k, v in sorted(emotions.items(), key=lambda x: -x[1])
        if k != dominant and v >= 0.05
    }
    secondary_str = ", ".join(f"{k} {pct}%" for k, pct in secondary.items())

    emotion_summary = f"{dominant} ({confidence}% confidence)"
    if secondary_str:
        emotion_summary += f", with secondary signals: {secondary_str}"

    logger.info(f"FER result: {emotion_summary}")

    # ── Step 3: send text-only to GPT-4o — no image, no content policy issues ─
    prompt = (
        "You are a courtroom behavior analyst assisting a lawyer. "
        f"A witness/defendant facial expression analysis shows: {emotion_summary}.\n\n"
        "Based on this data, provide a 2-sentence courtroom-relevant observation about "
        "what this suggests about the person's credibility and state of mind. "
        "Be direct and actionable for the lawyer. "
        "Example output: 'Subject shows elevated fear response (65%) with neutral masking — "
        "consistent with someone concealing information. "
        "Recommend pressing on timeline inconsistencies.'"
    )

    try:
        resp = await _openai.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=120,
        )
        analysis = resp.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"GPT-4o analysis error: {e}")
        # Graceful fallback: return the raw FER data as plain text
        analysis = f"Detected {emotion_summary}."

    state.latest_vision_result = analysis
    _push_vision(analysis)
    return {"analysis": analysis}


def _push_vision(text: str):
    """Fire-and-forget broadcast to all transcript WebSocket subscribers."""
    payload = json.dumps({"type": "vision", "text": text})

    async def _send():
        dead = []
        for ws in state.transcript_subscribers:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            state.transcript_subscribers.remove(ws)

    asyncio.create_task(_send())


@router.post("/brief")
async def set_brief(req: BriefRequest):
    if req.brief is not None:
        state.case_brief = req.brief.strip()
    else:
        parts = []
        if req.case_info:
            ci = req.case_info
            if ci.caseName:
                parts.append(f"CASE NAME: {ci.caseName}")
            if ci.defendantName:
                parts.append(f"DEFENDANT: {ci.defendantName}")
            if ci.charges:
                parts.append(f"CHARGES: {ci.charges}")
            if ci.jurisdiction:
                parts.append(f"JURISDICTION: {ci.jurisdiction}")
        if req.notes.strip():
            parts.append(f"\nNOTES AND FACTS:\n{req.notes.strip()}")
        if req.files:
            names = [f.name for f in req.files]
            parts.append(f"\nUPLOADED DOCUMENTS: {', '.join(names)}")
        state.case_brief = "\n".join(parts)

    logger.info(f"Case brief updated ({len(state.case_brief)} chars)")
    return {"ok": True, "length": len(state.case_brief)}


@router.get("/state")
async def get_state():
    return {
        "case_brief": state.case_brief,
        "latest_vision_result": state.latest_vision_result,
        "transcript": state.running_transcript[-50:],
        "decisions": [
            {
                "timestamp": d.timestamp,
                "utterance": d.utterance,
                "tool_fired": d.tool_fired,
            }
            for d in state.agent_decisions[-50:]
        ],
    }


@router.websocket("/ws/transcript")
async def ws_transcript(websocket: WebSocket):
    await websocket.accept()
    state.transcript_subscribers.append(websocket)
    for entry in state.running_transcript[-100:]:
        await websocket.send_text(json.dumps({"type": "transcript", **entry}))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.transcript_subscribers:
            state.transcript_subscribers.remove(websocket)


@router.websocket("/ws/decisions")
async def ws_decisions(websocket: WebSocket):
    await websocket.accept()
    state.decision_subscribers.append(websocket)
    for d in state.agent_decisions[-50:]:
        await websocket.send_text(
            json.dumps({
                "type": "decision",
                "timestamp": d.timestamp,
                "utterance": d.utterance,
                "tool_fired": d.tool_fired,
            })
        )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.decision_subscribers:
            state.decision_subscribers.remove(websocket)
