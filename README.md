# CourtLine

A clean template for streaming **audio + video + photos from Meta Ray-Ban
Display glasses** to a server you control, over plain WebSockets + HTTP.

It's the iOS publisher app extracted from a working lab project, with all
lab-specific pieces (a Gemini/SOP analysis server) stripped out. What remains
is generic glasses-streaming plumbing plus a minimal stub server you replace
with your own — e.g. a voice agent.

## What's here

```
RayBan/              iOS app (Swift, SwiftUI, Meta DAT SDK)
RayBan.xcodeproj/    Xcode project
RayBanTests/         unit test target
RayBanUITests/       UI test target
server/              minimal Python stub server (FastAPI)
PROTOCOL.md          the wire contract between app and server
```

> The Xcode target is still named `RayBan` internally (renaming an Xcode
> target is fiddly and easy to break). The app's **display name** is
> `CourtLine`. Rename the target later if you want full consistency.

## The contract

The app and server speak a small, transport-stable contract. Any server you
build must honor it. See **[PROTOCOL.md](PROTOCOL.md)** — the short version:

| Channel | What |
|---------|------|
| `ws /publish` | binary JPEG video frames + JSON control messages |
| `ws /publish-audio?agent=1` | JSON header, then Float32 LE mono PCM |
| `ws /agent-audio` | server -> app: JSON header, then Int16 LE 24kHz PCM (voice agent reply) |
| `POST /publish/photo` | full-res JPEG, echoes `X-Request-Id` |

## Run it

### 1. Server (stub)

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

It logs every frame/chunk/photo it receives. The voice-agent loop
(`/publish-audio` -> `/agent-audio`) is a marked `TODO` — wire in your model.

### 2. iOS app

1. Open `RayBan.xcodeproj` in Xcode.
2. Set your signing team (target **RayBan** -> Signing & Capabilities). The
   bundle ID placeholder is `com.example.CourtLine` — change it to yours.
3. Point the app at your server: edit `streamPublishHost` at the top of
   [`RayBan/ViewModels/StreamSessionViewModel.swift`](RayBan/ViewModels/StreamSessionViewModel.swift).
   - **Simulator:** `ws://localhost:8000` (the default).
   - **Real device:** your Mac's LAN IP, e.g. `ws://192.168.1.42:8000`, or a
     tunnel URL.
4. Build & run. Without glasses, use the Debug menu's MockDeviceKit
   (`#if DEBUG`) to feed a fake camera.

## Dependencies

- **Meta Wearables DAT SDK** — resolved automatically via Swift Package
  Manager from `github.com/facebook/meta-wearables-dat-ios`. No manual setup.
- To use real glasses you must register the app with Meta AI (client token /
  Meta app ID, surfaced as `$(CLIENT_TOKEN)` / `$(META_APP_ID)` build settings,
  and the `rayban://` URL scheme). See Meta's DAT onboarding docs.

## Notes

- `NSAllowsLocalNetworking` is enabled so plain `ws://`/`http://` to localhost
  and private LAN IPs works for dev. For a public server, switch to
  `wss://`/`https://`.
- This app derives from Meta's DAT sample app; source headers retain Meta's
  copyright.
