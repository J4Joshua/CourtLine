---
name: dev-setup
description: Bring up the full CourtLine dev environment — start all three servers in preview (the Meta Ray-Ban app server on :8000, the hackathon voice-agent server on :7860, and the React frontend on :3000), report the Mac's LAN IP, open a Cloudflare tunnel to the Ray-Ban server, and point the iOS app at the tunnel's public wss:// URL. Use when starting a dev/streaming session, especially before switching to a network with client isolation (e.g. corporate Wi-Fi) where the LAN IP won't reach the Mac.
---

# CourtLine dev setup

Brings up everything needed to develop and stream:

- **Meta Ray-Ban app server** (`server/`, port **8000**) — the stub the iOS
  glasses app streams to. Exposed through a **public Cloudflare tunnel** so it
  works on any network, including ones with client/AP isolation where a LAN IP
  fails.
- **Hackathon voice-agent server** (`yc-voice-agents-hackathon/server/`, port
  **7860**) — the Pipecat bot + vision/WebSocket routes.
- **React frontend** (`frontend/`, port **3000**) — talks to the hackathon
  server at `localhost:7860`.

Run the steps in order and report the outcome of each.

## Pre-flight: check for conflicting servers

**Do this first, before anything else.** The user develops across many parallel
worktrees, so ports 8000/7860/3000 are frequently already serving these same
apps from another checkout. `preview_start` will silently fail to bind a busy
port (it returns "started" but the server won't appear in `preview_list`), so
catch conflicts up front rather than mid-run.

Probe all three ports at once and identify each owner's working directory:

```bash
for p in 8000 7860 3000; do
  pid=$(lsof -ti :$p -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    cwd=$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $9}')
    echo ":$p held by pid $pid  cwd=$cwd"
  else
    echo ":$p free"
  fi
done
```

For each occupied port, compare its `cwd` to this worktree
(`/Users/joshua/CourtLine/.claude/worktrees/inspiring-driscoll-1338f5`):

- **Owned by this worktree's preview already** → reuse it, skip its start step.
- **Owned by another checkout/worktree** → ask the user in a **single batched
  question** covering all conflicts at once (don't ask one port at a time). The
  user's standing preference is **kill the foreign process and restart that
  server under this worktree's preview** — but still confirm, since another
  worktree may be a live session (the auto-mode classifier also blocks
  unverified kills). On approval: `kill <pid>`, confirm the port is free, then
  proceed with that server's start step below.

After every `preview_start`, confirm the server actually appears in
`preview_list` — not just that the call said "started".

## 0. Prerequisites (one-time per worktree)

Check each and bootstrap only what's missing — these are slow, so skip any that
already exist:

- **Ray-Ban server venv** — if `server/.venv` is absent:
  ```bash
  python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
  ```
- **Hackathon server env** — if `yc-voice-agents-hackathon/server/.env` is
  absent, copy the example (it ships with working keys). `uv run` builds the
  venv automatically on first launch, so no separate `uv sync` is needed:
  ```bash
  cp yc-voice-agents-hackathon/server/.env.example yc-voice-agents-hackathon/server/.env
  ```
- **Frontend deps** — if `frontend/node_modules` is absent:
  ```bash
  npm install --prefix frontend
  ```

## 1. Start the Meta Ray-Ban app server (port 8000)

Use the preview tool (`preview_start`) with config name **`courtline-server`**
(defined in `.claude/launch.json`). If port 8000 is held by a non-preview
process, run `lsof -i :8000 -sTCP:LISTEN -P -n` to identify it and ask the user
before killing it. After it starts, confirm with `curl -s http://localhost:8000/`
→ expect `{"ok":true,"service":"courtline-stub"}`.

Remember the returned `serverId` for log checks later (`preview_logs`).

## 2. Start the hackathon voice-agent server (port 7860)

`preview_start` with config name **`hackathon-server`** (`uv run main.py`, which
serves the Pipecat bot + vision routes on 7860). First launch takes ~20s while
`uv` syncs deps and Pipecat downloads VAD/turn-detection models — be patient and
check `preview_logs` if the health check isn't ready yet. Confirm liveness with
`curl -s http://localhost:7860/state` → expect a JSON object with
`case_brief`/`transcript`/`decisions` keys.

## 3. Start the React frontend (port 3000)

`preview_start` with config name **`courtline-frontend`** (`npm start`). The
config sets `BROWSER=none` so it won't hijack a browser and `PORT=3000`. Once
it's up, `preview_snapshot` to confirm the UI rendered, and check
`preview_console_logs` for errors — the app calls `localhost:7860`, so it needs
step 2 running to reach the backend.

## 4. Report the Mac's LAN IP (informational)

Run `ipconfig getifaddr en0` (and note any other `inet` addresses). This is the
address a same-Wi-Fi device would use directly. It's reported for reference only
— the tunnel below is what the iOS app will actually use, so it keeps working
after the user switches Wi-Fi.

## 5. Open the Cloudflare tunnel (Ray-Ban server only)

Only the Ray-Ban server (8000) needs a tunnel — the glasses reach the Mac across
networks through it. The frontend and hackathon server are consumed by a browser
on the same Mac (`localhost`), so they don't need tunneling.

Run the helper, which installs cloudflared if missing, starts a quick tunnel to
`localhost:8000`, and prints the public URL:

```bash
bash .claude/skills/dev-setup/start-tunnel.sh 8000
```

Capture the `https://<random>.trycloudflare.com` URL it prints on stdout. The
tunnel runs detached (logs at `/tmp/courtline-cloudflared.log`). **This URL is
ephemeral — it changes every run**, so steps 5–6 must be repeated each session.

**Verifying the tunnel:** don't poll with plain `curl https://<sub>.trycloudflare.com/`
— on this Mac the resolver caches IPv6-only records for the fresh host and
`curl` fails with "Could not resolve host" even when the tunnel is healthy. Trust
the cloudflared log instead (`Registered tunnel connection` + `Environment is
healthy`). If you must HTTP-test, pin the IP:
`curl --resolve <host>:443:$(dig +short <host> | head -1) https://<host>/`.

## 6. Point the iOS app at the tunnel

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

## 7. Tell the user what's next

- **Rebuild & re-run in Xcode** — `streamPublishHost` is a compile-time
  constant, so a fresh build is required to pick up the new URL.
- On first launch, grant **Local Network** if prompted (harmless over the
  tunnel, needed for glasses discovery).
- Open the frontend at **http://localhost:3000** in a browser.
- Then start streaming. Offer to tail `preview_logs` for the Ray-Ban server's
  serverId to confirm `[/publish] connected` and frame counts.

## Verify (optional)

With a stream running, confirm the Ray-Ban downlink legs:

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
- To stop a preview server, use `preview_stop` with its serverId.
