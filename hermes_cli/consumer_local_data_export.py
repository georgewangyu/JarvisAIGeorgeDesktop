"""Bounded, local export of one profile's consumer-facing Jarvis data.

This is deliberately not a full agent-data export. Only reviewed setup text,
visible Desktop chat text, and verified uploads owned by those chats cross the
profile boundary. Credentials, schedules, tool results, and arbitrary files do
not.
"""

from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path

import yaml

from agent.redact import redact_sensitive_text
from hermes_cli.consumer_chat_export import export_consumer_chats
from hermes_cli.consumer_image_export import _visible_uploads
from hermes_cli.consumer_setup_export import (
    _MEMORY_TEXT,
    _ROOT_TEXT,
    _read_profile_text,
    _safe_config,
)

_MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
_MAX_SETUP_FILES = 200


def _target_path(profile_home: Path, output: Path | str) -> Path:
    from hermes_constants import get_default_hermes_root

    requested = Path(output).expanduser()
    if not requested.is_absolute() or requested.suffix.lower() != ".zip":
        raise ValueError("choose an absolute .zip export path")
    if requested.is_symlink():
        raise ValueError("choose a regular file, not a symbolic link")
    target = requested.resolve(strict=False)
    if profile_home.parent.name == "profiles":
        private_root = profile_home.parent.parent
    elif profile_home.name == "runtime":
        # Desktop's sibling shared-auth/managed directories are private too.
        private_root = profile_home.parent
    else:
        private_root = profile_home
    private_roots = {private_root, Path(get_default_hermes_root()).resolve(strict=False)}
    if any(target == root or root in target.parents for root in private_roots):
        raise ValueError("choose a location outside Jarvis's private data directory")
    if not target.parent.is_dir():
        raise ValueError("the export folder does not exist")
    if target.exists():
        raise ValueError("choose a new export filename; existing files are preserved")
    return target


def _setup_entries(home: Path):
    included = []
    config_text = _read_profile_text(home, "config.yaml")
    if config_text is not None:
        config = _safe_config(config_text)
        if config:
            included.append(("setup/config.yaml", redact_sensitive_text(
                json.dumps(config, ensure_ascii=False, indent=2) + "\n", force=True)))
    for relative in (*_ROOT_TEXT, *_MEMORY_TEXT):
        content = _read_profile_text(home, relative)
        if content is not None:
            included.append((f"setup/{relative}", redact_sensitive_text(content, force=True)))
    skills = home / "skills"
    if skills.is_dir() and not skills.is_symlink():
        sources = sorted(skills.glob("*/SKILL.md"))
        if len(sources) > _MAX_SETUP_FILES:
            raise ValueError("too many setup files to export")
        for source in sources:
            relative = source.relative_to(home).as_posix()
            content = _read_profile_text(home, relative)
            if content is not None:
                included.append((f"setup/{relative}", redact_sensitive_text(content, force=True)))
    return included


def _add_bytes(archive: zipfile.ZipFile, name: str, payload: bytes, size: int) -> int:
    size += len(payload)
    if size > _MAX_ARCHIVE_BYTES:
        raise ValueError("local data export exceeds size limit")
    archive.writestr(name, payload)
    return size


def export_consumer_local_data(
    db, profile_home: Path | str, profile_name: str, output: Path | str,
) -> dict:
    """Write a new 0600 ZIP without following source links or replacing a file.

    The caller supplies a profile-scoped, read-only SessionDB. The API layer
    resolves the profile and enforces local-only access before calling here.
    """
    if not profile_name:
        raise ValueError("choose a profile to export")
    home = Path(profile_home).resolve(strict=True)
    target = _target_path(home, output)
    temp_path = None
    chats = messages = images = total = 0
    # Check scope before any transcript bytes are staged outside the profile.
    # A shared/corrupt DB must not silently contribute another profile's rows.
    offset = 0
    while True:
        rows = db.search_sessions(source="desktop", limit=200, offset=offset)
        if not rows:
            break
        offset += len(rows)
        if any(row.get("profile_name") not in (None, profile_name)
               for row in rows if not row.get("hidden")):
            raise PermissionError("chat owner profile mismatch")

    with tempfile.TemporaryDirectory(prefix=".jarvis-data-stage-", dir=target.parent) as stage_dir:
        # Reuse the independently tested chat serializer; it writes only visible
        # user/assistant rows and publishes exclusively inside this private stage.
        chat_path = Path(stage_dir) / "chat-history.jsonl"
        chat_result = export_consumer_chats(db, home, chat_path)
        chats, messages = chat_result["chats"], chat_result["messages"]
        if chat_path.stat().st_size > _MAX_ARCHIVE_BYTES:
            raise ValueError("local data export exceeds size limit")

        fd, name = tempfile.mkstemp(prefix=".jarvis-data-export-", suffix=".tmp", dir=target.parent)
        temp_path = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    total = _add_bytes(archive, "chats/chat-history.jsonl", chat_path.read_bytes(), total)
                    setup_files = []
                    for filename, content in _setup_entries(home):
                        total = _add_bytes(archive, filename, content.encode("utf-8"), total)
                        setup_files.append(filename)
                    uploads = []
                    for record, blob in _visible_uploads(db, home, profile_name):
                        filename = f"uploads/{record['artifact_id']}{Path(record['blob_name']).suffix}"
                        total = _add_bytes(archive, filename, blob, total)
                        uploads.append({
                            "file": filename,
                            "chat_id": record["session_id"],
                            "byte_size": len(blob),
                        })
                        images += 1
                    manifest = {
                        "format": "jarvis-local-data-v1",
                        "scope": "one local profile; visible Desktop chats only",
                        "included": {
                            "chat_history": "chats/chat-history.jsonl",
                            "setup_files": setup_files,
                            "uploaded_images": uploads,
                        },
                        "excluded": [
                            "sign-in credentials and tokens",
                            "routines and scheduler state",
                            "hidden and non-Desktop chats",
                            "generated files and arbitrary agent artifacts",
                            "tool results and internal worker state",
                            "custom desktop appearance not stored in the backend profile",
                        ],
                        "note": "This is a local copy, not a restorable or complete agent-data backup.",
                    }
                    _add_bytes(archive, "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"), total)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temp_path, target)
            except FileExistsError as exc:
                raise ValueError("choose a new export filename; existing files are preserved") from exc
            return {"output": str(target), "chats": chats, "messages": messages, "images": images}
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
