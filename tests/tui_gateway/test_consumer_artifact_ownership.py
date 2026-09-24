"""Exact profile/session provenance for TUI image byte uploads."""

import base64
import json
import sys
import threading
import types
from pathlib import Path

import pytest

from tui_gateway import server
from tui_gateway.consumer_artifact_ownership import read_uploaded_image, record_uploaded_image


_PNG = b"\x89PNG\r\n\x1a\n" + b"test image bytes"


def _session(home: Path, key: str) -> dict:
    return {
        "agent": types.SimpleNamespace(),
        "session_key": key,
        "profile_home": str(home),
        "history": [],
        "history_lock": threading.Lock(),
        "running": False,
        "attached_images": [],
        "image_counter": 0,
    }


def test_rpc_records_copy_under_stored_profile_and_session(monkeypatch, tmp_path):
    fake_cli = types.ModuleType("cli")
    fake_cli._IMAGE_EXTENSIONS = {".png"}
    monkeypatch.setitem(sys.modules, "cli", fake_cli)
    home_a = tmp_path / "a"
    home_b = tmp_path / "b"
    home_a.mkdir()
    home_b.mkdir()
    monkeypatch.setitem(server._sessions, "upload-a", _session(home_a, "stored-a"))
    monkeypatch.setitem(server._sessions, "upload-b", _session(home_b, "stored-b"))

    for runtime_id in ("upload-a", "upload-b", "upload-a"):
        response = server.handle_request({
            "id": runtime_id,
            "method": "image.attach_bytes",
            "params": {"session_id": runtime_id, "content_base64": base64.b64encode(_PNG).decode()},
        })
        assert response["result"]["attached"] is True

    records_a = sorted((home_a / "consumer-artifacts").glob("*.json"))
    records_b = sorted((home_b / "consumer-artifacts").glob("*.json"))
    assert len(records_a) == 2
    assert len(records_b) == 1
    for path in records_a:
        record = json.loads(path.read_text())
        assert read_uploaded_image(home_a, "stored-a", record["artifact_id"])[1] == _PNG
        with pytest.raises(PermissionError):
            read_uploaded_image(home_a, "stored-b", record["artifact_id"])
        with pytest.raises(FileNotFoundError):
            read_uploaded_image(home_b, "stored-a", record["artifact_id"])


def test_copy_survives_attachment_removal_and_rejects_tampering(tmp_path):
    home = tmp_path / "profile"
    home.mkdir()
    record = record_uploaded_image(home, "session-1", _PNG, ".png")
    artifact_id = record["artifact_id"]
    store = home / "consumer-artifacts"
    assert read_uploaded_image(home, "session-1", artifact_id)[1] == _PNG

    blob = store / record["blob_name"]
    blob.write_bytes(b"X" * len(_PNG))
    with pytest.raises(ValueError, match="digest"):
        read_uploaded_image(home, "session-1", artifact_id)

    blob.write_bytes(_PNG)
    manifest = store / f"{artifact_id}.json"
    altered = json.loads(manifest.read_text())
    altered["blob_name"] = "../other.png"
    manifest.write_text(json.dumps(altered))
    with pytest.raises(ValueError, match="blob name"):
        read_uploaded_image(home, "session-1", artifact_id)


def test_read_refuses_symlinked_blob_and_oversized_manifest(tmp_path):
    home = tmp_path / "profile"
    home.mkdir()
    record = record_uploaded_image(home, "session-1", _PNG, ".png")
    store = home / "consumer-artifacts"
    blob = store / record["blob_name"]
    blob.unlink()
    blob.symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        read_uploaded_image(home, "session-1", record["artifact_id"])

    manifest = store / f"{record['artifact_id']}.json"
    manifest.write_bytes(b" " * 4097)
    with pytest.raises(ValueError, match="artifact file"):
        read_uploaded_image(home, "session-1", record["artifact_id"])


def test_rpc_does_not_attach_when_record_commit_fails(monkeypatch, tmp_path):
    import tui_gateway.consumer_artifact_ownership as ownership

    fake_cli = types.ModuleType("cli")
    fake_cli._IMAGE_EXTENSIONS = {".png"}
    monkeypatch.setitem(sys.modules, "cli", fake_cli)
    home = tmp_path / "profile"
    home.mkdir()
    session = _session(home, "stored-a")
    monkeypatch.setitem(server._sessions, "upload-fail", session)
    monkeypatch.setattr(ownership, "record_uploaded_image", lambda *_args: (_ for _ in ()).throw(OSError("disk full")))

    response = server.handle_request({
        "id": "failure",
        "method": "image.attach_bytes",
        "params": {"session_id": "upload-fail", "content_base64": base64.b64encode(_PNG).decode()},
    })
    assert response["error"]["code"] == 5027
    assert session["attached_images"] == []


def test_record_refuses_missing_owner_and_symlink_store(tmp_path):
    home = tmp_path / "profile"
    home.mkdir()
    with pytest.raises(ValueError, match="session id"):
        record_uploaded_image(home, "", _PNG, ".png")
    outside = tmp_path / "outside"
    outside.mkdir()
    (home / "consumer-artifacts").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        record_uploaded_image(home, "session-1", _PNG, ".png")
    assert list(outside.iterdir()) == []
