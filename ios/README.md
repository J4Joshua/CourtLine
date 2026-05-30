# CourtLine Glass — iOS app + WebRTC audio integration

iOS app that streams from **Meta Ray-Ban Display glasses** and connects to the
CourtLine agent (`../yc-voice-agents-hackathon/server`) over **WebRTC**.

## The audio architecture (why it's shaped this way)

We tried to send the **glasses microphone** to the agent over WebRTC and hit a
hard iOS limitation: WebRTC's iOS audio module couldn't reliably capture the
Bluetooth-HFP glasses mic while the DAT camera stream was live (it negotiates
and routes to HFP, but no mic samples reach the server). WebRTC on iOS also
offers no supported way to inject externally-captured PCM into an audio track.

So the working split is:

```
  Human speaks
      │
      ▼
  MacBook mic ─► agent (bot-courtline.py, MAC_MIC_INPUT=1)
                   │  NVidia STT → vLLM → Gradium TTS
                   ▼
             SmallWebRTCTransport.output()
                   │  WebRTC (SRTP, peer-to-peer)
                   ▼
             iOS app (receive-only, enableMic = false)
                   │  Bluetooth HFP
                   ▼
             🕶️  Glasses speaker  ← agent's voice
```

- **Agent listens via the Mac mic** (`MAC_MIC_INPUT=1`) — see the server change
  in `bot-courtline.py`.
- **Agent speaks through the glasses** — the iOS app connects **receive-only**
  (`WebRTCAudioSpike.swift`, `enableMic = false`) and plays the agent's audio
  out through the glasses' HFP speaker. This leg is verified working.

## Setup

**Agent (server):**
```bash
cd ../yc-voice-agents-hackathon/server
uv sync                       # picks up the new sounddevice dep
export MAC_MIC_INPUT=1        # capture this Mac's mic into the pipeline
uv run main.py                # agent on http://0.0.0.0:7860 (serves /api/offer)
# macOS will prompt for microphone access for the terminal — allow it.
```

**iOS app:**
1. Open `RayBan.xcodeproj`, set your signing team.
2. Set `webRTCServerURL` in `RayBan/ViewModels/WebRTCAudioSpike.swift` to the
   Mac's LAN IP + port, e.g. `http://192.168.1.42:7860`.
3. Build & run on a real device with the glasses paired (same Wi-Fi/LAN — see
   the network note below). Start a stream, tap the **waveform** button.

## What's verified vs. pending

- ✅ iOS app compiles against the real SDKs (PipecatClientIOS / SmallWebRTC /
  WebRTC) and connects to a SmallWebRTC `/api/offer`; the agent's audio plays
  through the glasses (downlink proven end-to-end).
- ✅ Mac-mic capture (`sounddevice`) streams audio into a Pipecat pipeline
  (verified standalone; wired here behind `MAC_MIC_INPUT`).
- ⏳ The full Mac-mic → STT → LLM → TTS → glasses loop needs an on-stack run with
  the agent's API keys (Gradium / NVIDIA / OpenAI) — not runnable in CI.
- ⏳ Glasses **video → agent vision** (`vision.py` / `check_camera`) is not wired
  yet; the legacy WebSocket video path (`streamPublishHost`) is a placeholder.

## Network note

Peer-to-peer WebRTC needs a routable media path. On the same Wi-Fi/LAN this
works via host ICE candidates. It will **not** traverse a Cloudflare HTTP tunnel
(HTTP only, not the UDP media). For client-isolation networks (e.g. some phone
hotspots) you need a TURN server.

> The Xcode target is named `RayBan` internally; the display name is CourtLine.
> Derived from Meta's DAT sample app — source headers retain Meta's copyright.
