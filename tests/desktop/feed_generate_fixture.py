"""Run a disposable dashboard with deterministic Feed agent output.

This fixture is only for packaged UI proof. It never contacts a model or
accesses a user profile; pass an empty, test-owned ``--root`` directory.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def serve(root: Path, port: int, *, fail_start_once: bool = False,
          mixed_sources: bool = False, multi_story: bool = False) -> None:
    if root.exists() and any(root.iterdir()):
        raise ValueError("Fixture root must be empty")
    root.mkdir(parents=True, exist_ok=True)
    home = root / "hermes-home"
    home.mkdir()
    token = secrets.token_urlsafe(32)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    os.environ["HERMES_SERVE_HEADLESS"] = "1"

    from hermes_cli import feed_editions

    def synthetic_agent(prompt: str, _edition_id: str):
        if "fail once" in prompt.lower() and not (root / "failed-once").exists():
            (root / "failed-once").touch()
            raise RuntimeError("Synthetic provider interruption")
        if mixed_sources:
            retrieved = "https://example.test/retrieved"
            mentioned = "https://example.test/mentioned"
            return (f"Synthetic briefing for: {prompt}. Read {retrieved}; also mentioned {mentioned}.",
                    [retrieved])
        if multi_story:
            return ("Two independent synthetic stories.\n\n"
                    "## First synthetic story\nFirst story details for packaged UI proof.\n\n"
                    "## Second synthetic story\nSecond story details for packaged UI proof.", None)
        return f"Synthetic briefing for: {prompt}", None

    feed_editions._run_real_agent = synthetic_agent
    from hermes_cli.web_server import app
    import uvicorn

    if fail_start_once:
        from fastapi.responses import JSONResponse

        pending_failure = True

        @app.middleware("http")
        async def fail_one_feed_start(request, call_next):
            nonlocal pending_failure
            if (pending_failure and request.method == "POST"
                    and request.url.path == "/api/feed/editions"):
                pending_failure = False
                return JSONResponse(
                    {"detail": "Synthetic Feed start interruption"}, status_code=503,
                )
            return await call_next(request)

    print(json.dumps({"url": f"http://127.0.0.1:{port}", "session_token": token}), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--fail-start-once", action="store_true",
        help="Return one synthetic HTTP 503 from POST /api/feed/editions, then recover",
    )
    parser.add_argument(
        "--mixed-sources", action="store_true",
        help="Return a synthetic briefing with one retrieved and one mentioned-only URL",
    )
    parser.add_argument(
        "--multi-story", action="store_true",
        help="Return two explicit synthetic story sections for packaged Feed UI proof",
    )
    args = parser.parse_args()
    serve(args.root.resolve(strict=False), args.port,
          fail_start_once=args.fail_start_once, mixed_sources=args.mixed_sources,
          multi_story=args.multi_story)
