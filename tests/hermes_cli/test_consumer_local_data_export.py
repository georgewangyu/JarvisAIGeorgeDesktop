"""A local data download is profile-bound, bounded, and never a credential dump."""

import json
import zipfile

import pytest
import yaml
from starlette.testclient import TestClient

from hermes_cli.consumer_local_data_export import export_consumer_local_data
from hermes_state import SessionDB
from tui_gateway.consumer_artifact_ownership import record_uploaded_image

_IMAGE = b"\x89PNG\r\n\x1a\nsynthetic-local-data"


def _profile(tmp_path, name="alpha"):
    home = tmp_path / ".hermes" / "profiles" / name
    home.mkdir(parents=True)
    db = SessionDB(db_path=home / "state.db")
    db.create_session("visible", source="desktop", profile_name=name)
    db.create_session("hidden", source="desktop", profile_name=name)
    db.set_session_hidden("hidden", True)
    db.create_session("internal", source="tool", profile_name=name)
    db.append_message("visible", "user", "My synthetic hello")
    db.append_message("visible", "assistant", "Synthetic reply")
    db.append_message("hidden", "user", "hidden private chat")
    return home, db


def test_bundle_contains_reviewed_setup_visible_chats_and_owned_uploads(tmp_path):
    home, db = _profile(tmp_path)
    try:
        (home / "SOUL.md").write_text("Helpful synthetic assistant")
        (home / ".env").write_text("OPENAI_API_KEY=DO_NOT_EXPORT")
        (home / "jobs.json").write_text("SCHEDULE_SECRET")
        (home / "generated.txt").write_text("GENERATED_SECRET")
        (home / "config.yaml").write_text("display:\n  skin: lavender\nmodel:\n  provider: custom\n  api_key: DO_NOT_EXPORT\n")
        record_uploaded_image(home, "visible", _IMAGE, ".png")
        record_uploaded_image(home, "hidden", b"HIDDEN_IMAGE", ".png")

        output = tmp_path / "local-data.zip"
        result = export_consumer_local_data(db, home, "alpha", output)
        assert result["chats"] == 1
        assert result["messages"] == 2
        assert result["images"] == 1
        assert output.stat().st_mode & 0o777 == 0o600

        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
            manifest = json.loads(archive.read("manifest.json"))
            chats = archive.read("chats/chat-history.jsonl").decode()
            payload = b"".join(archive.read(name) for name in names)
            assert manifest["format"] == "jarvis-local-data-v1"
            assert "generated files and arbitrary agent artifacts" in manifest["excluded"]
            assert "My synthetic hello" in chats
            assert "Synthetic reply" in chats
            assert "hidden private chat" not in chats
            assert "setup/SOUL.md" in names
            assert sum(name.startswith("uploads/") for name in names) == 1
            assert _IMAGE in payload
            for secret in (b"DO_NOT_EXPORT", b"SCHEDULE_SECRET", b"GENERATED_SECRET", b"HIDDEN_IMAGE"):
                assert secret not in payload
    finally:
        db.close()


def test_destination_is_new_and_outside_private_roots(tmp_path):
    home, db = _profile(tmp_path)
    try:
        with pytest.raises(ValueError, match="outside Jarvis"):
            export_consumer_local_data(db, home, "alpha", home / "private.zip")
        link = tmp_path / "linked.zip"
        link.symlink_to(tmp_path / "other.zip")
        with pytest.raises(ValueError, match="symbolic link"):
            export_consumer_local_data(db, home, "alpha", link)
        output = tmp_path / "local-data.zip"
        output.write_bytes(b"existing")
        with pytest.raises(ValueError, match="existing files"):
            export_consumer_local_data(db, home, "alpha", output)
        assert output.read_bytes() == b"existing"
        assert not list(tmp_path.glob(".jarvis-data-export-*.tmp"))
    finally:
        db.close()

    runtime_home = tmp_path / "desktop-profile" / "runtime"
    runtime_home.mkdir(parents=True)
    db = SessionDB(db_path=runtime_home / "state.db")
    try:
        with pytest.raises(ValueError, match="outside Jarvis"):
            export_consumer_local_data(db, runtime_home, "alpha", runtime_home.parent / "private.zip")
    finally:
        db.close()


