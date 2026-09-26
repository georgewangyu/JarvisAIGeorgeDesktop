"""Exercise the optional one-shot HTTP failure of the disposable Feed fixture."""

from __future__ import annotations

import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from library_remote_fixture import REPO_ROOT, choose_loopback_port, stop_child


def test_feed_start_fails_once_then_recovers(tmp_path):
    root = tmp_path / "feed-fixture"
    port = choose_loopback_port()
    env = os.environ.copy()
    env["HOME"] = str(tmp_path)
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name("feed_generate_fixture.py")),
         "--root", str(root), "--port", str(port), "--fail-start-once"],
        cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        deadline = time.monotonic() + 30
        while not select.select([child.stdout], [], [], 0.2)[0]:
            assert child.poll() is None, "Feed fixture exited before reporting its URL"
            assert time.monotonic() < deadline, "Feed fixture did not report its URL"
        fixture = json.loads(child.stdout.readline())
        url = fixture["url"]
        headers = {"X-Hermes-Session-Token": fixture["session_token"]}

        while True:
            try:
                with urlopen(Request(f"{url}/api/feed/editions", headers=headers), timeout=2):
                    break
            except (URLError, TimeoutError):
                assert child.poll() is None, "Feed fixture exited before serving"
                assert time.monotonic() < deadline, "Feed fixture did not start serving"
                time.sleep(0.2)

        def start_edition():
            return urlopen(
                Request(
                    f"{url}/api/feed/editions", method="POST",
                    headers={**headers, "Content-Type": "application/json"},
                    data=json.dumps({"prompt": "Synthetic briefing"}).encode(),
                ),
                timeout=5,
            )

        try:
            start_edition()
        except HTTPError as error:
            assert error.code == 503
            assert json.load(error)["detail"] == "Synthetic Feed start interruption"
        else:
            raise AssertionError("First Feed start did not fail")

        with start_edition() as response:
            assert response.status == 202
            assert json.load(response)["edition"]["id"]
    finally:
        stop_child(child)
        if child.stdout is not None:
            child.stdout.close()
        if child.stderr is not None:
            child.stderr.close()
