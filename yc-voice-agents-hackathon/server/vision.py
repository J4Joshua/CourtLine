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
from datetime import datetime

import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fer.fer import FER
from google import genai
from google.genai import types
from loguru import logger
from openai import AsyncOpenAI
from pipecat.frames.frames import LLMRunFrame
from pydantic import BaseModel

from case_store import state

router = APIRouter()

_openai = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

# Gemini handles evidence images AND videos (POST /evidence). Created lazily —
# tolerate a missing key at import so the rest of the server still boots.
_GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
try:
    _gemini = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))
except Exception as e:  # pragma: no cover
    logger.warning(f"Gemini client init failed: {e}")
    _gemini = None

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


class EvidenceRequest(BaseModel):
    # Data-URI (preferred) or bare base64 of an exhibit — an image OR a video.
    image_b64: str
    label: str = ""         # optional human label, e.g. the file name


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
        return {"analysis": analysis, "emotion": None, "confidence": 0, "flagged": False}

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

    # ── Step 3: flagging logic ────────────────────────────────────────────────
    # Spoken alerts only for fear/anger/disgust/contempt. Surprise and neutral
    # update the badge silently but never produce a spoken alert or decision card.
    SPOKEN_ALERT = {"fear", "angry", "disgust", "contempt"}

    state.latest_emotion = dominant
    state.latest_emotion_confidence = confidence

    flagged = dominant in SPOKEN_ALERT and confidence > 40
    state.latest_emotion_flagged = flagged

    # ── Step 4: send text-only to GPT-4o — no image, no content policy issues ─
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
        analysis = f"Detected {emotion_summary}."

    state.latest_vision_result = analysis
    _push_vision(analysis)

    # ── Step 5: broadcast flagged emotion to Sidebar Intel ────────────────────
    if flagged:
        alert = f"Demeanor flag: {dominant} ({confidence}%) — {analysis}"
        asyncio.create_task(_push_decision(alert, "camera"))
        # Queue a silent context injection for the bot's next user turn
        state.pending_emotion_alerts.append(
            f"[Demeanor monitor] Subject showing {dominant} at {confidence}% confidence."
        )

    return {"analysis": analysis, "emotion": dominant, "confidence": confidence, "flagged": flagged}


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


async def _push_decision(utterance: str, tool_fired: str):
    """Broadcast a demeanor flag decision to Sidebar Intel subscribers."""
    d = state.add_decision(utterance, tool_fired)
    payload = json.dumps({
        "type": "decision",
        "timestamp": d.timestamp,
        "utterance": utterance,
        "tool_fired": tool_fired,
        "verdict": None,
        "claim": None,
    })
    dead = []
    for ws in state.decision_subscribers:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.decision_subscribers.remove(ws)


@router.get("/brief-facts")
async def get_brief_facts():
    """Extract 5-7 key verifiable facts from the loaded case brief via GPT-4o-mini."""
    brief = state.case_brief.strip()
    if not brief:
        return {"facts": []}
    try:
        resp = await _openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    "Extract 5 to 7 key verifiable facts from this case brief as short labels "
                    "under 5 words each. Return JSON: {\"facts\": [\"fact1\", \"fact2\", ...]}\n\n"
                    f"Brief:\n{brief[:3000]}"
                ),
            }],
            response_format={"type": "json_object"},
            max_tokens=220,
        )
        import json as _json
        data = _json.loads(resp.choices[0].message.content)
        facts = data.get("facts") or next(iter(data.values()), [])
        return {"facts": [str(f)[:40] for f in facts[:7]]}
    except Exception as e:
        logger.error(f"brief-facts error: {e}")
        return {"facts": []}


@router.post("/brief")
async def set_brief(req: BriefRequest):
    state.reset()   # clear all prior session data before loading new brief
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


def _inject_evidence_into_agent(summary: str):
    """Push freshly-added evidence into the LIVE agent so it reacts immediately.

    Mirrors the on_client_connected priming in bot-courtline.py: append a user
    message, then queue an LLMRunFrame. Scheduled onto the pipeline's own loop
    via run_coroutine_threadsafe so it is correct regardless of whether the HTTP
    handler shares that loop. Skips the run (but still records the message) while
    the agent is mid-response, to avoid colliding with an in-flight turn.
    """
    if state.context is None or state.worker is None or state.loop is None:
        logger.info("Evidence stored, but no live agent to notify yet.")
        return

    async def _push():
        # Re-check on the pipeline loop: the client may have disconnected between
        # scheduling and running, which clears these handles. Wrap everything —
        # exceptions in a run_coroutine_threadsafe coroutine are otherwise swallowed.
        try:
            if state.context is None or state.worker is None:
                return
            state.context.add_message({
                "role": "user",
                "content": (
                    f"New evidence just entered the record: {summary}\n"
                    "If it contradicts testimony or the case brief, flag it in one "
                    "sentence; otherwise note in one sentence what it establishes."
                ),
            })
            # Don't kick off a new LLM run on top of an in-flight response — the
            # message is already in context and will be seen on the next turn.
            if not state.agent_speaking:
                await state.worker.queue_frames([LLMRunFrame()])
        except Exception as e:
            logger.error(f"Evidence injection failed: {e}")

    asyncio.run_coroutine_threadsafe(_push(), state.loop)


