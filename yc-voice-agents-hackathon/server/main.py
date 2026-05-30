"""CourtLine Glass — unified entry point.

Mounts vision/WebSocket routes onto Pipecat's module-level FastAPI app,
then calls Pipecat's own main(). Everything runs on one port (default 7860).
No subprocesses, no port conflicts.

The Pipecat runner docs explicitly support this pattern:

    from pipecat.runner.run import app, main
    @app.get("/my-route")
    async def my_route(): ...
    if __name__ == "__main__":
        main()

Usage:
    uv run main.py        — vision + bot on http://localhost:7860
    uv run bot-courtline.py  — same thing (bot-courtline.py also calls main)
"""

import importlib.util
import os
import sys

from dotenv import load_dotenv

load_dotenv(override=True)

# ── 1. Grab Pipecat's shared FastAPI app before any routes are registered ──
from pipecat.runner.run import app  # noqa: E402

# ── 2. Mount vision + WebSocket routes onto it ──────────────────────────────
from vision import router as vision_router  # noqa: E402

app.include_router(vision_router)

# ── 3. Load bot-courtline.py so Pipecat's _get_bot_module() finds `bot` ─────
#
# bot-courtline.py contains a hyphen, so normal `import` won't work.
# importlib loads it by file path and exposes its `bot` coroutine here.
# Pipecat's runner checks sys.modules["__main__"] for a `bot` attribute first,
# so importing it into this module's namespace is all that's needed.
_server_dir = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "bot_courtline",
    os.path.join(_server_dir, "bot-courtline.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

bot = _mod.bot  # exposed in __main__ namespace — Pipecat's runner will find it

# ── 4. Start the server ──────────────────────────────────────────────────────
if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
