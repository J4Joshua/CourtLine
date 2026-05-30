"""CourtLine vision routes — mounted onto the Pipecat FastAPI app.

Exports `router` (APIRouter) so main.py can do:
    from pipecat.runner.run import app
    from vision import router
    app.include_router(router)

Endpoints:
  POST /analyze-photo  — base64 image → GPT-4o vision → stress analysis
  POST /brief          — load case facts into shared state
  GET  /state          — dump current state (debug)
  WS   /ws/transcript  — live transcript + vision events
  WS   /ws/decisions   — live agent decision log
"""

import asyncio
import base64
import json
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger
from openai import AsyncOpenAI
from pydantic import BaseModel

from case_store import state

router = APIRouter()

_openai = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))


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
        base64.b64decode(b64)
    except Exception:
        return {"error": "Invalid base64 payload"}

    prompt = (
        "Analyze this person's body language, posture, eye contact, and facial demeanor. "
        "In 2 sentences describe what you observe and whether they appear confident, "
        "nervous, evasive, or composed."
    )

    try:
        resp = await _openai.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{b64}",
                                "detail": "low",
                            },
                        },
                    ],
                }
            ],
            max_tokens=120,
        )
        analysis = resp.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"GPT-4o vision error: {e}")
        analysis = "Vision analysis unavailable."

    state.latest_vision_result = analysis

    payload = json.dumps({"type": "vision", "text": analysis})
    dead = []
    for ws in state.transcript_subscribers:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.transcript_subscribers.remove(ws)

    return {"analysis": analysis}


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
