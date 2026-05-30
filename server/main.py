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
import struct
import time
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

app = FastAPI(title="CourtLine stub server")

PHOTOS_DIR = Path(__file__).parent / "photos"
PHOTOS_DIR.mkdir(exist_ok=True)


@app.get("/")
async def root():
    return {"ok": True, "service": "courtline-stub"}


# --- Video uplink -----------------------------------------------------------
# ws /publish : binary JPEG frames from the glasses, plus JSON control text
# frames in both directions (see PROTOCOL.md §1.1).
@app.websocket("/publish")
async def publish(ws: WebSocket):
    await ws.accept()
    frames = 0
    print("[/publish] connected")
    try:
        while True:
            msg = await ws.receive()
            if msg.get("bytes") is not None:
                frames += 1
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
            await ws.receive()
    except WebSocketDisconnect:
        print("[/agent-audio] disconnected")


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
