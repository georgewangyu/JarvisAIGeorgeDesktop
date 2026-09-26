"""Pure contract for a user-approved, per-profile Jarvis wake LaunchAgent.

This module only renders and validates plist data. It never writes a plist,
registers a job, creates a queue, or starts a process. The executable and
source tree must be stable across app updates before anyone installs it.
"""

from __future__ import annotations

import hashlib
import plistlib
import re
from pathlib import Path
from typing import Any

_PROFILE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
_PYTHON_EXECUTABLE = re.compile(r"python(?:3(?:\.\d+)?)?\Z")
_WAKE_QUEUE = "jarvis_event_wake"
_LABEL_PREFIX = "ai.hermes.jarvis-wake"


def _absolute_path(value: Path | str, name: str) -> Path:
    raw = str(value)
    if (not raw or "\x00" in raw or "\n" in raw or "\r" in raw
            or not Path(raw).is_absolute() or any(part in {".", ".."} for part in raw.split("/"))):
        raise ValueError(f"{name} must be a clean absolute path")
    return Path(raw)


def _inputs(
    profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
) -> tuple[Path, Path, Path]:
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile):
        raise ValueError("profile must be a canonical lowercase profile id")
    home = _absolute_path(profile_home, "profile_home")
    python = _absolute_path(python_executable, "python_executable")
    script = _absolute_path(entrypoint, "entrypoint")
    if home == Path("/"):
        raise ValueError("profile_home must not be the filesystem root")
    if not _PYTHON_EXECUTABLE.fullmatch(python.name):
        raise ValueError("python_executable must name a Python interpreter")
    if script.name != "headless_owner_event.py" or script.parent.name != "tui_gateway":
        raise ValueError("entrypoint must be tui_gateway/headless_owner_event.py")
    if python == script or home == script:
        raise ValueError("executable, entrypoint, and profile home must be distinct")
    return home, python, script


def launch_agent_label(profile: str, profile_home: Path | str) -> str:
    """Derive a safe label from both the profile id and its exact home."""
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile):
        raise ValueError("profile must be a canonical lowercase profile id")
    home = _absolute_path(profile_home, "profile_home")
    if home == Path("/"):
        raise ValueError("profile_home must not be the filesystem root")
    suffix = hashlib.sha256(str(home).encode("utf-8")).hexdigest()[:16]
    return f"{_LABEL_PREFIX}.{profile}.{suffix}"


def launch_agent_plist(
    profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
) -> dict[str, Any]:
    """Build one on-demand job with no implicit shell or periodic trigger."""
    home, python, script = _inputs(profile, profile_home, python_executable, entrypoint)
    root = script.parent.parent
    return {
        "Label": launch_agent_label(profile, home),
        "ProgramArguments": [
            str(python), str(script), "--scan-wake-queue", "--allow-headless",
            "--profile", profile, "--expected-profile-home", str(home),
        ],
        "WorkingDirectory": str(root),
        "EnvironmentVariables": {"PYTHONPATH": str(root)},
        "QueueDirectories": [str(home / "runtime" / _WAKE_QUEUE)],
    }


def render_launch_agent_plist(
    profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
) -> bytes:
    """Return XML plist bytes without touching the filesystem or launchd."""
    return plistlib.dumps(
        launch_agent_plist(profile, profile_home, python_executable, entrypoint),
        fmt=plistlib.FMT_XML, sort_keys=True,
    )


def validate_launch_agent_plist(
    plist: bytes, *, profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
) -> None:
    """Refuse any changed trigger, argument, path, label, or environment key."""
    expected = launch_agent_plist(profile, profile_home, python_executable, entrypoint)
    try:
        actual = plistlib.loads(plist)
    except (TypeError, ValueError, plistlib.InvalidFileException) as exc:
        raise ValueError("invalid LaunchAgent plist") from exc
    if actual != expected:
        raise ValueError("LaunchAgent plist differs from the exact one-shot wake contract")
