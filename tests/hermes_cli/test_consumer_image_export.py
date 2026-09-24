"""Only verified uploads from visible Desktop chats can leave a profile."""

import json
import zipfile

import pytest
from starlette.testclient import TestClient

from hermes_cli.consumer_image_export import export_consumer_images, list_consumer_images
from hermes_state import SessionDB
from tui_gateway.consumer_artifact_ownership import record_uploaded_image


_IMAGE = b"\x89PNG\r\n\x1a\n" + b"synthetic image"


def _db(home, name):
    home.mkdir(parents=True)
    db = SessionDB(db_path=home / "state.db")
    db.create_session("visible", source="desktop", profile_name=name)
    db.create_session("hidden", source="desktop", profile_name=name)
    db.set_session_hidden("hidden", True)
    db.create_session("internal", source="tool", profile_name=name)
    db.create_session("foreign-owner", source="desktop", profile_name="other")
    return db


def test_list_and_export_visible_session_uploads_only(tmp_path):
    home = tmp_path / "profile"
    db = _db(home, "alpha")
    try:
        visible = record_uploaded_image(home, "visible", _IMAGE, ".png")
        for session_id in ("hidden", "internal"):
            record_uploaded_image(home, session_id, _IMAGE, ".png")

        listing = list_consumer_images(db, home, "alpha")
        assert len(listing) == 1
        assert listing[0]["artifact_id"] == visible["artifact_id"]
        assert listing[0]["session_id"] == "visible"
        assert "profile_home" not in listing[0]

        output = tmp_path / "images.zip"
        result = export_consumer_images(db, home, "alpha", output)
        assert result == {"output": str(output), "images": 1, "bytes": len(_IMAGE)}
        assert output.stat().st_mode & 0o777 == 0o600
        original = output.read_bytes()
        with pytest.raises(ValueError, match="existing files"):
            export_consumer_images(db, home, "alpha", output)
        assert output.read_bytes() == original
        with zipfile.ZipFile(output) as archive:
            payload = json.loads(archive.read("manifest.json"))
            assert payload["format"] == "jarvis-consumer-images-v1"
            assert len(payload["images"]) == 1
            assert payload["images"][0]["session_id"] == "visible"
            assert archive.read(payload["images"][0]["file"]) == _IMAGE
            assert len(archive.namelist()) == 2
    finally:
        db.close()


def test_tampering_and_private_output_fail_closed(tmp_path):
    home = tmp_path / ".hermes" / "profiles" / "alpha"
    db = _db(home, "alpha")
    try:
        record = record_uploaded_image(home, "visible", _IMAGE, ".png")
        with pytest.raises(ValueError, match="outside Jarvis"):
            export_consumer_images(db, home, "alpha", home.parent.parent / "bad.zip")

        store = home / "consumer-artifacts"
        manifest = store / f"{record['artifact_id']}.json"
        changed = json.loads(manifest.read_text())
        changed["session_id"] = "hidden"
        manifest.write_text(json.dumps(changed))
        with pytest.raises(ValueError, match="signature"):
            list_consumer_images(db, home, "alpha")
        assert not list(tmp_path.glob(".jarvis-image-export-*.tmp"))
    finally:
        db.close()


def test_export_refuses_modified_blob_and_symlink_destination(tmp_path):
    home = tmp_path / "profile"
    db = _db(home, "alpha")
    try:
        record = record_uploaded_image(home, "visible", _IMAGE, ".png")
        output = tmp_path / "images.zip"
        output.symlink_to(tmp_path / "other.zip")
        with pytest.raises(ValueError, match="symbolic link"):
            export_consumer_images(db, home, "alpha", output)

        blob = home / "consumer-artifacts" / record["blob_name"]
        blob.write_bytes(b"X" * len(_IMAGE))
        with pytest.raises(ValueError, match="digest"):
            export_consumer_images(db, home, "alpha", tmp_path / "clean.zip")
        assert not (tmp_path / "clean.zip").exists()
        assert not list(tmp_path.glob(".jarvis-image-export-*.tmp"))
    finally:
        db.close()


