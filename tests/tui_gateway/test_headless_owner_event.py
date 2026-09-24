"""The opt-in event consumer uses real profile stores, leases and gateway turns."""

import contextlib
import threading
import time
import uuid

import pytest


def _profile(tmp_path, name):
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    home = tmp_path / name
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    return home, admit_jarvis_event(home, source="test", event_id="same", text="Check once")


def test_one_exact_event_across_a_b_a_with_no_idle_turn(tmp_path, monkeypatch):
    from tui_gateway import server
    from tui_gateway.headless_owner_event import run_one_deferred_event
    from tui_gateway.owner_event_inbox import owner_event_receipt
    from tui_gateway.synthetic_turn import SyntheticHeavyAgent

    a, a_event = _profile(tmp_path, "a")
    b, b_event = _profile(tmp_path, "b")
    from hermes_state import SessionDB
    check_db = SessionDB(db_path=a / "state.db", read_only=True)
    assert check_db.get_resume_conversations("main") == ([], [])
    check_db.close()
    homes = {"a": a, "b": b}
    monkeypatch.setattr(server, "_profile_home", lambda name: homes.get(name))
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_profile_build_scope", lambda _home: contextlib.nullcontext())
    monkeypatch.setattr(server, "_session_profile_runtime_scope", lambda _session: contextlib.nullcontext())
    agents = []

    def build(_sid, key, **_kwargs):
        agent = SyntheticHeavyAgent(key)
        agents.append(agent)
        return agent

    monkeypatch.setattr(server, "_make_agent_in_context", build)
    monkeypatch.setenv("HERMES_ISO_CERTIFY_DURATION_S", "0.01")
    with pytest.raises(ValueError, match="explicit opt-in"):
        run_one_deferred_event("a", a_event["id"])
    assert agents == []
    for name, delivery in (("a", a_event), ("b", b_event)):
        receipt = run_one_deferred_event(name, delivery["id"], allow_headless=True, wait_seconds=10)
        assert receipt["status"] == "settled"
        assert owner_event_receipt(homes[name], source="test", event_id="same")["status"] == "settled"
    with pytest.raises(ValueError, match="not deferred"):
        run_one_deferred_event("a", a_event["id"], allow_headless=True)
    assert [agent.session_api_calls for agent in agents] == [1, 1]


def test_claimed_or_ambiguous_event_never_replays(tmp_path, monkeypatch):
    from hermes_cli.active_sessions import try_acquire_active_session
    from tui_gateway import server
    from tui_gateway.headless_owner_event import run_one_deferred_event
    from tui_gateway.owner_event_inbox import claim_deferred_jarvis_event_for_headless_owner

    home, event = _profile(tmp_path, "a")
    monkeypatch.setattr(server, "_profile_home", lambda _name: home)
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="jarvis-event", config={}, registry_home=home,
        metadata={"live_session_id": "crashed", "jarvis_event_consumer": True})
    assert refusal is None
    owner = {"profile_home": str(home.resolve()), "session_id": "main",
             "lease_id": lease.lease_id, "live_session_id": "crashed"}
    try:
        with pytest.raises(RuntimeError, match="another owner"):
            run_one_deferred_event("a", event["id"], allow_headless=True)
        claim_deferred_jarvis_event_for_headless_owner(
            home, event["id"], owner, allow_headless=True)
    finally:
        lease.release()
    with pytest.raises(ValueError, match="not deferred"):
        run_one_deferred_event("a", event["id"], allow_headless=True)


def test_headless_source_has_no_poller_continuation_or_answering_client(tmp_path, monkeypatch):
    from tui_gateway import server
    from tui_gateway import server_requests

    session = {"source": "jarvis-event", "session_key": "main", "profile_home": str(tmp_path)}
    monkeypatch.setitem(server._sessions, "headless-test", session)
    started = []
    monkeypatch.setattr(server, "_start_notification_poller", lambda *_args: started.append("poll"))
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args: started.append("hook"))
    try:
        server._start_session_services("headless-test", "main", session)
        assert started == []
        assert server._maybe_schedule_auto_continue("headless-test", session, "main") is None
        assert server._session_client_answers_requests("headless-test") is False
        assert server_requests.send("approval", "headless-test", {}, timeout=0) is None
        assert server_requests.open_requests("headless-test") == []
    finally:
        server._sessions.pop("headless-test", None)


