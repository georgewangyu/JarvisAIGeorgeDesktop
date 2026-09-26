"""One-shot wake tickets use the real profile, lease, claim and turn path."""

import contextlib
from pathlib import Path

import pytest


def _profile(tmp_path: Path, name: str, *, wake: bool = True):
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    home = tmp_path / name
    home.mkdir()
    (home / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=home / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    receipt = admit_jarvis_event(
        home, source="test", event_id="same", text="Check once", queue_os_wake=wake)
    return home, receipt


def _ticket(home: Path, receipt: dict) -> Path:
    return home / "runtime" / "jarvis_event_wake" / receipt["id"]


def _synthetic_gateway(monkeypatch, homes):
    from tui_gateway import server
    from tui_gateway.synthetic_turn import SyntheticHeavyAgent

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
    return agents


def test_wake_ticket_settles_once_and_retires_exact_ticket(tmp_path, monkeypatch):
    from tui_gateway.headless_owner_event import run_one_wake_ticket

    home, event = _profile(tmp_path, "a")
    agents = _synthetic_gateway(monkeypatch, {"a": home})
    ticket = _ticket(home, event)
    with pytest.raises(ValueError, match="explicit opt-in"):
        run_one_wake_ticket("a", event["id"])
    assert ticket.exists() and agents == []

    result = run_one_wake_ticket(
        "a", event["id"], allow_headless=True, expected_profile_home=home,
        wait_seconds=10)
    assert result["status"] == "settled"
    assert not ticket.exists()
    assert [agent.session_api_calls for agent in agents] == [1]
    with pytest.raises(FileNotFoundError):
        run_one_wake_ticket("a", event["id"], allow_headless=True)
    assert [agent.session_api_calls for agent in agents] == [1]


def test_claimed_and_terminal_leftover_tickets_retire_without_replay(tmp_path, monkeypatch):
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway.headless_owner_event import run_one_wake_ticket

    home, event = _profile(tmp_path, "a")
    agents = _synthetic_gateway(monkeypatch, {"a": home})
    path = _ticket(home, event)
    with _locked(home) as root:
        receipt_path = root / f"{event['id']}.json"
        receipt = _read(receipt_path)
        receipt["status"] = "claimed"
        _write(receipt_path, receipt)
    with pytest.raises(ValueError, match="no exact opted-in"):
        run_one_wake_ticket("a", event["id"], allow_headless=True)
    assert not path.exists() and agents == []

    # Simulate death after a completed receipt was written but before cleanup.
    path.touch(mode=0o600)
    with _locked(home) as root:
        receipt = _read(receipt_path)
        receipt["status"] = "settled"
        _write(receipt_path, receipt)
    with pytest.raises(ValueError, match="no exact opted-in"):
        run_one_wake_ticket("a", event["id"], allow_headless=True)
    assert not path.exists() and agents == []


def test_invalid_terminal_ticket_is_preserved_without_masking_validation(tmp_path, monkeypatch):
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway.headless_owner_event import run_one_wake_ticket

    home, event = _profile(tmp_path, "a")
    agents = _synthetic_gateway(monkeypatch, {"a": home})
    ticket = _ticket(home, event)
    ticket.unlink()
    ticket.symlink_to(home / "config.yaml")
    with _locked(home) as root:
        receipt_path = root / f"{event['id']}.json"
        receipt = _read(receipt_path)
        receipt["status"] = "settled"
        _write(receipt_path, receipt)
    with pytest.raises(ValueError, match="opaque private"):
        run_one_wake_ticket("a", event["id"], allow_headless=True)
    assert ticket.is_symlink() and agents == []


def test_inert_and_stale_tickets_do_not_start_turn(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked
    from tui_gateway.headless_owner_event import run_one_wake_ticket

    home, event = _profile(tmp_path, "a")
    agents = _synthetic_gateway(monkeypatch, {"a": home})
    ticket = _ticket(home, event)
    with _locked(home) as root:
        (root / f"{event['id']}.json").unlink()
    with pytest.raises(ValueError, match="no exact opted-in"):
        run_one_wake_ticket("a", event["id"], allow_headless=True)
    assert ticket.exists() and agents == []

    other_home, other_event = _profile(tmp_path, "stale")
    homes = {"a": home, "stale": other_home}
    _synthetic_gateway(monkeypatch, homes)
    db = SessionDB(db_path=other_home / "state.db")
    db.set_session_archived("main", True)
    db.close()
    with pytest.raises(ValueError, match="no exact opted-in"):
        run_one_wake_ticket("stale", other_event["id"], allow_headless=True)
    assert _ticket(other_home, other_event).exists()


def test_ticket_cannot_authorize_same_id_in_other_profile(tmp_path, monkeypatch):
    from tui_gateway.headless_owner_event import run_one_wake_ticket

    a, a_event = _profile(tmp_path, "a")
    b, b_event = _profile(tmp_path, "b", wake=False)
    assert a_event["id"] == b_event["id"]
    agents = _synthetic_gateway(monkeypatch, {"a": a, "b": b})
    with pytest.raises(FileNotFoundError):
        run_one_wake_ticket("b", a_event["id"], allow_headless=True)
    with pytest.raises(ValueError, match="exact event home"):
        run_one_wake_ticket(
            "a", a_event["id"], allow_headless=True, expected_profile_home=b)
    assert agents == []
    assert _ticket(a, a_event).exists()
