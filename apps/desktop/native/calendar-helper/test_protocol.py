"""Synthetic protocol checks. Deliberately never sends a valid EventKit command."""

import json
import os
from pathlib import Path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
SWIFTC = "/Library/Developer/CommandLineTools/usr/bin/swiftc"
SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"


def check(binary: Path, request: bytes, expected_code: str) -> None:
    result = subprocess.run([str(binary)], input=request, capture_output=True, timeout=10)
    assert result.returncode == 0, result.returncode
    assert result.stderr == b"", result.stderr
    assert result.stdout.endswith(b"\n")
    response = json.loads(result.stdout)
    assert response == {"ok": False, "code": expected_code}, response


def main() -> None:
    env = os.environ.copy()
    env["DEVELOPER_DIR"] = "/Library/Developer/CommandLineTools"
    with tempfile.TemporaryDirectory(prefix="jarvis-calendar-test-") as directory:
        binary = Path(directory) / "calendar-helper"
        subprocess.run(
            [SWIFTC, "-sdk", SDK, "-framework", "EventKit", str(HERE / "main.swift"), "-o", str(binary)],
            check=True,
            env=env,
            capture_output=True,
            timeout=60,
        )
        cases = [
            (b"{", "invalid_json"),
            (b"[]", "invalid_json"),
            (b"{" + b" " * 17000 + b"}", "input_too_large"),
            (b'{"command":"unknown"}', "invalid_command"),
            (b'{"command":"status","unexpected":true}', "invalid_input"),
            (b'{"command":"request-full-access","unexpected":true}', "invalid_input"),
            (b'{"command":"list-events","start":"2026-09-01T00:00:00Z","end":"2026-11-01T00:00:00Z"}', "invalid_range"),
            (b'{"command":"list-events","start":"bad","end":"2026-09-02T00:00:00Z"}', "invalid_date"),
            (b'{"command":"list-events","start":"2026-09-01T00:00:00Z","end":"2026-09-02T00:00:00Z","limit":true}', "invalid_input"),
            (b'{"command":"create-event","title":" ","start":"2026-09-01T00:00:00Z","end":"2026-09-02T00:00:00Z"}', "invalid_input"),
            (b'{"command":"create-event","title":"synthetic","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"}', "invalid_range"),
        ]
        for request, expected in cases:
            check(binary, request, expected)
    print(f"{len(cases)} synthetic protocol cases passed")


if __name__ == "__main__":
    main()
