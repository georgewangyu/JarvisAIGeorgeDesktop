"""A consumer chat download never silently becomes a full profile backup."""

import json

import pytest


def test_consumer_chat_export_is_private_scoped_and_atomic(tmp_path):
    from hermes_cli.consumer_chat_export import export_consumer_chats
    from hermes_state import SessionDB

    home = tmp_path / "profile"
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("main", source="desktop")
        db.set_session_title("main", "Jarvis")
        db.append_message("main", "user", "Synthetic hello")
        db.append_message("main", "assistant", "Synthetic answer")
        db.create_session("hidden", source="desktop")
        db.set_session_hidden("hidden", True)
        db.append_message("hidden", "user", "Private worker text")
        db.create_session("internal", source="tool")
        db.append_message("internal", "user", "Tool-only text")

        output = tmp_path / "chat-history.jsonl"
        result = export_consumer_chats(db, home, output)
        assert result == {"output": str(output), "chats": 1, "messages": 2}
        assert output.stat().st_mode & 0o777 == 0o600
        records = [json.loads(line) for line in output.read_text().splitlines()]
        assert records[0]["format"] == "jarvis-chat-history-v1"
        assert records[1]["id"] == "main"
        assert [record["content"] for record in records[2:]] == ["Synthetic hello", "Synthetic answer"]
        assert "Private worker text" not in output.read_text()
        assert "Tool-only text" not in output.read_text()

        with pytest.raises(ValueError, match="outside Jarvis"):
            export_consumer_chats(db, home, home / "danger.jsonl")
        with pytest.raises(ValueError, match="absolute"):
            export_consumer_chats(db, home, "relative.jsonl")
        linked = tmp_path / "linked.jsonl"
        linked.symlink_to(output)
        with pytest.raises(ValueError, match="symbolic link"):
            export_consumer_chats(db, home, linked)
        original = output.read_bytes()
        with pytest.raises(ValueError, match="existing files are preserved"):
            export_consumer_chats(db, home, output)
        assert output.read_bytes() == original
        assert not list(tmp_path.glob(".jarvis-chat-export-*.tmp"))
    finally:
        db.close()


def test_chat_export_refuses_sibling_private_profile_and_publish_race(tmp_path, monkeypatch):
    from hermes_cli import consumer_chat_export
    from hermes_state import SessionDB

    private_root = tmp_path / ".hermes"
    home = private_root / "profiles" / "alpha"
    sibling = private_root / "profiles" / "beta"
    home.mkdir(parents=True)
    sibling.mkdir(parents=True)
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("visible", source="desktop")
        db.append_message("visible", "user", "Synthetic export race")
        with pytest.raises(ValueError, match="outside Jarvis"):
            consumer_chat_export.export_consumer_chats(db, home, sibling / "bad.jsonl")
        assert not (sibling / "bad.jsonl").exists()

        output = tmp_path / "chosen.jsonl"
        real_link = consumer_chat_export.os.link

        def competing_create(source, destination):
            output.write_text("another file won the race")
            return real_link(source, destination)

        monkeypatch.setattr(consumer_chat_export.os, "link", competing_create)
        with pytest.raises(ValueError, match="existing files are preserved"):
            consumer_chat_export.export_consumer_chats(db, home, output)
        assert output.read_text() == "another file won the race"
        assert not list(tmp_path.glob(".jarvis-chat-export-*.tmp"))
    finally:
        db.close()


def test_chat_export_endpoint_uses_selected_profile_database(tmp_path, monkeypatch):
    from hermes_cli.web_routers import sessions
    from hermes_state import SessionDB

    homes = {name: tmp_path / name for name in ("alpha", "beta")}
    for name, home in homes.items():
        home.mkdir()
        db = SessionDB(db_path=home / "state.db")
        db.create_session(f"{name}-chat", source="desktop")
        db.append_message(f"{name}-chat", "user", f"{name} synthetic content")
        db.close()

    monkeypatch.setattr(sessions, "_cron_profile_home", lambda name: (name, homes[name]))
    monkeypatch.setattr(sessions, "_open_session_db_for_profile",
                        lambda name, read_only: SessionDB(db_path=homes[name] / "state.db", read_only=read_only))

    alpha = tmp_path / "alpha.jsonl"
    beta = tmp_path / "beta.jsonl"
    assert sessions._export_consumer_chat_history(sessions.ConsumerChatExportRequest(
        profile="alpha", output=str(alpha)))["chats"] == 1
    assert sessions._export_consumer_chat_history(sessions.ConsumerChatExportRequest(
        profile="beta", output=str(beta)))["chats"] == 1
    assert "alpha synthetic content" in alpha.read_text()
    assert "beta synthetic content" not in alpha.read_text()
    assert "beta synthetic content" in beta.read_text()
    assert "alpha synthetic content" not in beta.read_text()


def test_authenticated_chat_export_route_refuses_private_data_directory(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from hermes_cli.web_routers import sessions
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
    from hermes_state import SessionDB

    home = tmp_path / "selected-profile"
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    db.create_session("visible", source="desktop")
    db.append_message("visible", "user", "Synthetic export route")
    db.close()
    monkeypatch.setattr(sessions, "_cron_profile_home", lambda name: (name, home))
    monkeypatch.setattr(sessions, "_open_session_db_for_profile",
                        lambda name, read_only: SessionDB(db_path=home / "state.db", read_only=read_only))
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

    refused = client.post("/api/sessions/export-consumer-chats", json={
        "profile": "selected-profile", "output": str(home / "bad.jsonl")})
    assert refused.status_code == 400
    assert not (home / "bad.jsonl").exists()

    output = tmp_path / "good.jsonl"
    accepted = client.post("/api/sessions/export-consumer-chats", json={
        "profile": "selected-profile", "output": str(output)})
    assert accepted.status_code == 200
    assert accepted.json()["chats"] == 1
    assert "Synthetic export route" in output.read_text()
