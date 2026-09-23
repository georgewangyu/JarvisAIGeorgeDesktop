"""Disposable real-serve fixture for Desktop Library remote-file recovery.

Manual use (from the repository root, with the project's Python environment)::

    python tests/desktop/library_remote_fixture.py start --root /tmp/jarvis-library-fixture-<unique>
    python tests/desktop/library_remote_fixture.py withhold --root /tmp/jarvis-library-fixture-<unique>
    python tests/desktop/library_remote_fixture.py restore --root /tmp/jarvis-library-fixture-<unique>

``start`` stays in the foreground and owns only its own ``hermes serve`` child.
Stop it with Ctrl-C before removing the exact disposable root. The emitted URL
is loopback-only; the artifact, session, and Hermes home are entirely synthetic.
The source file is withheld by a reversible rename, never deleted.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
MARKER = ".jarvis-library-remote-fixture"
ARTIFACT_NAME = "remote-proof.md"


def fixture_paths(root: Path) -> tuple[Path, Path, Path]:
    return root / MARKER, root / "hermes-home", root / "output" / ARTIFACT_NAME


def require_fixture(root: Path) -> dict:
    marker, _home, _artifact = fixture_paths(root)
    if root.is_symlink() or not marker.is_file():
        raise ValueError(f"Not a fixture-owned directory: {root}")
    data = json.loads(marker.read_text(encoding="utf-8"))
    if data.get("kind") != "jarvis-library-remote-fixture-v1":
        raise ValueError(f"Unexpected fixture marker: {marker}")
    return data


def create_fixture(root: Path) -> dict:
    if root.exists() and any(root.iterdir()):
        raise ValueError(f"Refusing to modify a nonempty directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    marker, home, artifact = fixture_paths(root)
    home.mkdir()
    artifact.parent.mkdir()
    artifact.write_text("# Remote Library proof\n\nSynthetic fixture file.\n", encoding="utf-8")

    # The server is an independent process, so seed its actual state DB instead
    # of mocking session APIs or writing to a real user's Hermes home.
    from hermes_state import SessionDB

    session_id = f"library-fixture-{uuid.uuid4().hex}"
    db = SessionDB(home / "state.db")
    try:
        db.create_session(session_id, "desktop", cwd=str(artifact.parent), profile_name="default")
        db.set_session_title(session_id, "Remote Library proof")
        db.append_message(session_id, "assistant", f"Created [{ARTIFACT_NAME}]({artifact}).")
    finally:
        db.close()

    data = {
        "kind": "jarvis-library-remote-fixture-v1",
        "session_id": session_id,
        "artifact_path": str(artifact),
        "session_token": secrets.token_urlsafe(32),
    }
    marker.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    marker.chmod(0o600)
    return data


def choose_loopback_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def download_status(url: str, data: dict) -> int:
    query = urlencode({"path": data["artifact_path"], "session_id": data["session_id"], "profile": "default"})
    try:
        request = Request(
            f"{url}/api/fs/download?{query}",
            headers={"X-Hermes-Session-Token": data["session_token"]},
        )
        with urlopen(request, timeout=2) as response:
            response.read()
            return response.status
    except HTTPError as exc:
        return exc.code


def wait_for_server(url: str, data: dict, child: subprocess.Popen, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f"hermes serve exited early ({child.returncode})")
        try:
            status = download_status(url, data)
        except (URLError, TimeoutError, OSError):
            time.sleep(0.2)
            continue
        if status != 200:
            raise RuntimeError(f"fixture download probe returned HTTP {status}, expected 200")
        return
    raise TimeoutError(f"hermes serve did not respond at {url} within {timeout}s")


def stop_child(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)


def run_server(root: Path) -> None:
    data = create_fixture(root)
    _marker, home, _artifact = fixture_paths(root)
    port = choose_loopback_port()
    url = f"http://127.0.0.1:{port}"
    # Never give the fixture server a developer's provider credentials, profile
    # selection, or normal home directory by inheriting the whole environment.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(root),
        "HERMES_HOME": str(home),
        "HERMES_DASHBOARD_SESSION_TOKEN": data["session_token"],
        "HERMES_SERVE_HEADLESS": "1",
        "PYTHONPATH": str(REPO_ROOT),
    })
    # Explicit child handle prevents a broad `hermes serve --stop` from ever
    # touching other local backends. No shell and no daemonization.
    child = subprocess.Popen(
        [sys.executable, "-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    try:
        wait_for_server(url, data, child)
        print(json.dumps({"url": url, "profile": "default", **data}), flush=True)
        print("Withhold/restore from another terminal; Ctrl-C stops only this server child.", flush=True)
        while child.poll() is None:
            time.sleep(0.2)
        raise RuntimeError(f"hermes serve exited ({child.returncode})")
    finally:
        stop_child(child)


def set_withheld(root: Path, withheld: bool) -> None:
    require_fixture(root)
    _marker, _home, artifact = fixture_paths(root)
    held = artifact.with_name(f"{artifact.name}.withheld")
    source, target = (artifact, held) if withheld else (held, artifact)
    if target.exists() or not source.is_file():
        raise ValueError(f"Cannot move fixture file: {source} -> {target}")
    source.rename(target)
    print(f"{'Withheld' if withheld else 'Restored'} {ARTIFACT_NAME}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "withhold", "restore", "status"))
    parser.add_argument("--root", type=Path, required=True, help="Unique disposable fixture root")
    args = parser.parse_args()
    root = args.root.resolve(strict=False)
    if args.command == "start":
        run_server(root)
    elif args.command == "status":
        print(json.dumps(require_fixture(root), indent=2))
    else:
        set_withheld(root, withheld=args.command == "withhold")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
