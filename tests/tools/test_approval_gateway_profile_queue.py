"""A shared server must not exchange pending approval decisions between profile homes."""

import threading

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import approval
from tools.approval_gateway_wait import _await_gateway_decision


def test_pending_approvals_and_notifiers_stay_in_their_own_profile(tmp_path, monkeypatch):
    launch, secondary = tmp_path / "launch", tmp_path / "secondary"
    launch.mkdir()
    secondary.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(launch))
    session_key = "same-stored-session-id"
    ready = {"A": threading.Event(), "B": threading.Event()}
    results = {}
    errors = []

    def in_profile(home, fn):
        token = set_hermes_home_override(home)
        try:
            return fn()
        finally:
            reset_hermes_home_override(token)

    def wait_for(name, home):
        try:
            def run():
                approval.register_gateway_notify(session_key, lambda _data: None)
                assert approval._gateway_notify_cb(session_key) is not None
                results[name] = _await_gateway_decision(
                    session_key, lambda _data: ready[name].set(),
                    {"command": "same synthetic command", "description": name,
                     "pattern_key": "synthetic", "pattern_keys": ["synthetic"]},
                )
            in_profile(home, run)
        except BaseException as exc:
            errors.append(exc)

    first = threading.Thread(target=wait_for, args=("A", launch))
    second = threading.Thread(target=wait_for, args=("B", secondary))
    try:
        first.start()
        assert ready["A"].wait(10)
        second.start()
        assert ready["B"].wait(10)
        assert in_profile(launch, lambda: len(approval.list_gateway_approvals(session_key))) == 1
        assert in_profile(secondary, lambda: len(approval.list_gateway_approvals(session_key))) == 1

        assert in_profile(secondary, lambda: approval.resolve_gateway_approval(session_key, "deny")) == 1
        assert in_profile(launch, lambda: approval.has_blocking_approval(session_key))
        assert in_profile(launch, lambda: approval.resolve_gateway_approval(session_key, "once")) == 1
        first.join(10)
        second.join(10)
        assert not first.is_alive() and not second.is_alive()
        assert not errors
        assert results["A"]["choice"] == "once"
        assert results["B"]["choice"] == "deny"
        assert in_profile(launch, lambda: len(approval.gateway_approval_snapshot(session_key)["settled_request_ids"])) == 1
        assert in_profile(secondary, lambda: len(approval.gateway_approval_snapshot(session_key)["settled_request_ids"])) == 1
    finally:
        in_profile(launch, lambda: approval.unregister_gateway_notify(session_key))
        in_profile(secondary, lambda: approval.unregister_gateway_notify(session_key))
        first.join(10)
        second.join(10)
