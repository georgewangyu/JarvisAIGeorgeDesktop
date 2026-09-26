"""A quarantined OS wake can be restored only before an exact turn claim."""

import contextlib
from pathlib import Path

import pytest


def _profile(path: Path):
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    path.mkdir()
    (path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    receipt = admit_jarvis_event(
        path, source="calendar", event_id="same", text="Check once", queue_os_wake=True)
    return path, receipt


def _quarantine(home: Path, receipt: dict):
    from tui_gateway.headless_owner_event import _quarantine_wake_entry

    assert _quarantine_wake_entry(home, receipt["id"])
    return next((home / "runtime" / "jarvis_event_wake_quarantine").iterdir())


def _queue_ticket(home: Path, receipt: dict) -> Path:
    return home / "runtime" / "jarvis_event_wake" / receipt["id"]


def test_busy_lease_exit_requeues_only_the_exact_profile(tmp_path, monkeypatch):
    from hermes_cli.active_sessions import release_active_session, try_acquire_active_session
    from tui_gateway import server
    from tui_gateway.headless_owner_event import scan_one_wake_ticket
    from tui_gateway.owner_event_inbox import requeue_quarantined_jarvis_wake_ticket
    from tui_gateway.synthetic_turn import SyntheticHeavyAgent

    a, event = _profile(tmp_path / "a")
    b, other = _profile(tmp_path / "b")
    marker = _quarantine(a, event)
    _quarantine(b, other)
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=a)
    assert refusal is None
    try:
        with pytest.raises(ValueError, match="live lease"):
            requeue_quarantined_jarvis_wake_ticket(a, event["id"])
        assert marker.is_file() and not _queue_ticket(a, event).exists()
        with pytest.raises(ValueError, match="deferred"):
            requeue_quarantined_jarvis_wake_ticket(a, "0" * 64)
    finally:
        release_active_session(lease)

    assert requeue_quarantined_jarvis_wake_ticket(a, event["id"]) is True
    assert _queue_ticket(a, event).is_file()
    assert not marker.exists()
    assert _queue_ticket(b, other).exists() is False
    assert requeue_quarantined_jarvis_wake_ticket(a, event["id"]) is False
    assert requeue_quarantined_jarvis_wake_ticket(b, other["id"]) is True
    assert _queue_ticket(b, other).is_file()

    monkeypatch.setattr(server, "_profile_home", lambda name: {"a": a, "b": b}.get(name))
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_profile_build_scope", lambda _home: contextlib.nullcontext())
    monkeypatch.setattr(
        server, "_session_profile_runtime_scope", lambda _session: contextlib.nullcontext())
    agents = []

    def build(_sid, key, **_kwargs):
        agent = SyntheticHeavyAgent(key)
        agents.append(agent)
        return agent

    monkeypatch.setattr(server, "_make_agent_in_context", build)
    monkeypatch.setenv("HERMES_ISO_CERTIFY_DURATION_S", "0.01")
    assert scan_one_wake_ticket(
        "a", allow_headless=True, expected_profile_home=a, wait_seconds=10)["status"] == "settled"
    assert scan_one_wake_ticket(
        "b", allow_headless=True, expected_profile_home=b, wait_seconds=10)["status"] == "settled"
    assert scan_one_wake_ticket(
        "a", allow_headless=True, expected_profile_home=a) == {"status": "empty"}
    assert [agent.session_api_calls for agent in agents] == [1, 1]


@pytest.mark.parametrize("status", ["claimed", "settled", "unknown"])
def test_claimed_or_unknown_receipt_is_never_requeued(tmp_path, status):
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway.owner_event_inbox import requeue_quarantined_jarvis_wake_ticket

    home, event = _profile(tmp_path / "home")
    marker = _quarantine(home, event)
    with _locked(home) as root:
        receipt_path = root / f"{event['id']}.json"
        receipt = _read(receipt_path)
        receipt["status"] = status
        _write(receipt_path, receipt)
    with pytest.raises(ValueError, match="deferred"):
        requeue_quarantined_jarvis_wake_ticket(home, event["id"])
    assert marker.is_file() and not _queue_ticket(home, event).exists()


def test_requeue_rejects_symlink_and_public_quarantine(tmp_path):
    from tui_gateway.owner_event_inbox import requeue_quarantined_jarvis_wake_ticket

    home, event = _profile(tmp_path / "home")
    marker = _quarantine(home, event)
    marker.unlink()
    marker.symlink_to(home / "config.yaml")
    with pytest.raises(ValueError, match="opaque private"):
        requeue_quarantined_jarvis_wake_ticket(home, event["id"])
    marker.unlink()
    marker.touch(mode=0o600)
    quarantine = marker.parent
    quarantine.chmod(0o755)
    with pytest.raises(ValueError, match="private owned directory"):
        requeue_quarantined_jarvis_wake_ticket(home, event["id"])
    quarantine.chmod(0o700)
    elsewhere = tmp_path / "elsewhere"
    quarantine.rename(elsewhere)
    quarantine.symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError, match="private owned directory"):
        requeue_quarantined_jarvis_wake_ticket(home, event["id"])
    assert not _queue_ticket(home, event).exists()
