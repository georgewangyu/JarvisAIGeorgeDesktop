"""Disposable real-serve fixture for checking saved Feed editions in Desktop.

Run ``start --root <unique empty temp directory>``. The command owns its
loopback server child until interrupted; never point it at a user profile.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

from library_remote_fixture import REPO_ROOT, choose_loopback_port, stop_child

MARKER = ".jarvis-feed-history-fixture"


def create_fixture(root: Path) -> dict:
    if root.exists() and any(root.iterdir()):
        raise ValueError(f"Refusing to modify a nonempty directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    home = root / "hermes-home"
    home.mkdir()

    from cron.jobs import create_job, use_cron_store
    from hermes_state import SessionDB

    with use_cron_store(home):
        job = create_job(
            prompt="Synthetic saved Feed proof",
            schedule="every 1h",
            name="Synthetic briefing",
            paused=True,
        )

    db = SessionDB(home / "state.db")
    try:
        for suffix, answer in (("earlier", "Earlier saved briefing."), ("latest", None)):
            session_id = f"cron_{job['id']}_{suffix}"
            db.create_session(session_id, "cron", profile_name="default")
            if answer:
                db.append_message(session_id, "assistant", answer)
            db.end_session(session_id, "completed")
            time.sleep(0.02)
    finally:
        db.close()

    data = {
        "kind": "jarvis-feed-history-fixture-v1",
        "job_id": job["id"],
        "session_token": secrets.token_urlsafe(32),
    }
    marker = root / MARKER
    marker.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    marker.chmod(0o600)
    return data


def run_server(root: Path) -> None:
    data = create_fixture(root)
    home = root / "hermes-home"
    port = choose_loopback_port()
    url = f"http://127.0.0.1:{port}"
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(root),
        "HERMES_HOME": str(home),
        "HERMES_DASHBOARD_SESSION_TOKEN": data["session_token"],
        "HERMES_SERVE_HEADLESS": "1",
        "PYTHONPATH": str(REPO_ROOT),
    })
    child = subprocess.Popen(
        [sys.executable, "-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and child.poll() is None:
            try:
                request = Request(f"{url}/api/cron/jobs?profile=default", headers={"X-Hermes-Session-Token": data["session_token"]})
                with urlopen(request, timeout=2) as response:
                    jobs = json.load(response)
                if any(job.get("id") == data["job_id"] for job in jobs):
                    print(json.dumps({"url": url, "profile": "default", **data}), flush=True)
                    while child.poll() is None:
                        time.sleep(0.2)
                    raise RuntimeError(f"hermes serve exited ({child.returncode})")
            except (OSError, TimeoutError):
                time.sleep(0.2)
        raise RuntimeError("Fixture backend failed to serve its saved automation")
    finally:
        stop_child(child)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start",))
    parser.add_argument("--root", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        run_server(arguments.root.resolve(strict=False))
    except KeyboardInterrupt:
        pass
