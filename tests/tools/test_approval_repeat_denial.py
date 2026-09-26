"""An explicit refusal must not produce a second gateway card for the same action."""

import contextvars
import threading

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import approval
from tools.approval_context import (
    reset_current_observability_context,
    reset_current_session_key,
    set_current_observability_context,
    set_current_session_key,
)


def test_denied_gateway_command_is_not_asked_again_in_same_session(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    home.mkdir()
    (home / "config.yaml").write_text("approvals:\n  mode: manual\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.delenv("HERMES_SINGLE_QUERY", raising=False)
    session = "repeat-denial-fixture"
    command = "chmod 777 synthetic-file"
    notified = threading.Event()
    cards = []

    def ask(data):
        cards.append(data)
        notified.set()

    home_token = set_hermes_home_override(home)
    session_token = set_current_session_key(session)
    turn_tokens = set_current_observability_context(turn_id="first-user-turn")
    try:
        approval.register_gateway_notify(session, ask)
        result = {}

        def run_guard(target):
            result[target] = approval.check_all_command_guards(target, "local")

        worker = threading.Thread(target=contextvars.copy_context().run, args=(run_guard, command))
        worker.start()
        assert notified.wait(10)
        assert approval.resolve_gateway_approval(session, "deny") == 1
        worker.join(10)
        assert not worker.is_alive()
        assert result[command]["outcome"] == "denied"
        assert len(cards) == 1

        repeated = approval.check_all_command_guards(command, "local")
        assert repeated["approved"] is False
        assert repeated["outcome"] == "denied"
        assert repeated["user_consent"] is False
        assert len(cards) == 1
        assert approval.list_gateway_approvals(session) == []

        other_command = "chmod 777 other-synthetic-file"
        notified.clear()
        worker = threading.Thread(target=contextvars.copy_context().run, args=(run_guard, other_command))
        worker.start()
        assert notified.wait(10)
        assert approval.resolve_gateway_approval(session, "deny") == 1
        worker.join(10)
        assert not worker.is_alive()
        assert len(cards) == 2

        reset_current_observability_context(turn_tokens)
        turn_tokens = set_current_observability_context(turn_id="later-user-turn")
        notified.clear()
        worker = threading.Thread(target=contextvars.copy_context().run, args=(run_guard, command))
        worker.start()
        assert notified.wait(10)
        assert approval.resolve_gateway_approval(session, "deny") == 1
        worker.join(10)
        assert not worker.is_alive()
        assert len(cards) == 3

        approval.clear_session(session)
        notified.clear()
        worker = threading.Thread(target=contextvars.copy_context().run, args=(run_guard, command))
        worker.start()
        assert notified.wait(10)
        assert approval.resolve_gateway_approval(session, "deny") == 1
        worker.join(10)
        assert not worker.is_alive()
        assert len(cards) == 4
    finally:
        approval.unregister_gateway_notify(session)
        approval.clear_session(session)
        reset_current_observability_context(turn_tokens)
        reset_current_session_key(session_token)
        reset_hermes_home_override(home_token)


def test_denied_command_does_not_cross_profile_with_same_session_id(tmp_path, monkeypatch):
    homes = (tmp_path / "first", tmp_path / "second")
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text("approvals:\n  mode: manual\n", encoding="utf-8")
    monkeypatch.delenv("HERMES_GATEWAY_SESSION", raising=False)
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    session = "shared-denial-session"
    calls = []

    def deny(*_args, **_kwargs):
        calls.append("asked")
        return "deny"

    session_token = set_current_session_key(session)
    turn_tokens = set_current_observability_context(turn_id="same-model-turn")
    try:
        for home in (homes[0], homes[1], homes[0]):
            home_token = set_hermes_home_override(home)
            try:
                result = approval.check_all_command_guards("chmod 777 synthetic-file", "local", deny)
                assert result["approved"] is False
            finally:
                reset_hermes_home_override(home_token)
        assert calls == ["asked", "asked"]
    finally:
        for home in homes:
            home_token = set_hermes_home_override(home)
            try:
                approval.clear_session(session)
            finally:
                reset_hermes_home_override(home_token)
        reset_current_observability_context(turn_tokens)
        reset_current_session_key(session_token)
