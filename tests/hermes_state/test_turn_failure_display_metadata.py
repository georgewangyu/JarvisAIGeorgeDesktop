"""A failed turn's display classification survives reopening its session DB."""

from hermes_state import SessionDB


def test_turn_failure_marks_only_current_matching_reply_and_keeps_metadata(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    try:
        db.create_session("s", source="desktop")
        assert not db.mark_latest_turn_failure("s", 1, {
            "layer": "provider", "code": "format_error", "retryable": False})
        old = db.append_message("s", "assistant", "same reply")
        user = db.append_message("s", "user", "new turn")
        assert not db.mark_latest_turn_failure("s", user, {
            "layer": "provider", "code": "format_error", "retryable": False})
        current = db.append_message("s", "assistant", "different saved failure", display_metadata={"reactions": []})
        assert db.mark_latest_turn_failure("s", user, {
            "layer": "provider", "code": "format_error", "retryable": False,
            "secret": "never persist this", "provider": "openai"})
        newer_user = db.append_message("s", "user", "later turn")
        assert not db.mark_latest_turn_failure("s", user, {
            "layer": "provider", "code": "auth", "retryable": False})
        assert not db.mark_latest_turn_failure("s", newer_user, {
            "layer": "provider", "code": "auth", "retryable": False})
    finally:
        db.close()

    import sqlite3
    import json

    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT id, display_metadata FROM messages WHERE id IN (?, ?) ORDER BY id", (old, current)).fetchall()
    assert rows[0][1] is None
    metadata = json.loads(rows[1][1])
    assert metadata == {"reactions": [], "turn_failure": {
        "layer": "provider", "code": "format_error", "retryable": False, "provider": "openai"}}
