"""The Library rehearsal fixture must serve one scoped artifact and recover."""

from __future__ import annotations

import json
import select
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import library_remote_fixture as fixture


def _fixture_details(process: subprocess.Popen, timeout: float = 40) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"Fixture exited before readiness ({process.returncode})")
        ready, _, _ = select.select([process.stdout], [], [], min(1, deadline - time.monotonic()))
        if not ready:
            continue
        line = process.stdout.readline()
        if line.startswith('{"url":'):
            return json.loads(line)
    raise AssertionError("Fixture did not report a ready URL")


def _download(details: dict) -> tuple[int, bytes]:
    query = urlencode({
        "path": details["artifact_path"],
        "session_id": details["session_id"],
        "profile": details["profile"],
    })
    request = Request(
        f"{details['url']}/api/fs/download?{query}",
        headers={"X-Hermes-Session-Token": details["session_token"]},
    )
    try:
        with urlopen(request, timeout=3) as response:
            return response.status, response.read()
    except HTTPError as exc:
        return exc.code, exc.read()


def _get_json(details: dict, route: str) -> dict:
    request = Request(
        f"{details['url']}{route}",
        headers={"X-Hermes-Session-Token": details["session_token"]},
    )
    with urlopen(request, timeout=3) as response:
        assert response.status == 200
        return json.load(response)


def test_real_serve_scoped_library_download_recovers_after_source_returns(tmp_path: Path) -> None:
    root = tmp_path / "library-rehearsal"
    script = Path(fixture.__file__).resolve()
    process = subprocess.Popen(
        [sys.executable, str(script), "start", "--root", str(root)],
        cwd=fixture.REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    details = None
    try:
        details = _fixture_details(process)
        listed = _get_json(details, "/api/sessions?profile=default")
        assert any(row["id"] == details["session_id"] for row in listed["sessions"])
        messages = _get_json(details, f"/api/sessions/{details['session_id']}/messages?profile=default")
        assert any(details["artifact_path"] in row.get("content", "") for row in messages["messages"])
        assert _download(details) == (200, b"# Remote Library proof\n\nSynthetic fixture file.\n")

        fixture.set_withheld(root, withheld=True)
        assert _download(details)[0] == 404

        fixture.set_withheld(root, withheld=False)
        assert _download(details)[0] == 200
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)

    assert process.returncode == 0
    assert details is not None
    # The fixture owns its child. Closing it must also close the exact port,
    # without using the global `hermes serve --stop` command.
    for _ in range(20):
        try:
            _download(details)
        except (URLError, OSError):
            break
        time.sleep(0.1)
    else:
        raise AssertionError("Fixture left its Hermes serve listener running")
