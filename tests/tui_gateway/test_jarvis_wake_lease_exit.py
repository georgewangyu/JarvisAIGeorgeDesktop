"""Orderly Desktop lease exit hands back only safe, exact Jarvis wake tickets."""

import threading

import pytest


def _home(path):
    from hermes_state import SessionDB
    from tui_gateway.headless_owner_event import _quarantine_wake_entry
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    path.mkdir()
    (path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.create_session(session_id="other", source="desktop")
    db.close()
    receipt = admit_jarvis_event(
        path, source="calendar", event_id="same", text="Check once", queue_os_wake=True)
    assert _quarantine_wake_entry(path, receipt["id"])
    return path, receipt


def _lease(home, session_id="main"):
    from hermes_cli.active_sessions import try_acquire_active_session

    lease, refusal = try_acquire_active_session(
        session_id=session_id, surface="desktop", config={}, registry_home=home,
        track_liveness=True)
    assert refusal is None and lease is not None
    return lease


def _session(home, lease, *, source="desktop"):
    return {
        "_sid": "live-desktop", "active_session_lease": lease, "agent": None,
        "history": [], "history_lock": threading.Lock(), "profile_home": str(home),
        "session_key": lease.session_id, "source": source,
    }


def _ticket(home, receipt):
    return home / "runtime" / "jarvis_event_wake" / receipt["id"]


@pytest.mark.parametrize("end_reason", ["tui_close", "ws_orphan_reap"])
def test_main_chat_lease_exit_requeues_only_its_profile(tmp_path, monkeypatch, end_reason):
    from tui_gateway import server

    a, receipt = _home(tmp_path / "a")
    b, other = _home(tmp_path / "b")
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: None)
    monkeypatch.setattr(server, "_announce_session_reclaimed", lambda *_args: None)
    lease = _lease(a)
    session = _session(a, lease)

    assert server._teardown_popped_session(session, end_reason=end_reason)
    assert lease.released
    assert _ticket(a, receipt).is_file()
    assert not _ticket(b, other).exists()
    assert server._requeue_jarvis_wakes_after_desktop_lease_exit(session, lease) is None
    assert _ticket(a, receipt).is_file()


def test_unrelated_desktop_chat_does_not_requeue(tmp_path, monkeypatch):
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: None)
    lease = _lease(home, "other")

    assert server._teardown_popped_session(_session(home, lease))
    assert lease.released
    assert not _ticket(home, receipt).exists()


def test_missing_profile_binding_does_not_requeue(tmp_path):
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    lease = _lease(home)
    session = _session(home, lease)
    session.pop("profile_home")
    lease.release()

    server._requeue_jarvis_wakes_after_desktop_lease_exit(session, lease)
    assert not _ticket(home, receipt).exists()


def test_unsettled_turn_does_not_requeue_on_shutdown(tmp_path, monkeypatch):
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: None)
    session = _session(home, _lease(home))
    session["_run_thread"] = threading.current_thread()

    assert server._teardown_popped_session(session, end_reason="tui_shutdown")
    assert not _ticket(home, receipt).exists()


@pytest.mark.parametrize("status", ["claimed", "unknown"])
def test_non_deferred_receipt_stays_quarantined(tmp_path, monkeypatch, status):
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: None)
    with _locked(home) as root:
        path = root / f"{receipt['id']}.json"
        record = _read(path)
        record["status"] = status
        _write(path, record)

    assert server._teardown_popped_session(_session(home, _lease(home)))
    assert not _ticket(home, receipt).exists()


def test_new_live_lease_refuses_handback_until_it_exits(tmp_path, monkeypatch):
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: None)
    old_lease = _lease(home)
    session = _session(home, old_lease)
    teardown = server._teardown_session
    new_owner = []

    def replace_owner_after_teardown(*args, **kwargs):
        teardown(*args, **kwargs)
        new_owner.append(_lease(home))

    monkeypatch.setattr(server, "_teardown_session", replace_owner_after_teardown)
    try:
        assert server._teardown_popped_session(session)
        assert not _ticket(home, receipt).exists()
    finally:
        new_owner[0].release()

    server._requeue_jarvis_wakes_after_desktop_lease_exit(session, old_lease)
    assert _ticket(home, receipt).is_file()


def test_delayed_compute_host_lease_settlement_requeues(tmp_path):
    from tui_gateway import server

    home, receipt = _home(tmp_path / "home")
    lease = _lease(home)
    session = _session(home, lease)
    session.pop("active_session_lease")
    session["_deferred_active_session_lease"] = lease
    server._deferred_active_session_leases[str(lease.lease_id)] = lease
    try:
        server._release_deferred_active_session_lease(session)
        assert lease.released
        assert _ticket(home, receipt).is_file()
        server._release_deferred_active_session_lease(session)
        assert _ticket(home, receipt).is_file()
    finally:
        server._deferred_active_session_leases.pop(str(lease.lease_id), None)
        lease.release()
