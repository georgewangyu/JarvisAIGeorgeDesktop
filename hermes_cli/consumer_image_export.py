"""List/export only signed TUI image uploads of visible Desktop chats."""

from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path

from tui_gateway.consumer_artifact_ownership import read_uploaded_image


_MAX_IMAGES = 500
_MAX_EXPORT_BYTES = 250 * 1024 * 1024


def _private_root(home: Path) -> Path:
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


def _visible_uploads(db, home: Path, profile_name: str):
    store = home / "consumer-artifacts"
    if store.is_symlink():
        raise ValueError("artifact store cannot be a symbolic link")
    if not store.exists():
        return
    if not store.is_dir() or store.resolve(strict=True) != home / "consumer-artifacts":
        raise ValueError("invalid artifact store")
    entries = list(store.iterdir())
    if len(entries) > _MAX_IMAGES * 2:
        raise ValueError("too many image uploads to export")
    manifests = sorted(path for path in entries if path.suffix == ".json")
    if len(manifests) > _MAX_IMAGES:
        raise ValueError("too many image uploads to export")
    expected_names = set()
    for manifest in manifests:
        artifact_id = manifest.stem
        if len(artifact_id) != 32 or any(c not in "0123456789abcdef" for c in artifact_id):
            raise ValueError("invalid artifact manifest name")
        # The signed manifest is read through the ownership store. Never open
        # a client-supplied image path or infer an owner from a filename.
        from tui_gateway.consumer_artifact_ownership import _read_regular
        raw = json.loads(_read_regular(manifest, 4096).decode("utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("session_id"), str):
            raise ValueError("invalid artifact manifest")
        record, image = read_uploaded_image(home, raw["session_id"], artifact_id)
        expected_names.update((manifest.name, record["blob_name"]))
        session = db.get_session(record["session_id"])
        if not session:
            raise ValueError("artifact owner session is missing")
        if session.get("profile_name") not in (None, profile_name):
            raise PermissionError("artifact owner profile mismatch")
        if session.get("source") != "desktop" or bool(session.get("hidden")):
            continue
        yield record, image
    if {path.name for path in entries} != expected_names:
        raise ValueError("orphan or unexpected artifact file")


def list_consumer_images(db, profile_home: Path | str, profile_name: str) -> list[dict]:
    """Return metadata only for signed uploads owned by visible Desktop chats."""
    home = Path(profile_home).resolve(strict=True)
    images = []
    for record, _image in _visible_uploads(db, home, profile_name):
        images.append({
            "artifact_id": record["artifact_id"],
            "session_id": record["session_id"],
            "kind": record["kind"],
            "byte_size": record["byte_size"],
            "extension": Path(record["blob_name"]).suffix,
        })
    return images


def export_consumer_images(
    db, profile_home: Path | str, profile_name: str, output: Path | str,
) -> dict:
    """Atomically write a bounded ZIP outside the Jarvis private data tree."""
    from hermes_constants import get_default_hermes_root

    home = Path(profile_home).resolve(strict=True)
    target = Path(output).expanduser()
    if not target.is_absolute() or target.suffix.lower() != ".zip":
        raise ValueError("choose an absolute .zip export path")
    if target.is_symlink():
        raise ValueError("choose a regular file, not a symbolic link")
    target = target.resolve(strict=False)
    private_roots = {_private_root(home), Path(get_default_hermes_root()).resolve(strict=False)}
    if any(target == root or root in target.parents for root in private_roots):
        raise ValueError("choose a location outside Jarvis's private data directory")
    if not target.parent.is_dir():
        raise ValueError("the export folder does not exist")
    if target.exists():
        raise ValueError("choose a new export filename; existing files are preserved")

    temp_path = None
    count = total = 0
    try:
        fd, temp_name = tempfile.mkstemp(prefix=".jarvis-image-export-", suffix=".tmp", dir=target.parent)
        temp_path = Path(temp_name)
        with os.fdopen(fd, "wb") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
                listing = []
                for record, image in _visible_uploads(db, home, profile_name):
                    total += len(image)
                    if total > _MAX_EXPORT_BYTES:
                        raise ValueError("image export exceeds size limit")
                    name = f"images/{record['artifact_id']}{Path(record['blob_name']).suffix}"
                    archive.writestr(name, image)
                    listing.append({
                        "artifact_id": record["artifact_id"],
                        "session_id": record["session_id"],
                        "kind": record["kind"],
                        "file": name,
                        "byte_size": len(image),
                    })
                    count += 1
                archive.writestr("manifest.json", json.dumps({
                    "format": "jarvis-consumer-images-v1", "scope": "visible desktop chats",
                    "images": listing,
                }, sort_keys=True))
            stream.flush()
            os.fsync(stream.fileno())
        # The same-directory hard link is atomic and exclusive: an output that
        # appears after the preflight is preserved rather than overwritten.
        os.link(temp_path, target)
        temp_path.unlink()
        temp_path = None
        return {"output": str(target), "images": count, "bytes": total}
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