def test_orphan_blob_or_manifest_fails_entire_list_and_export(tmp_path):
    home = tmp_path / "profile"
    db = _db(home, "alpha")
    try:
        record = record_uploaded_image(home, "visible", _IMAGE, ".png")
        store = home / "consumer-artifacts"
        orphan = store / ("a" * 32 + ".png")
        orphan.write_bytes(_IMAGE)
        with pytest.raises(ValueError, match="orphan"):
            list_consumer_images(db, home, "alpha")
        with pytest.raises(ValueError, match="orphan"):
            export_consumer_images(db, home, "alpha", tmp_path / "orphan.zip")
        assert not (tmp_path / "orphan.zip").exists()
        orphan.unlink()

        (store / record["blob_name"]).unlink()
        with pytest.raises(FileNotFoundError):
            list_consumer_images(db, home, "alpha")
    finally:
        db.close()


def test_missing_or_foreign_profile_session_record_fails_closed(tmp_path):
    home = tmp_path / "profile"
    db = _db(home, "alpha")
    try:
        record_uploaded_image(home, "missing", _IMAGE, ".png")
        with pytest.raises(ValueError, match="owner session is missing"):
            list_consumer_images(db, home, "alpha")
    finally:
        db.close()

    second = tmp_path / "other-profile"
    db = _db(second, "alpha")
    try:
        record_uploaded_image(second, "foreign-owner", _IMAGE, ".png")
        with pytest.raises(PermissionError, match="owner profile mismatch"):
            list_consumer_images(db, second, "alpha")
    finally:
        db.close()


def test_selected_profile_routes_do_not_mix_or_export_private_data(tmp_path, monkeypatch):
    from hermes_cli.web_routers import sessions
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    homes = {name: tmp_path / name for name in ("alpha", "beta")}
    for name, home in homes.items():
        db = _db(home, name)
        record_uploaded_image(home, "visible", _IMAGE + name.encode(), ".png")
        record_uploaded_image(home, "hidden", _IMAGE, ".png")
        db.close()
    monkeypatch.setattr(sessions, "_cron_profile_home", lambda name: (name, homes[name]))
    monkeypatch.setattr(sessions, "_open_session_db_for_profile",
                        lambda name, read_only: SessionDB(db_path=homes[name] / "state.db", read_only=read_only))
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    alpha = client.get("/api/sessions/consumer-images", params={"profile": "alpha"})
    beta = client.get("/api/sessions/consumer-images", params={"profile": "beta"})
    assert alpha.status_code == beta.status_code == 200
    assert len(alpha.json()["images"]) == len(beta.json()["images"]) == 1
    assert alpha.json()["images"][0]["artifact_id"] != beta.json()["images"][0]["artifact_id"]

    output = tmp_path / "alpha.zip"
    response = client.post("/api/sessions/export-consumer-images", json={
        "profile": "alpha", "output": str(output)})
    assert response.status_code == 200
    with zipfile.ZipFile(output) as archive:
        assert _IMAGE + b"alpha" in [archive.read(name) for name in archive.namelist() if name.endswith(".png")]
        assert _IMAGE + b"beta" not in [archive.read(name) for name in archive.namelist() if name.endswith(".png")]

    alpha_manifest = next((homes["alpha"] / "consumer-artifacts").glob("*.json"))
    alpha_manifest.unlink()
    corrupt = client.get("/api/sessions/consumer-images", params={"profile": "alpha"})
    assert corrupt.status_code == 409
    assert str(homes["alpha"]) not in corrupt.text
    assert str(homes["beta"]) not in corrupt.text

    del client.headers[_SESSION_HEADER_NAME]
    assert client.get("/api/sessions/consumer-images", params={"profile": "alpha"}).status_code == 401
