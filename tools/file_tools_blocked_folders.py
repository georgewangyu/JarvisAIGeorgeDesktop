"""Profile-scoped blocked folders for the local read/write/patch file tools.

``file_tools.blocked_folders`` is a list of absolute directory paths in the
active profile's config.yaml. This guard deliberately does not cover terminal,
browser, search, or remote file backends; those need separate enforcement.
"""

import os
from pathlib import Path
from typing import Callable, Iterable

from tools.file_tools_paths import _expand_tilde, _resolve_base_dir


_BLOCKED = "This folder is blocked for local file tools."
_INVALID = "Blocked-folder settings are invalid; local file tools are unavailable until they are fixed."
_REMOTE = "Blocked-folder settings cannot be enforced by this remote file backend."


def blocked_folder_error(targets: Iterable[tuple[str, str | Path]], *, task_id: str,
                         host_paths: Callable[[], bool]) -> str | None:
    """Return a denial before file I/O, or ``None`` when no listed folder contains a target.

    Callers pass both the raw and task-cwd-resolved targets and keep using the
    resolved targets after approval. Compare both lexical and canonical paths:
    a symlink into a blocked tree and one *inside* it pointing out are denied.
    """
    from hermes_cli.config import load_config_readonly

    try:
        section = load_config_readonly().get("file_tools", {})
    except Exception:
        return _INVALID
    if not isinstance(section, dict):
        return _INVALID
    configured = section.get("blocked_folders", [])
    if configured is None:
        return _INVALID
    if not isinstance(configured, list) or any(
        not isinstance(folder, str) or not folder.strip() or not Path(folder).is_absolute()
        for folder in configured
    ):
        return _INVALID
    if not configured:
        return None
    try:
        local = host_paths()
    except Exception:
        return _REMOTE
    if not local:
        return _REMOTE

    try:
        blocked = [(Path(os.path.abspath(folder)), Path(folder).resolve()) for folder in configured]
        base = Path(_resolve_base_dir(task_id))
        for raw, target in targets:
            lexical_input = Path(_expand_tilde(raw))
            lexical = Path(os.path.abspath(str(
                lexical_input if lexical_input.is_absolute() else base / lexical_input)))
            resolved = Path(target).resolve()
            if not lexical.is_absolute() or not resolved.is_absolute():
                return _INVALID
            if any(
                lexical.is_relative_to(folder_lexical) or resolved.is_relative_to(folder_resolved)
                for folder_lexical, folder_resolved in blocked
            ):
                return _BLOCKED
    except (OSError, RuntimeError, ValueError):
        return _INVALID
    return None
