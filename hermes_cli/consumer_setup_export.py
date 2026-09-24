"""Conservative, importable backup of consumer-facing assistant setup.

The profile transfer archive is intentionally broader. This exporter stages only
reviewed text setup files and a small allowlist of nonsecret preferences. It
does not copy a profile tree or scheduler state.
"""

from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Mapping

import yaml

from agent.redact import redact_sensitive_text
from hermes_cli.archive_safe import make_targz
from hermes_cli.profiles import _existing_profile_dir, _get_default_hermes_home

_TEXT_LIMIT = 1024 * 1024
_ROOT_TEXT = ("SOUL.md", "USER.md", "MEMORY.md")
_MEMORY_TEXT = ("memories/MEMORY.md", "memories/USER.md")
_DISPLAY_KEYS = ("skin", "language", "compact", "resume_last_session")
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}\Z")
_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")


def _read_profile_text(home: Path, relative: str) -> str | None:
    source = home / relative
    if any(part.is_symlink() for part in (source, *source.parents) if part == home or home in part.parents):
        return None
    if not source.is_file() or source.stat().st_size > _TEXT_LIMIT:
        return None
    try:
        return source.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def _stage_text(staged: Path, relative: str, text: str) -> None:
    target = staged / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(redact_sensitive_text(text, force=True), encoding="utf-8")


def _safe_config(raw: str) -> dict:
    loaded = yaml.safe_load(raw)
    if not isinstance(loaded, dict):
        return {}
    result: dict = {}
    model = loaded.get("model")
    if isinstance(model, str) and _MODEL_ID.fullmatch(model):
        result["model"] = model
    display = loaded.get("display")
    if isinstance(display, dict):
        selected = {
            key: display[key] for key in _DISPLAY_KEYS
            if key in display and isinstance(display[key], (str, bool))
            and (not isinstance(display[key], str) or len(display[key]) <= 80)
        }
        if selected:
            result["display"] = selected
    return result


def _safe_desktop_overlay(raw: str) -> dict:
    try:
        overlay = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid desktop appearance overlay") from exc
    if not isinstance(overlay, dict) or set(overlay) - {"version", "skin", "mode", "profileColor"}:
        raise ValueError("consumer setup overlay contains unsupported fields")
    if overlay.get("version") != 1:
        raise ValueError("invalid desktop appearance overlay version")
    skin = overlay.get("skin")
    if skin is not None and (not isinstance(skin, str) or len(skin) > 80 or not _MODEL_ID.fullmatch(skin)):
        raise ValueError("invalid desktop appearance skin")
    mode = overlay.get("mode")
    if mode is not None and mode not in {"light", "dark", "system"}:
        raise ValueError("invalid desktop appearance mode")
    color = overlay.get("profileColor")
    if color is not None and (not isinstance(color, str) or not _HEX_COLOR.fullmatch(color)):
        raise ValueError("invalid desktop appearance color")
    return overlay


def _archive_base(output_path: str, home: Path) -> str:
    requested = Path(output_path).expanduser()
    if not requested.is_absolute() or not (
        requested.name.endswith(".tar.gz") or requested.name.endswith(".tgz")
    ):
        raise ValueError("choose an absolute .tar.gz or .tgz export path")
    if requested.is_symlink():
        raise ValueError("choose a regular file, not a symbolic link")
    base = str(requested).removesuffix(".tar.gz").removesuffix(".tgz")
    destination = Path(base + ".tar.gz")
    if destination.is_symlink():
        raise ValueError("choose a regular file, not a symbolic link")
    destination = destination.resolve(strict=False)
    private_roots = (home.resolve(), _get_default_hermes_home().resolve())
    if any(destination == root or root in destination.parents for root in private_roots):
        raise ValueError("choose a location outside Jarvis's private data directory")
    if not destination.parent.is_dir():
        raise ValueError("the export folder does not exist")
    return str(destination).removesuffix(".tar.gz")


def export_consumer_setup(
    name: str, output_path: str, *, extra_files: Mapping[str, str] | None = None,
) -> Path:
    """Write a setup-only archive with the profile importer's standard root.

    Routines are omitted: jobs.json combines user jobs with internal work and
    runtime state, and importing live jobs could execute them unexpectedly.
    """
    extras = dict(extra_files or {})
    if set(extras) - {"desktop.json"} or any(not isinstance(v, str) for v in extras.values()):
        raise ValueError("consumer setup export accepts only the desktop appearance overlay")
    canon, home = _existing_profile_dir(name)
    base = _archive_base(output_path, home)
    with tempfile.TemporaryDirectory(prefix="consumer-setup-export-") as tmp:
        staged = Path(tmp) / canon
        staged.mkdir()
        included: list[str] = []
        raw_config = _read_profile_text(home, "config.yaml")
        if raw_config is not None:
            try:
                config = _safe_config(raw_config)
            except yaml.YAMLError as exc:
                raise ValueError("cannot read assistant setup settings") from exc
            if config:
                _stage_text(staged, "config.yaml", json.dumps(config, ensure_ascii=False, indent=2) + "\n")
                included.append("config.yaml")
        for relative in (*_ROOT_TEXT, *_MEMORY_TEXT):
            content = _read_profile_text(home, relative)
            if content is not None:
                _stage_text(staged, relative, content)
                included.append(relative)
        skills = home / "skills"
        if skills.is_dir() and not skills.is_symlink():
            for source in sorted(skills.glob("*/SKILL.md")):
                relative = source.relative_to(home).as_posix()
                content = _read_profile_text(home, relative)
                if content is not None:
                    _stage_text(staged, relative, content)
                    included.append(relative)
        if "desktop.json" in extras:
            overlay = _safe_desktop_overlay(extras["desktop.json"])
            _stage_text(staged, "desktop.json", json.dumps(overlay, ensure_ascii=False, indent=2))
            included.append("desktop.json")
        manifest = {
            "format": "consumer-assistant-setup-v1",
            "included": included,
            "omitted": ["chats", "routines", "credential stores", "internal worker state", "files and artifacts"],
            "note": "Routines require manual review and are not included or enabled by import.",
        }
        _stage_text(staged, "setup-backup.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        return Path(make_targz(base, tmp, canon))