def test_runner_refuses_shared_gateway_and_invalid_profile(tmp_path):
    from tui_gateway import server
    from tui_gateway.headless_owner_event import run_one_deferred_event

    with pytest.raises(server.ProfileUnavailableError):
        server._profile_home(f"missing-headless-{uuid.uuid4().hex}")
    foreign = {"source": "desktop", "session_key": "other"}
    with server._sessions_lock:
        server._sessions["foreign"] = foreign
    try:
        with pytest.raises(RuntimeError, match="fresh gateway process"):
            run_one_deferred_event("default", "a" * 64, allow_headless=True)
        assert server._sessions["foreign"] is foreign
    finally:
        with server._sessions_lock:
            server._sessions.pop("foreign", None)


def test_direct_rpc_cannot_spoof_reserved_headless_source(tmp_path, monkeypatch):
    from tui_gateway import server

    home, _event = _profile(tmp_path, "a")
    monkeypatch.setattr(server, "_profile_home", lambda name: home if name == "a" else None)
    for method, params in (
        ("session.resume", {"session_id": "main", "profile": "a", "source": "jarvis-event",
                            "eager_build": True}),
        ("session.create", {"profile": "a", "source": "jarvis-event"}),
    ):
        response = server.handle_request({"jsonrpc": "2.0", "id": method, "method": method,
                                          "params": params})
        assert response["error"]["code"] == 4125
        assert server._sessions == {}
    with pytest.raises(ValueError, match="reserved"):
        server._init_session("spoofed", "main", object(), [], source="jarvis-event")
    assert server._sessions == {}


def test_timeout_keeps_lease_until_worker_exits(tmp_path, monkeypatch):
    from hermes_cli.active_sessions import active_session_registry_snapshot
    from tui_gateway import headless_owner_event, server
    from tui_gateway.owner_event_inbox import owner_event_receipt
    from tui_gateway.synthetic_turn import SyntheticHeavyAgent

    home, event = _profile(tmp_path, "a")
    monkeypatch.setattr(server, "_profile_home", lambda name: home if name == "a" else None)
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_profile_build_scope", lambda _home: contextlib.nullcontext())
    monkeypatch.setattr(server, "_session_profile_runtime_scope", lambda _session: contextlib.nullcontext())
    monkeypatch.setattr(server, "_make_agent_in_context", lambda _sid, key, **_kw: SyntheticHeavyAgent(key))
    monkeypatch.setattr(headless_owner_event, "_TURN_STOP_GRACE_SECONDS", 0.02)
    release_worker = threading.Event()

    def stalled_turn(_rid, _sid, session, _text, **_kwargs):
        worker = threading.Thread(target=release_worker.wait, daemon=True)
        session["_run_thread"] = worker
        worker.start()
        return True

    monkeypatch.setattr(server, "_run_prompt_submit", stalled_turn)
    receipt = headless_owner_event.run_one_deferred_event(
        "a", event["id"], allow_headless=True, wait_seconds=0.02)
    assert receipt["status"] == "claimed"
    assert owner_event_receipt(home, source="test", event_id="same")["status"] == "claimed"
    assert any(entry["session_id"] == "main" for entry in active_session_registry_snapshot(
        registry_home=home, strict=True))
    release_worker.set()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not any(entry["session_id"] == "main" for entry in active_session_registry_snapshot(
                registry_home=home, strict=True)):
            break
        time.sleep(0.01)
    else:
        pytest.fail("lease was not released after the worker exited")
    assert owner_event_receipt(home, source="test", event_id="same")["status"] == "claimed"


def test_compute_host_mode_refuses_before_claim_or_model_call(tmp_path, monkeypatch):
    from tui_gateway import server
    from tui_gateway.headless_owner_event import run_one_deferred_event
    from tui_gateway.owner_event_inbox import owner_event_receipt
    from tui_gateway.synthetic_turn import SyntheticHeavyAgent

    home, event = _profile(tmp_path, "a")
    monkeypatch.setattr(server, "_profile_home", lambda name: home if name == "a" else None)
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_profile_build_scope", lambda _home: contextlib.nullcontext())
    monkeypatch.setattr(server, "_session_profile_runtime_scope", lambda _session: contextlib.nullcontext())
    agents = []

    def build(_sid, key, **_kwargs):
        agent = SyntheticHeavyAgent(key)
        agents.append(agent)
        return agent

    monkeypatch.setattr(server, "_make_agent_in_context", build)
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    with pytest.raises(RuntimeError, match="compute-host"):
        run_one_deferred_event("a", event["id"], allow_headless=True)
    assert owner_event_receipt(home, source="test", event_id="same")["status"] == "deferred"
    assert [agent.session_api_calls for agent in agents] == [0]
    assert server._sessions == {}
