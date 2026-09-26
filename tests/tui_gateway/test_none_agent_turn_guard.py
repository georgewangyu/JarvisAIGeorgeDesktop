"""A turn must never run against a session record whose agent is ``None``.

The deferred agent build can finish WITHOUT attaching an agent: when the record is replaced or
closed while the build runs, ``_build`` leaves early while its ``finally`` still sets
``agent_ready``.  Such a prompt used to reach the turn body, which dereferenced
``session["agent"]`` twice (``_invoke_agent`` and the turn's ``finally``) — the turn thread died
with ``running`` still True, the prompt vanished and the session stayed "busy" (#111531).
"""

from __future__ import annotations

import threading
import types

import pytest

from hermes_state import SessionDB
from tui_gateway import server
from tui_gateway.user_messages import AGENT_BUILD_ABANDONED


class _InlineThread:
    """Run the turn synchronously so tests observe its final state."""

    def __init__(self, target=None, daemon=None, args=(), kwargs=None, name=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


def _session(agent, **extra):
    return {
        "agent": agent, "agent_error": None, "session_key": "gw-session-key", "history": [],
        "history_lock": threading.RLock(), "history_version": 0, "running": True, "attached_images": [],
        "image_counter": 0, "cols": 80, "slash_worker": None, "show_reasoning": False,
        "tool_progress_mode": "all", "inflight_turn": None, **extra}


def _turn_env(monkeypatch, tmp_path) -> list:
    emitted: list[tuple] = []
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_emit", lambda event_type, sid, payload=None: emitted.append((event_type, sid, payload)))
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda sid, session: None)
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})
    return emitted


def test_turn_without_agent_is_refused_with_retryable_frame(monkeypatch, tmp_path):
    """The recorded build reason reaches the client as a retryable runtime frame; ``running`` is released."""
    emitted = _turn_env(monkeypatch, tmp_path)
    session = _session(None, agent_error=AGENT_BUILD_ABANDONED)

    assert server._run_prompt_submit("rid", "ui-sid", session, "继续") is False

    frames = [p for (t, _sid, p) in emitted if t == "message.complete"]
    assert len(frames) == 1
    assert frames[0]["status"] == "error" and frames[0]["recoverable"] is True
    assert frames[0]["error"] == AGENT_BUILD_ABANDONED
    assert frames[0]["error_surface"] == {"layer": "runtime", "code": "agent_init_failed", "retryable": True}
    assert session["running"] is False
    assert session["inflight_turn"]["status"] == "error"  # retained for session.resume

    # Control: a built agent still runs the turn to completion and clears the interim closure.
    agent = types.SimpleNamespace(
        session_id="agent-sid-1", run_conversation=lambda *a, **k: {"final_response": "done"},
        clear_interrupt=lambda: None)
    emitted.clear()
    server._run_prompt_submit("rid", "ui-sid", _session(agent), "go")
    assert [p["status"] for (t, _sid, p) in emitted if t == "message.complete"] == ["complete"]
    assert agent.interim_assistant_callback is None


def test_replaced_record_build_records_reason_and_leaves_agent_unset(monkeypatch, tmp_path):
    """A build whose record was swapped mid-flight sets ``agent_ready`` AND records why nothing attached."""
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_await_resume_history", lambda sid, current: False)

    sid = "replaced-record"
    session = _session(None, agent_ready=threading.Event(), cwd=str(tmp_path), profile_home=None)
    server._sessions[sid] = session
    try:
        server._start_agent_build(sid, session)
    finally:
        server._sessions.pop(sid, None)

    assert session["agent"] is None
    assert session["agent_ready"].is_set()
    assert session["agent_error"] == AGENT_BUILD_ABANDONED


