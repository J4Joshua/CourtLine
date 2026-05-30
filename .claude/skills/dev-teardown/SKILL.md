---
name: dev-teardown
description: Tear down the CourtLine dev environment brought up by dev-setup — stop the preview servers (Ray-Ban :8000, hackathon voice-agent :7860, React frontend :3000) and kill the Cloudflare quick tunnel. Use when ending a dev/streaming session, freeing ports, or before switching worktrees. The inverse of the dev-setup skill.
---

# CourtLine dev teardown

The inverse of `dev-setup`. Stops the three preview-managed servers and the
Cloudflare quick tunnel, then confirms the ports are free. Run the steps in
order and report what was actually stopped.

**Scope:** only tears down what *this* worktree/session started. If a port is
held by a process from another checkout (common — the user runs many parallel
worktrees), **leave it alone** unless the user explicitly asks to free that
port. Don't kill another worktree's live session.

## 1. Stop the preview servers

List the running preview servers and stop each one belonging to this worktree by
its `serverId`:

- Call `preview_list` to get the running servers and their `serverId`s.
- For each whose `name` is `courtline-server`, `hackathon-server`, or
  `courtline-frontend` **and** whose `cwd` is this worktree, call `preview_stop`
  with its `serverId`.
- Report each one stopped. If `preview_list` is empty, the servers were started
  outside preview (e.g. another worktree) — see step 3.

## 2. Kill the Cloudflare tunnel

The quick tunnel runs detached, so it survives until killed explicitly:

```bash
pkill -f "cloudflared tunnel --url" && echo "tunnel stopped" || echo "no tunnel running"
```

(The log at `/tmp/courtline-cloudflared.log` can stay; it's truncated on the
next `dev-setup` run.)

## 3. Confirm the ports are free

Verify nothing this worktree owns is still listening:

```bash
for p in 8000 7860 3000; do
  pid=$(lsof -ti :$p -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    cwd=$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $9}')
    echo ":$p STILL HELD by pid $pid  cwd=$cwd"
  else
    echo ":$p free"
  fi
done
```

- All free → teardown complete.
- A port still held by **this worktree** (preview_stop didn't fully release it,
  or it was started via Bash) → `kill <pid>` to free it.
- A port held by **another worktree/checkout** → leave it and report it as
  belonging to another session, unless the user asked to free that specific
  port.

## Notes

- This does **not** revert the iOS app's `streamPublishHost` in
  `RayBan/ViewModels/StreamSessionViewModel.swift`. That's a tracked source
  edit — leave it for the user to commit or revert via git. Mention it so they
  know the tunnel URL is now stale in that file.
- To bring everything back up, run the `dev-setup` skill (the tunnel URL is
  ephemeral, so it'll be a fresh `wss://...trycloudflare.com` each time).
