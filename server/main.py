"""
CourtLine — minimal stub server.

Speaks the exact contract the iOS app expects (see ../PROTOCOL.md §1). It
accepts the video + audio + photo streams and logs what arrives. The voice
agent is left as a clearly marked TODO: wire your own model into the
`/publish-audio` -> `/agent-audio` loop.

Run:
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import math
import struct
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

app = FastAPI(title="CourtLine stub server")

PHOTOS_DIR = Path(__file__).parent / "photos"
PHOTOS_DIR.mkdir(exist_ok=True)

# Live sockets, so the /test/* trigger endpoints below can push control
# messages and audio to whatever glasses are currently connected. These let
# you exercise the *server -> app* half of the contract by hand during an
# end-to-end test (curl from another terminal).
PUBLISH_SOCKETS: set[WebSocket] = set()
AGENT_AUDIO_SOCKETS: set[WebSocket] = set()

# Browser viewers (e.g. the React frontend's "Ray-Ban Glasses" camera source).
# Each binary JPEG frame the glasses publish on /publish is fanned out to these
# sockets, so the web UI can render the live glasses feed. LATEST_FRAME lets a
# newly-connected viewer paint something immediately instead of waiting for the
# next frame.
VIEWER_SOCKETS: set[WebSocket] = set()
LATEST_FRAME: bytes | None = None


@app.get("/")
async def root():
    return {"ok": True, "service": "courtline-stub"}


# --- Test triggers (server -> app) ------------------------------------------
# These are NOT part of the protocol the app speaks; they're dev conveniences
# that fan out a control message / audio to connected glasses so you can verify
# the downlink legs e2e. Hit them with curl while the app is streaming.
@app.post("/test/capture-photo")
async def test_capture_photo():
    """Ask the glasses to take a full-res still (PROTOCOL §1.1 / §1.4)."""
    request_id = uuid.uuid4().hex[:8]
    msg = json.dumps({"type": "capture_photo", "request_id": request_id})
    sent = await _broadcast_text(PUBLISH_SOCKETS, msg)
    print(f"[/test/capture-photo] sent to {sent} socket(s), request_id={request_id}")
    return {"ok": True, "request_id": request_id, "sockets": sent}


@app.post("/test/video/{state}")
async def test_video(state: str):
    """Toggle the glasses video stream: state = 'on' or 'off' (PROTOCOL §1.1)."""
    if state not in ("on", "off"):
        return JSONResponse({"ok": False, "error": "state must be 'on' or 'off'"}, status_code=400)
    msg = json.dumps({"type": f"video_{state}"})
    sent = await _broadcast_text(PUBLISH_SOCKETS, msg)
    print(f"[/test/video/{state}] sent to {sent} socket(s)")
    return {"ok": True, "state": state, "sockets": sent}


@app.post("/test/beep")
async def test_beep(seconds: float = 1.0, freq: float = 440.0):
    """Play a sine beep through the glasses speaker via /agent-audio downlink.

    Int16 LE mono PCM @ 24kHz (PROTOCOL §1.3). Proves you can hear the agent.
    """
    sample_rate = 24000
    n = int(sample_rate * seconds)
    amp = 12000  # well under the Int16 ceiling (32767)
    samples = [
        int(amp * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(n)
    ]
    pcm = struct.pack("<%dh" % len(samples), *samples)
    sent = await _broadcast_bytes(AGENT_AUDIO_SOCKETS, pcm)
    print(f"[/test/beep] {seconds}s @ {freq}Hz -> {sent} socket(s) ({len(pcm)} bytes)")
    return {"ok": True, "sockets": sent, "bytes": len(pcm)}


async def _broadcast_text(sockets: set[WebSocket], text: str) -> int:
    sent = 0
    for ws in list(sockets):
        try:
            await ws.send_text(text)
            sent += 1
        except Exception:
            sockets.discard(ws)
    return sent


async def _broadcast_bytes(sockets: set[WebSocket], data: bytes) -> int:
    sent = 0
    for ws in list(sockets):
        try:
            await ws.send_bytes(data)
            sent += 1
        except Exception:
            sockets.discard(ws)
    return sent


# --- Video uplink -----------------------------------------------------------
# ws /publish : binary JPEG frames from the glasses, plus JSON control text
# frames in both directions (see PROTOCOL.md §1.1).
@app.websocket("/publish")
async def publish(ws: WebSocket):
    await ws.accept()
    PUBLISH_SOCKETS.add(ws)
    frames = 0
    print("[/publish] connected")
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))
            if msg.get("bytes") is not None:
                frames += 1
                # Relay the JPEG to any browser viewers and remember the latest.
                global LATEST_FRAME
                LATEST_FRAME = msg["bytes"]
                await _broadcast_bytes(VIEWER_SOCKETS, msg["bytes"])
                if frames % 24 == 0:  # ~once per second at 24fps
                    print(f"[/publish] {frames} video frames "
                          f"(last {len(msg['bytes'])} bytes)")
            elif msg.get("text") is not None:
                ctrl = json.loads(msg["text"])
                print(f"[/publish] control from app: {ctrl}")
                # The app honors these server -> app controls:
                #   {"type":"video_on"} / {"type":"video_off"}
                #   {"type":"capture_photo","request_id":"..."}
                # Send them with: await ws.send_text(json.dumps({...}))
    except WebSocketDisconnect:
        print(f"[/publish] disconnected after {frames} frames")
    finally:
        PUBLISH_SOCKETS.discard(ws)


# --- Video viewer (server -> browser) ---------------------------------------
# ws /viewer : fan-out of the glasses' JPEG frames to browser clients. NOT part
# of the app<->server protocol — it's how the web UI renders the live glasses
# feed (the "Ray-Ban Glasses" camera source). On connect we ask any connected
# glasses to (re)enable video so the viewer isn't blank, and prime with the most
# recent frame.
@app.websocket("/viewer")
async def viewer(ws: WebSocket):
    await ws.accept()
    VIEWER_SOCKETS.add(ws)
    print(f"[/viewer] browser connected ({len(VIEWER_SOCKETS)} viewer(s))")
    await _broadcast_text(PUBLISH_SOCKETS, json.dumps({"type": "video_on"}))
    if LATEST_FRAME is not None:
        try:
            await ws.send_bytes(LATEST_FRAME)
        except Exception:
            VIEWER_SOCKETS.discard(ws)
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))
    except WebSocketDisconnect:
        print("[/viewer] browser disconnected")
    finally:
        VIEWER_SOCKETS.discard(ws)


# --- Audio uplink -----------------------------------------------------------
# ws /publish-audio?agent=1 : first a JSON header {"sampleRate":N,"channels":1},
# then raw Float32 LE mono PCM binary frames (see PROTOCOL.md §1.2).
@app.websocket("/publish-audio")
async def publish_audio(ws: WebSocket):
    await ws.accept()
    agent = ws.query_params.get("agent") == "1"
    header = None
    chunks = 0
    print(f"[/publish-audio] connected (agent={agent})")
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))
            if msg.get("text") is not None and header is None:
                header = json.loads(msg["text"])
                print(f"[/publish-audio] header: {header}")
            elif msg.get("bytes") is not None:
                chunks += 1
                # TODO: feed these Float32 PCM samples into your voice agent.
                # The agent's reply audio goes back out over /agent-audio.
                if chunks % 50 == 0:
                    print(f"[/publish-audio] {chunks} audio chunks")
    except WebSocketDisconnect:
        print(f"[/publish-audio] disconnected after {chunks} chunks")


# --- Audio downlink ---------------------------------------------------------
# ws /agent-audio : server -> app. Send a JSON header {"sampleRate":24000},
# then Int16 LE mono PCM @ 24kHz binary frames (see PROTOCOL.md §1.3).
@app.websocket("/agent-audio")
async def agent_audio(ws: WebSocket):
    await ws.accept()
    AGENT_AUDIO_SOCKETS.add(ws)
    print("[/agent-audio] connected")
    # Announce the format the app should expect.
    await ws.send_text(json.dumps({"sampleRate": 24000}))
    try:
        # TODO: stream your voice agent's output here. Example of how a frame
        # would be sent (silence shown — replace with real agent PCM):
        #   pcm = struct.pack("<%dh" % len(samples), *samples)
        #   await ws.send_bytes(pcm)
        while True:
            # Keep the socket open; nothing to push in the stub.
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))
    except WebSocketDisconnect:
        print("[/agent-audio] disconnected")
    finally:
        AGENT_AUDIO_SOCKETS.discard(ws)


# --- Photo ------------------------------------------------------------------
# POST /publish/photo : full-res JPEG body, echoes X-Request-Id (PROTOCOL §1.4).
@app.post("/publish/photo")
async def publish_photo(request: Request):
    request_id = request.headers.get("X-Request-Id", "unknown")
    body = await request.body()
    ts = int(time.time() * 1000)
    out = PHOTOS_DIR / f"photo_{ts}_{request_id}.jpg"
    out.write_bytes(body)
    print(f"[/publish/photo] saved {len(body)} bytes -> {out.name} "
          f"(request_id={request_id})")
    return JSONResponse({"ok": True, "request_id": request_id, "bytes": len(body)})