def test_publish_race_preserves_competing_file(tmp_path, monkeypatch):
    from hermes_cli import consumer_local_data_export as bundle

    home, db = _profile(tmp_path)
    try:
        output = tmp_path / "raced.zip"
        real_link = bundle.os.link

        def competing_create(source, destination):
            output.write_bytes(b"competing file")
            return real_link(source, destination)

        monkeypatch.setattr(bundle.os, "link", competing_create)
        with pytest.raises(ValueError, match="existing files"):
            bundle.export_consumer_local_data(db, home, "alpha", output)
        assert output.read_bytes() == b"competing file"
        assert not list(tmp_path.glob(".jarvis-data-export-*.tmp"))
        assert not list(tmp_path.glob(".jarvis-data-stage-*"))
    finally:
        db.close()


def test_symlink_setup_is_skipped_and_corrupt_source_leaves_no_archive(tmp_path):
    home, db = _profile(tmp_path)
    try:
        (home / "SOUL.md").symlink_to(home / ".env")
        (home / ".env").write_text("SYMLINK_SECRET")
        output = tmp_path / "safe.zip"
        export_consumer_local_data(db, home, "alpha", output)
        with zipfile.ZipFile(output) as archive:
            assert "setup/SOUL.md" not in archive.namelist()
            assert b"SYMLINK_SECRET" not in b"".join(archive.read(n) for n in archive.namelist())

        (home / "config.yaml").write_text("display: [broken: yaml")
        with pytest.raises(yaml.YAMLError):
            export_consumer_local_data(db, home, "alpha", tmp_path / "corrupt.zip")
        assert not (tmp_path / "corrupt.zip").exists()
        assert not list(tmp_path.glob(".jarvis-data-export-*.tmp"))
        assert not list(tmp_path.glob(".jarvis-data-stage-*"))
    finally:
        db.close()


def test_foreign_chat_or_tampered_upload_fails_closed(tmp_path):
    home, db = _profile(tmp_path)
    try:
        db.create_session("foreign", source="desktop", profile_name="beta")
        with pytest.raises(PermissionError, match="profile mismatch"):
            export_consumer_local_data(db, home, "alpha", tmp_path / "foreign.zip")
        assert not (tmp_path / "foreign.zip").exists()
    finally:
        db.close()


def test_export_endpoint_requires_loopback_and_uses_selected_profile(tmp_path, monkeypatch):
    from hermes_cli.web_routers import sessions
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    homes = {}
    for name in ("alpha", "beta"):
        home, db = _profile(tmp_path / name, name)
        db.append_message("visible", "user", f"{name} profile marker")
        db.close()
        homes[name] = home
    monkeypatch.setattr(sessions, "_cron_profile_home", lambda name: (name, homes[name]))
    monkeypatch.setattr(sessions, "_open_session_db_for_profile",
                        lambda name, read_only: SessionDB(db_path=homes[name] / "state.db", read_only=read_only))

    headers = {_SESSION_HEADER_NAME: _SESSION_TOKEN}
    body = {"profile": "alpha", "output": str(tmp_path / "api-export.zip")}
    remote = TestClient(app, client=("198.51.100.8", 40000), headers=headers)
    refused = remote.post("/api/sessions/export-consumer-local-data", json=body)
    assert refused.status_code == 403
    assert not (tmp_path / "api-export.zip").exists()

    local = TestClient(app, client=("127.0.0.1", 40001), headers=headers)
    accepted = local.post("/api/sessions/export-consumer-local-data", json=body)
    assert accepted.status_code == 200
    blank = local.post("/api/sessions/export-consumer-local-data", json={
        "profile": " ", "output": str(tmp_path / "blank.zip")})
    assert blank.status_code == 409
    assert not (tmp_path / "blank.zip").exists()
    with zipfile.ZipFile(tmp_path / "api-export.zip") as archive:
        chats = archive.read("chats/chat-history.jsonl").decode()
    assert "alpha profile marker" in chats
    assert "beta profile marker" not in chats

    second, db = _profile(tmp_path / "second")
    try:
        record = record_uploaded_image(second, "visible", _IMAGE, ".png")
        blob = second / "consumer-artifacts" / record["blob_name"]
        blob.write_bytes(b"X" * len(_IMAGE))
        with pytest.raises(ValueError, match="digest"):
            export_consumer_local_data(db, second, "alpha", tmp_path / "tampered.zip")
        assert not (tmp_path / "tampered.zip").exists()
        assert not list(tmp_path.glob(".jarvis-data-export-*.tmp"))
    finally:
        db.close()
