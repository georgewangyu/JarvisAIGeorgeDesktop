"""Pure contract for a user-approved, per-profile Jarvis wake LaunchAgent.

This module only renders and validates plist data. It never writes a plist,
registers a job, creates a queue, or starts a process. The executable and
source tree must be stable across app updates before anyone installs it.
"""

from __future__ import annotations

import hashlib
import os
import plistlib
import re
import stat
from pathlib import Path
from typing import Any

_PROFILE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
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
    hermes_home: Path | str,
) -> tuple[Path, Path, Path, Path]:
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile):
        raise ValueError("profile must be a canonical lowercase profile id")
    home = _absolute_path(profile_home, "profile_home")
    base_home = _absolute_path(hermes_home, "hermes_home")
    python = _absolute_path(python_executable, "python_executable")
    script = _absolute_path(entrypoint, "entrypoint")
    if home == Path("/") or base_home == Path("/"):
        raise ValueError("profile_home and hermes_home must not be the filesystem root")
    if profile == "default" and home != base_home:
        raise ValueError("default profile home must equal the base Hermes home")
    if profile != "default" and home != base_home / "profiles" / profile:
        raise ValueError("named profile home must match its installed profile directory")
    source = base_home / "hermes-agent"
    if python != source / "venv" / "bin" / "python":
        raise ValueError("python_executable must be the installed Jarvis venv interpreter")
    if script != source / "tui_gateway" / "headless_owner_event.py":
        raise ValueError("entrypoint must be in the installed Jarvis source")
    return home, base_home, python, script


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
    *, hermes_home: Path | str,
) -> dict[str, Any]:
    """Build one on-demand job with no implicit shell or periodic trigger."""
    home, base_home, python, script = _inputs(
        profile, profile_home, python_executable, entrypoint, hermes_home)
    root = script.parent.parent
    return {
        "Label": launch_agent_label(profile, home),
        "ProgramArguments": [
            str(python), str(script), "--scan-wake-queue", "--allow-headless",
            "--profile", profile, "--expected-profile-home", str(home),
        ],
        "WorkingDirectory": str(root),
        "EnvironmentVariables": {"HERMES_HOME": str(base_home), "PYTHONPATH": str(root)},
        "QueueDirectories": [str(home / "runtime" / _WAKE_QUEUE)],
    }


def render_launch_agent_plist(
    profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
    *, hermes_home: Path | str,
) -> bytes:
    """Return XML plist bytes without touching the filesystem or launchd."""
    return plistlib.dumps(
        launch_agent_plist(profile, profile_home, python_executable, entrypoint,
                           hermes_home=hermes_home),
        fmt=plistlib.FMT_XML, sort_keys=True,
    )


def validate_launch_agent_plist(
    plist: bytes, *, profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
    hermes_home: Path | str,
) -> None:
    """Refuse any changed trigger, argument, path, label, or environment key."""
    expected = launch_agent_plist(profile, profile_home, python_executable, entrypoint,
                                  hermes_home=hermes_home)
    try:
        actual = plistlib.loads(plist)
    except (TypeError, ValueError, plistlib.InvalidFileException) as exc:
        raise ValueError("invalid LaunchAgent plist") from exc
    if actual != expected:
        raise ValueError("LaunchAgent plist differs from the exact one-shot wake contract")


def _no_symlink_components(path: Path) -> None:
    """Refuse path redirection before checking an installation snapshot."""
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError(f"wake installation path is symlinked: {current}")


def _owned_directory(path: Path) -> None:
    _no_symlink_components(path)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise ValueError(f"wake installation directory is not owner-private: {path}")


def validate_launch_agent_readiness(
    plist: bytes, *, profile: str, profile_home: Path | str,
    python_executable: Path | str, entrypoint: Path | str,
    hermes_home: Path | str,
) -> None:
    """Check the exact rendered job against the current local installation.

    This is a read-only pre-install snapshot, not a launch or a race-free lease.
    A venv Python may be a symlink: its pinned link and resolved executable are
    checked structurally, without claiming its runtime imports will succeed.
    """
    validate_launch_agent_plist(
        plist, profile=profile, profile_home=profile_home,
        python_executable=python_executable, entrypoint=entrypoint,
        hermes_home=hermes_home,
    )
    home, base, python, script = _inputs(
        profile, profile_home, python_executable, entrypoint, hermes_home)
    queue = home / "runtime" / _WAKE_QUEUE
    if profile != "default":
        _owned_directory(base / "profiles")
    for directory in (base, home, home / "runtime", queue):
        _owned_directory(directory)

    source = base / "hermes-agent"
    for directory in (source, source / "tui_gateway", source / "venv",
                      source / "venv" / "bin"):
        _no_symlink_components(directory)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o022):
            raise ValueError(f"installed Jarvis directory is unsafe: {directory}")

    _no_symlink_components(script)
    script_info = script.lstat()
    if (not stat.S_ISREG(script_info.st_mode) or script_info.st_uid != os.getuid()
            or stat.S_IMODE(script_info.st_mode) & 0o022
            or not os.access(script, os.R_OK)):
        raise ValueError("installed Jarvis entrypoint is not a usable owned file")

    # Python's final venv link is normal on macOS. All of its parent path is
    # pinned above; the target must exist and be an executable regular file.
    _no_symlink_components(python.parent)
    python_info = python.lstat()
    if python_info.st_uid != os.getuid() or not (
            stat.S_ISLNK(python_info.st_mode) or stat.S_ISREG(python_info.st_mode)):
        raise ValueError("installed Jarvis interpreter path is unsafe")
    resolved_python = python.resolve(strict=True)
    target_info = resolved_python.stat()
    if (not stat.S_ISREG(target_info.st_mode)
            or target_info.st_uid not in {0, os.getuid()}
            or stat.S_IMODE(target_info.st_mode) & 0o022
            or not os.access(resolved_python, os.X_OK)):
        raise ValueError("installed Jarvis interpreter is not executable")

    config = home / "config.yaml"
    _no_symlink_components(config)
    config_info = config.lstat()
    if (not stat.S_ISREG(config_info.st_mode) or config_info.st_uid != os.getuid()
            or stat.S_IMODE(config_info.st_mode) & 0o077):
        raise ValueError("Jarvis activation config is not an owner-private file")
    from tui_gateway.owner_event_inbox import jarvis_headless_activation_enabled

    if not jarvis_headless_activation_enabled(home):
        raise ValueError("headless activation is not enabled for the exact profile")