@pytest.mark.parametrize("failure_path", ["deferred_build", "missing_agent"])
def test_accepted_init_failure_survives_store_reopen(monkeypatch, tmp_path, failure_path):
    emitted = _turn_env(monkeypatch, tmp_path)
    path = tmp_path / "state.db"
    db = SessionDB(path)
    db.create_session("gw-session-key", source="desktop")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)
    session = _session(None, agent_error=AGENT_BUILD_ABANDONED)
    server._persist_submit_user_row(session, "synthetic prompt", None)
    server._start_inflight_turn(session, "synthetic prompt")

    if failure_path == "deferred_build":
        session["agent_ready"] = threading.Event()
        session["agent_ready"].set()
        monkeypatch.setattr(server, "_session_info", lambda *args: {})
        server._run_after_agent_ready("rid", "ui-sid", session, "synthetic prompt", None, None, None)
    else:
        assert server._run_prompt_submit("rid", "ui-sid", session, "synthetic prompt") is False
    frames = [payload for kind, _, payload in emitted if kind == "message.complete"]
    assert len(frames) == 1
    assert frames[0]["status"] == "error"
    assert frames[0]["error_surface"]["code"] == "agent_init_failed"
    assert session["inflight_turn"]["status"] == "error"

    db.close()
    with SessionDB(path) as reopened:
        _, display = reopened.get_resume_conversations("gw-session-key")
    messages = server._history_to_messages(display)
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["text"] == "synthetic prompt"
    assert messages[1]["display_metadata"]["turn_failure"] == frames[0]["error_surface"]
    assert messages[1]["text"] == "The assistant could not start this turn."
    assert "gw-session-key" not in messages[1]["text"]


@pytest.mark.parametrize("later_role", ["assistant", "user"])
def test_init_failure_does_not_append_after_saved_reply_or_later_turn(monkeypatch, tmp_path, later_role):
    emitted = _turn_env(monkeypatch, tmp_path)
    path = tmp_path / "state.db"
    db = SessionDB(path)
    db.create_session("gw-session-key", source="desktop")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)
    session = _session(None, agent_error=AGENT_BUILD_ABANDONED)
    server._persist_submit_user_row(session, "synthetic prompt", None)
    db.append_message("gw-session-key", later_role, "already saved")
    server._start_inflight_turn(session, "synthetic prompt")

    assert server._run_prompt_submit("rid", "ui-sid", session, "synthetic prompt") is False
    assert len([kind for kind, _, _ in emitted if kind == "message.complete"]) == 1
    assert [(row["role"], row["content"]) for row in db.get_messages("gw-session-key")] == [
        ("user", "synthetic prompt"), (later_role, "already saved")]
    db.close()


def test_provider_init_failure_persists_safe_classification_not_raw_path(monkeypatch, tmp_path):
    _turn_env(monkeypatch, tmp_path)
    db = SessionDB(tmp_path / "state.db")
    db.create_session("gw-session-key", source="desktop")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)
    session = _session(None, agent_error=(
        "Hermes is not connected to any AI provider yet. "
        "Check SYNTHETIC_PRIVATE_PATH before retrying."))
    server._persist_submit_user_row(session, "synthetic prompt", None)
    server._start_inflight_turn(session, "synthetic prompt")

    assert server._run_prompt_submit("rid", "ui-sid", session, "synthetic prompt") is False
    saved = db.get_messages("gw-session-key")
    assert saved[-1]["role"] == "assistant"
    assert saved[-1]["content"] == "No inference provider is configured."
    assert "SYNTHETIC_PRIVATE_PATH" not in saved[-1]["content"]
    db.close()


def test_providerless_retry_keeps_one_failure_per_submitted_turn(monkeypatch, tmp_path):
    """A second send remains possible and does not rewrite the first turn's recovery row."""
    emitted = _turn_env(monkeypatch, tmp_path)
    path = tmp_path / "state.db"
    db = SessionDB(path)
    db.create_session("gw-session-key", source="desktop")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)
    session = _session(None, agent_error=AGENT_BUILD_ABANDONED)

    for prompt in ("first synthetic prompt", "second synthetic prompt"):
        session["running"] = True
        server._persist_submit_user_row(session, prompt, None)
        server._start_inflight_turn(session, prompt)
        assert server._run_prompt_submit("rid", "ui-sid", session, prompt) is False
        assert session["running"] is False

    frames = [payload for kind, _, payload in emitted if kind == "message.complete"]
    assert len(frames) == 2
    assert all(frame["error_surface"]["code"] == "agent_init_failed" for frame in frames)
    db.close()
    with SessionDB(path) as reopened:
        _, display = reopened.get_resume_conversations("gw-session-key")
    messages = server._history_to_messages(display)
    assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant"]
    assert [message["text"] for message in messages if message["role"] == "user"] == [
        "first synthetic prompt", "second synthetic prompt"]
    assert all(message["display_metadata"]["turn_failure"]["code"] == "agent_init_failed"
               for message in messages if message["role"] == "assistant")
