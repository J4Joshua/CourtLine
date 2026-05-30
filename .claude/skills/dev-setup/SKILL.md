---
name: dev-setup
description: Bring up the CourtLine dev environment — start the stub server in preview, report the Mac's LAN IP, open a Cloudflare tunnel, and point the iOS app at the tunnel's public wss:// URL. Use when starting a dev/streaming session, especially before switching to a network with client isolation (e.g. corporate Wi-Fi) where the LAN IP won't reach the Mac.
---

# CourtLine dev setup

Brings up everything needed to stream from the glasses to the local server,
and points the app at a **public Cloudflare tunnel** so it works on any
network — including ones with client/AP isolation where a LAN IP fails.

Run these steps in order and report the outcome of each.

## 1. Start the server in preview

Use the preview tool (`preview_start`) with config name **`courtline-server`**
(defined in `.claude/launch.json`). If port 8000 is already held by a non-preview
process, run `lsof -i :8000 -sTCP:LISTEN -P -n` to identify it and ask the user
before killing it. After it starts, confirm with `curl -s http://localhost:8000/`
→ expect `{"ok":true,"service":"courtline-stub"}`.

Remember the returned `serverId` for log checks later (`preview_logs`).

## 2. Report the Mac's LAN IP (informational)

Run `ipconfig getifaddr en0` (and note any other `inet` addresses). This is
the address a same-Wi-Fi device would use directly. It's reported for
reference only — the tunnel below is what the app will actually use, so it
keeps working after the user switches Wi-Fi.

## 3. Open the Cloudflare tunnel

Run the helper, which installs cloudflared if missing, starts a quick tunnel
to `localhost:8000`, and prints the public URL:

```bash
bash .claude/skills/dev-setup/start-tunnel.sh 8000
```

Capture the `https://<random>.trycloudflare.com` URL it prints on stdout. The
tunnel runs detached (logs at `/tmp/courtline-cloudflared.log`). **This URL is
ephemeral — it changes every run**, so steps 3–4 must be repeated each session.

## 4. Point the app at the tunnel

Convert the URL's scheme `https://` → `wss://` (keep the host, **no port** — the
tunnel terminates TLS on 443 and forwards to 8000). Then edit
`RayBan/ViewModels/StreamSessionViewModel.swift`: replace the current
`streamPublishHost` value with the `wss://...trycloudflare.com` URL.

The existing line looks like:

```swift
private let streamPublishHost = "ws://10.0.0.5:8000"   // value varies
```

Replace the whole string literal with e.g.
`"wss://brave-tiger-cloud.trycloudflare.com"`. ATS is satisfied automatically
(valid TLS cert), so no Info.plist change is needed.

## 5. Tell the user what's next

- **Rebuild & re-run in Xcode** — `streamPublishHost` is a compile-time
  constant, so a fresh build is required to pick up the new URL.
- On first launch, grant **Local Network** if prompted (harmless over the
  tunnel, needed for glasses discovery).
- Then start streaming. Offer to tail `preview_logs` for the serverId to
  confirm `[/publish] connected` and frame counts.

## Verify (optional)

With a stream running, confirm the downlink legs:

```bash
curl -X POST https://<sub>.trycloudflare.com/test/capture-photo   # JPEG -> server/photos/
curl -X POST https://<sub>.trycloudflare.com/test/beep            # tone via glasses speaker
```

(Or hit `http://localhost:8000/...` locally — same endpoints.)

## Notes

- The quick tunnel needs no Cloudflare account. For a **stable** hostname across
  runs you'd set up a named tunnel (requires a CF account + domain) — out of
  scope here.
- To stop the tunnel: `pkill -f "cloudflared tunnel --url"`.
