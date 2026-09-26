"""Explicit JSON command-line adapter for one profile's Jarvis wake LaunchAgent.

No installation or launchd call happens on import. All filesystem inputs are
derived from the process's explicit HERMES_HOME and the selected profile.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable, Mapping, Sequence, TextIO

from tui_gateway.jarvis_wake_launchd import launch_agent_label

_ACTIONS = frozenset({"status", "install", "disable"})


def _base_home(environ: Mapping[str, str]) -> Path:
    raw = environ.get("HERMES_HOME", "")
    if (not isinstance(raw, str) or not raw or "\x00" in raw
            or "\n" in raw or "\r" in raw):
        raise ValueError("HERMES_HOME is required")
    base = Path(raw)
    if (not base.is_absolute() or base == Path("/")
            or any(part in {".", ".."} for part in raw.split("/"))
            or (len(base.parts) >= 3 and base.parts[-2] == "profiles")):
        raise ValueError("HERMES_HOME must name a clean absolute base home")
    return base


def _request(argv: Sequence[str], environ: Mapping[str, str]) -> tuple[str, str, dict[str, object]]:
    # The CLI deliberately has no path options. A renderer may select an
    # action and profile, but cannot point the manager at another install.
    if len(argv) != 3 or argv[0] not in _ACTIONS or argv[1] != "--profile":
        raise ValueError("expected ACTION --profile PROFILE")
    action, profile = argv[0], argv[2]
    base = _base_home(environ)
    home = base if profile == "default" else base / "profiles" / profile
    launch_agent_label(profile, home)  # validates the canonical profile id
    source = base / "hermes-agent"
    return action, profile, {
        "profile": profile,
        "profile_home": home,
        "python_executable": source / "venv" / "bin" / "python",
        "entrypoint": source / "tui_gateway" / "headless_owner_event.py",
        "hermes_home": base,
    }


def execute(
    argv: Sequence[str], *, environ: Mapping[str, str] | None = None,
    manager_factory: Callable[..., object] | None = None,
) -> tuple[int, dict[str, object]]:
    """Return a path-free JSON result and exit code for one explicit action."""
    try:
        action, profile, inputs = _request(argv, os.environ if environ is None else environ)
    except (TypeError, ValueError):
        return 2, {"ok": False, "error": {"code": "invalid_request", "message": "Invalid wake command, profile, or HERMES_HOME."}}

    try:
        if manager_factory is None:
            from tui_gateway.jarvis_wake_launchd_install import JarvisWakeLaunchAgent

            manager_factory = JarvisWakeLaunchAgent
        manager = manager_factory(**inputs)
        state = getattr(manager, action)()
        fields = {key: getattr(state, key) for key in ("installed", "loaded", "running")}
        if any(type(value) is not bool for value in fields.values()):
            raise TypeError("invalid manager status")
    except Exception:
        # The manager may include private filesystem paths in validation errors.
        return 1, {"ok": False, "error": {"code": "operation_failed", "message": "Wake operation failed; inspect the local installation."}}
    return 0, {"ok": True, "profile": profile, **fields}


def main(
    argv: Sequence[str] | None = None, *, environ: Mapping[str, str] | None = None,
    manager_factory: Callable[..., object] | None = None,
    output: TextIO | None = None,
) -> int:
    """Write exactly one JSON object; never print a raw exception or path."""
    code, result = execute(
        sys.argv[1:] if argv is None else argv,
        environ=environ, manager_factory=manager_factory,
    )
    stream = sys.stdout if output is None else output
    stream.write(json.dumps(result, separators=(",", ":")) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
