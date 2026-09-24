"""Durable, session-owned copies of images uploaded through the TUI RPC.

This store covers only ``image.attach_bytes``. A dashboard file upload or an
agent-created file has no ownership proof from this ingestion point.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import uuid
from pathlib import Path


_STORE_DIR = "consumer-artifacts"
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"})
_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_MAX_MANIFEST_BYTES = 4096


def _store(profile_home: Path | str) -> tuple[Path, Path]:
    home = Path(profile_home).resolve(strict=True)
    if not home.is_dir():
        raise ValueError("profile home is not a directory")
    store = home / _STORE_DIR
    if store.is_symlink():
        raise ValueError("artifact store cannot be a symlink")
    return home, store


def record_uploaded_image(
    profile_home: Path | str, session_id: str, image: bytes, extension: str,
) -> dict:
    """Copy verified upload bytes and commit one exact-owner manifest.

    The immutable copy is independent of the temporary attachment path, which
    may later be deleted or reused. A manifest is published only after the copy
    is complete; failures remove the unpublished copy.
    """
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("stored session id is required")
    if extension not in _IMAGE_EXTENSIONS or not image or len(image) > _MAX_IMAGE_BYTES:
        raise ValueError("invalid image upload")
    home, store = _store(profile_home)
    store.mkdir(mode=0o700, exist_ok=True)
    if store.is_symlink() or store.resolve(strict=True) != home / _STORE_DIR:
        raise ValueError("artifact store escapes profile home")

    artifact_id = uuid.uuid4().hex
    blob_name = f"{artifact_id}{extension}"
    blob = store / blob_name
    manifest = store / f"{artifact_id}.json"
    digest = hashlib.sha256(image).hexdigest()
    record = {
        "version": 1,
        "artifact_id": artifact_id,
        "source": "tui:image.attach_bytes",
        "kind": "user_uploaded_image",
        "profile_home": str(home),
        "session_id": session_id,
        "blob_name": blob_name,
        "byte_size": len(image),
        "sha256": digest,
    }
    blob_tmp = store / f".{artifact_id}.blob.tmp"
    manifest_tmp = store / f".{artifact_id}.json.tmp"
    published = False
    try:
        with blob_tmp.open("xb") as handle:
            handle.write(image)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(blob_tmp, blob)
        with manifest_tmp.open("x", encoding="utf-8") as handle:
            json.dump(record, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(manifest_tmp, manifest)
        published = True
    finally:
        blob_tmp.unlink(missing_ok=True)
        manifest_tmp.unlink(missing_ok=True)
        if not published:
            blob.unlink(missing_ok=True)
    return record


def _read_regular(path: Path, max_bytes: int) -> bytes:
    """Bounded read of one regular file without following a final symlink."""
    if path.is_symlink():
        raise ValueError("artifact path cannot be a symlink")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        file_stat = os.fstat(handle.fileno())
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size > max_bytes:
            raise ValueError("invalid artifact file")
        return handle.read(max_bytes + 1)


def read_uploaded_image(
    profile_home: Path | str, session_id: str, artifact_id: str,
) -> tuple[dict, bytes]:
    """Read a copy only for its exact stored profile and session owner."""
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("stored session id is required")
    if not isinstance(artifact_id, str) or len(artifact_id) != 32 or any(
        char not in "0123456789abcdef" for char in artifact_id
    ):
        raise ValueError("invalid artifact id")
    home, store = _store(profile_home)
    if store.is_symlink() or not store.is_dir() or store.resolve(strict=True) != home / _STORE_DIR:
        raise FileNotFoundError("artifact store unavailable")
    manifest = store / f"{artifact_id}.json"
    record = json.loads(_read_regular(manifest, _MAX_MANIFEST_BYTES).decode("utf-8"))
    if not isinstance(record, dict) or any((
        record.get("version") != 1,
        record.get("artifact_id") != artifact_id,
        record.get("source") != "tui:image.attach_bytes",
        record.get("kind") != "user_uploaded_image",
        record.get("profile_home") != str(home),
        record.get("session_id") != session_id,
    )):
        raise PermissionError("artifact ownership mismatch")
    blob_name = record.get("blob_name")
    if not isinstance(blob_name, str) or not any(
        blob_name == f"{artifact_id}{ext}" for ext in _IMAGE_EXTENSIONS
    ):
        raise ValueError("invalid artifact blob name")
    blob = store / blob_name
    size = record.get("byte_size")
    if not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > _MAX_IMAGE_BYTES:
        raise ValueError("invalid artifact size")
    image = _read_regular(blob, _MAX_IMAGE_BYTES)
    if len(image) != size or hashlib.sha256(image).hexdigest() != record.get("sha256"):
        raise ValueError("artifact digest mismatch")
    return record, image