def _parse_media(raw: str) -> tuple[bytes, str]:
    """Decode a data-URI (preferred) or bare base64 into (bytes, mime_type).

    The data-URI carries the real MIME type so Gemini knows whether it's an
    image or a video; bare base64 defaults to image/jpeg.
    """
    mime = "image/jpeg"
    b64 = raw
    if raw.startswith("data:"):
        header, b64 = raw.split(",", 1)
        mime = header[5:].split(";", 1)[0] or mime   # "data:video/mp4;base64" -> "video/mp4"
    elif "," in raw:
        b64 = raw.split(",", 1)[1]
    return base64.b64decode(b64), mime


def _gemini_describe(media_bytes: bytes, mime: str, prompt: str) -> str:
    """Blocking Gemini call (image or video). Run via run_in_executor so it
    doesn't block the event loop. Inline data covers files up to ~100MB."""
    resp = _gemini.models.generate_content(
        model=_GEMINI_MODEL,
        contents=types.Content(parts=[
            types.Part(inline_data=types.Blob(data=media_bytes, mime_type=mime)),
            types.Part(text=prompt),
        ]),
    )
    return (resp.text or "").strip()


_PLAIN = " Respond in plain prose — no markdown, headers, or bullet points."
_IMAGE_PROMPT = (
    "You are assisting a trial lawyer. This image is a piece of evidence or an "
    "exhibit submitted during a live trial. Transcribe any text you can read "
    "(OCR) and describe what it shows in 2-4 sentences, focusing on facts "
    "relevant to a case: names, dates, times, amounts, locations, and "
    "statements. Be concise and strictly factual — do not speculate." + _PLAIN
)
_VIDEO_PROMPT = (
    "You are assisting a trial lawyer. This is a VIDEO exhibit submitted during a "
    "live trial. Describe what happens across the clip, noting the approximate "
    "timestamp of any key moment, and transcribe any spoken or on-screen text. "
    "Focus on facts relevant to a case: people, actions, times, locations, and "
    "statements. 2-5 sentences, strictly factual — do not speculate." + _PLAIN
)


@router.post("/evidence")
async def add_evidence(req: EvidenceRequest):
    """Accept an exhibit image OR video, describe it with Gemini, add it to the
    case knowledge, and notify the live agent in real time."""
    if _gemini is None:
        return {"error": "Gemini is not configured (set GEMINI_API_KEY)."}

    try:
        media_bytes, mime = _parse_media(req.image_b64)
    except Exception:
        return {"error": "Invalid base64 payload"}

    is_video = mime.startswith("video/")
    prompt = _VIDEO_PROMPT if is_video else _IMAGE_PROMPT

    loop = asyncio.get_event_loop()
    try:
        summary = await loop.run_in_executor(
            None, _gemini_describe, media_bytes, mime, prompt
        )
    except Exception as e:
        logger.error(f"Evidence analysis error: {e}")
        return {"error": f"Evidence analysis failed: {e}"}
    if not summary:
        return {"error": "Gemini returned no description."}

    summary = summary[:1500]
    label = req.label.strip()
    state.add_evidence(summary, label)

    # Persist into the case brief so recall_case() surfaces it on future turns.
    kind = "VIDEO EVIDENCE" if is_video else "EVIDENCE"
    header = f"\n\n{kind} — {label}" if label else f"\n\n{kind} SUBMITTED"
    state.case_brief = (state.case_brief or "") + f"{header}\n{summary}"

    logger.info(f"Evidence added ({'video' if is_video else 'image'}, "
                f"{label or 'unlabeled'}, {len(summary)} chars)")

    # Show it in the Sidebar Intel feed.
    kind_label = "Video evidence" if is_video else "Evidence"
    card = f"{kind_label} added{f' — {label}' if label else ''}: {summary}"
    await _push_decision(card, "evidence")

    # Push into the live agent so it reacts now.
    _inject_evidence_into_agent(summary)

    return {"ok": True, "summary": summary, "label": label, "kind": "video" if is_video else "image"}


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
                "verdict": d.verdict,
                "claim": d.claim,
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
