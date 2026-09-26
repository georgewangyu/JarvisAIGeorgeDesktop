"""An exact-owner event survives process restart and cannot be admitted twice."""

import json
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest


def test_settled_child_exit_hands_off_only_opted_in_deferred_event(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway import owner_event_inbox as inbox

    (tmp_path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    receipts = [inbox.admit_jarvis_event(
        tmp_path, source="test", event_id=name, text=name) for name in ("first", "second", "old")]
    with _locked(tmp_path) as root:
        first = _read(root / f"{receipts[0]['id']}.json")
        first.update(status="settled", headless_activation_requested=True)
        _write(root / f"{receipts[0]['id']}.json", first)
        second = _read(root / f"{receipts[1]['id']}.json")
        second["headless_activation_requested"] = True
        _write(root / f"{receipts[1]['id']}.json", second)
    activated = []
    monkeypatch.setattr(inbox, "activate_deferred_jarvis_event",
                        lambda _home, key, **_kwargs: activated.append(key))

    class Child:
        def __init__(self, exit_code):
            self.exit_code = exit_code

        def wait(self):
            return self.exit_code

    inbox._reap_and_activate_next(tmp_path, receipts[0]["id"], Child(1))
    assert activated == []
    inbox._reap_and_activate_next(tmp_path, receipts[0]["id"], Child(0))
    assert activated == [receipts[1]["id"]]
    (tmp_path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: false\n", encoding="utf-8")
    inbox._reap_and_activate_next(tmp_path, receipts[0]["id"], Child(0))
    assert activated == [receipts[1]["id"]]


def test_preclaim_child_failure_marks_exact_attempt_and_advances_one_sibling(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway import owner_event_inbox as inbox

    (tmp_path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    first, second = [inbox.admit_jarvis_event(
        tmp_path, source="test", event_id=name, text=name) for name in ("first", "second")]
    with _locked(tmp_path) as root:
        for receipt in (first, second):
            path = root / f"{receipt['id']}.json"
            record = _read(path)
            record.update(headless_activation_requested=True, headless_activation_attempt=receipt["id"])
            _write(path, record)

    activated = []
    monkeypatch.setattr(inbox, "activate_deferred_jarvis_event",
                        lambda _home, key, **_kwargs: activated.append(key))

    class FailedChild:
        def wait(self):
            return 7

    inbox._reap_and_activate_next(tmp_path, first["id"], FailedChild(), first["id"])
    assert activated == [second["id"]]
    assert inbox._next_opted_in_deferred_event(tmp_path) == second["id"]
    with _locked(tmp_path) as root:
        failed = _read(root / f"{first['id']}.json")
    assert failed["status"] == "deferred"
    assert failed["headless_activation_failed_exit_code"] == 7
    assert failed["headless_activation_failed_count"] == 1

    # A duplicate or a stale reaper cannot launch another sibling or overwrite
    # a newer attempt; claimed/unknown and missing receipts remain untouched.
    inbox._reap_and_activate_next(tmp_path, first["id"], FailedChild(), first["id"])
    assert activated == [second["id"]]
    with _locked(tmp_path) as root:
        path = root / f"{first['id']}.json"
        failed = _read(path)
        failed.pop("headless_activation_failed_exit_code")
        failed["headless_activation_attempt"] = "new-attempt"
        _write(path, failed)
    inbox._reap_and_activate_next(tmp_path, first["id"], FailedChild(), first["id"])
    assert activated == [second["id"]]
    with _locked(tmp_path) as root:
        claimed = _read(path)
        claimed["status"] = "claimed"
        _write(path, claimed)
    inbox._reap_and_activate_next(tmp_path, first["id"], FailedChild(), "new-attempt")
    inbox._reap_and_activate_next(tmp_path, "missing", FailedChild(), "missing")
    assert activated == [second["id"]]


def test_settled_sibling_retries_one_preclaim_failure_but_not_two(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway import owner_event_inbox as inbox

    (tmp_path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    settled, raced = [inbox.admit_jarvis_event(
        tmp_path, source="test", event_id=name, text=name) for name in ("settled", "raced")]
    with _locked(tmp_path) as root:
        first = _read(root / f"{settled['id']}.json")
        first["status"] = "settled"
        _write(root / f"{settled['id']}.json", first)
        second = _read(root / f"{raced['id']}.json")
        second.update(headless_activation_requested=True,
                      headless_activation_failed_exit_code=1,
                      headless_activation_failed_count=1)
        _write(root / f"{raced['id']}.json", second)
    activated = []
    monkeypatch.setattr(inbox, "activate_deferred_jarvis_event",
                        lambda _home, key, **_kwargs: activated.append(key))

    class SettledChild:
        def wait(self):
            return 0

    assert inbox._next_opted_in_deferred_event(tmp_path) is None
    inbox._reap_and_activate_next(tmp_path, settled["id"], SettledChild())
    assert activated == [raced["id"]]
    with _locked(tmp_path) as root:
        second = _read(root / f"{raced['id']}.json")
        second["headless_activation_failed_count"] = 2
        _write(root / f"{raced['id']}.json", second)
    inbox._reap_and_activate_next(tmp_path, settled["id"], SettledChild())
    assert activated == [raced["id"]]


def test_owner_event_admission_is_durable_and_exact(tmp_path):
    from tui_gateway.owner_event_inbox import admit_owner_event, owner_event_receipt
    from tools.bot_live_delivery import claim_pending_delivery, complete_delivery

    owner = dict(profile_home=str(tmp_path.resolve()), session_id="chat",
                 lease_id="lease", live_session_id="live")
    queued = admit_owner_event(tmp_path, owner, source="scheduler", event_id="tick-7", text="check progress")
    assert queued["status"] == "queued"
    assert admit_owner_event(tmp_path, owner, source="scheduler", event_id="tick-7", text="check progress") == queued
    with pytest.raises(ValueError):
        admit_owner_event(tmp_path, owner, source="scheduler", event_id="tick-7", text="changed")
    with pytest.raises(ValueError):
        admit_owner_event(tmp_path, dict(owner, lease_id="new"), source="scheduler",
                          event_id="tick-7", text="check progress")
    assert claim_pending_delivery(tmp_path, dict(owner, lease_id="new")) is None

    script = (
        "import json,sys; from tui_gateway.owner_event_inbox import owner_event_receipt; "
        "from tools.bot_live_delivery import claim_pending_delivery; "
        "home=sys.argv[1]; owner=json.loads(sys.argv[2]); "
        "print(json.dumps([owner_event_receipt(home,source='scheduler',event_id='tick-7'), "
        "claim_pending_delivery(home,owner)]))"
    )
    observed = subprocess.run([sys.executable, "-c", script, str(tmp_path), json.dumps(owner)],
                              check=True, capture_output=True, text=True)
    persisted, claimed = json.loads(observed.stdout)
    assert persisted == queued
    assert claimed["id"] == queued["id"]

    assert owner_event_receipt(tmp_path, source="scheduler", event_id="tick-7")["status"] == "claimed"
    assert claim_pending_delivery(tmp_path, owner) is None
    receipt = complete_delivery(tmp_path, queued["id"], status="settled", reply="done")
    assert owner_event_receipt(tmp_path, source="scheduler", event_id="tick-7") == receipt
    assert admit_owner_event(tmp_path, owner, source="scheduler", event_id="tick-7", text="check progress") == receipt
    assert owner_event_receipt(tmp_path, source="scheduler", event_id="tick-8") is None


def test_jarvis_event_defers_without_a_live_desktop_owner(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, adopt_deferred_jarvis_events, owner_event_receipt,
    )

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    deferred = admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")
    assert deferred["status"] == "deferred" and "owner" not in deferred
    assert claim_pending_delivery(tmp_path, dict(profile_home=str(tmp_path.resolve()), session_id="main",
                                                 lease_id="wrong", live_session_id="wrong")) is None
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        owner = find_jarvis_live_owner(tmp_path)
        assert owner and owner["lease_id"] == lease.lease_id
        assert adopt_deferred_jarvis_events(tmp_path, dict(owner, lease_id="wrong")) == 0
        assert adopt_deferred_jarvis_events(tmp_path, owner) == 1
        assert adopt_deferred_jarvis_events(tmp_path, owner) == 0
        admitted = admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")
        assert admitted["status"] == "queued" and admitted["id"] == deferred["id"]
        assert admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today") == admitted
        assert claim_pending_delivery(tmp_path, owner)["id"] == admitted["id"]
    finally:
        lease.release()
        db.close()
    assert owner_event_receipt(tmp_path, source="calendar", event_id="one")["status"] == "claimed"
    assert admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")["id"] == admitted["id"]
    with pytest.raises(ValueError, match="different payload"):
        admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Changed event")
    assert admit_jarvis_event(tmp_path, source="calendar", event_id="two",
                              text="Review tomorrow")["status"] == "deferred"


def test_offline_jarvis_event_is_adopted_by_restarted_idle_poller(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tui_gateway import session_notifications
    from tui_gateway.method_ctx import rebind
    from tui_gateway.owner_event_inbox import admit_jarvis_event, owner_event_receipt
    from tui_gateway.session_lifecycle import _session_turn_admission

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    deferred = admit_jarvis_event(tmp_path, source="calendar", event_id="offline", text="Review today")
    assert deferred["status"] == "deferred"
    observed = subprocess.run([
        sys.executable, "-c",
        "import json,sys; from tui_gateway.owner_event_inbox import owner_event_receipt; "
        "print(json.dumps(owner_event_receipt(sys.argv[1],source='calendar',event_id='offline')))",
        str(tmp_path),
    ], check=True, capture_output=True, text=True)
    assert json.loads(observed.stdout)["status"] == "deferred"
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "restarted", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    calls = []

    def submit(_rid, _sid, _session, text, **kwargs):
        calls.append(text)
        kwargs["terminal_callback"]({"status": "settled", "text": "One concise result"})
        return True

    poll = rebind(session_notifications._poll_bot_live_delivery_once, {
        "_session_home": lambda _session: tmp_path,
        "_session_turn_admission": _session_turn_admission,
        "_run_prompt_submit": submit,
        "_notif_release_turn": lambda session: session.update(running=False),
    })
    session = {"source": "desktop", "history_lock": threading.RLock(), "agent": object(),
               "session_key": "main", "active_session_lease": SimpleNamespace(
                   lease_id=lease.lease_id, released=False)}
    try:
        assert poll("restarted", session) is True
        assert poll("restarted", session) is False
        assert calls == ["[Event from calendar; id offline]\nReview today"]
        assert owner_event_receipt(tmp_path, source="calendar", event_id="offline")["status"] == "settled"
    finally:
        lease.release()
        db.close()


@pytest.mark.parametrize("title,source,consumer", [
    ("Side chat", "desktop", True),
    ("Jarvis", "cli", True),
    ("Jarvis", "desktop", False),
])
def test_jarvis_event_refuses_lookalike_or_nonconsumer_owner(tmp_path, title, source, consumer):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="lookalike", source=source)
    db.set_session_title("lookalike", title)
    lease, refusal = try_acquire_active_session(
        session_id="lookalike", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": consumer},
    )
    assert refusal is None
    try:
        assert find_jarvis_live_owner(tmp_path) is None
        if title == "Jarvis" and source == "desktop":
            assert admit_jarvis_event(tmp_path, source="calendar", event_id="one",
                                      text="Review today")["status"] == "deferred"
        else:
            with pytest.raises(RuntimeError, match="no desktop owner"):
                admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")
    finally:
        lease.release()
        db.close()


def test_archived_jarvis_chat_cannot_receive_offline_events(tmp_path):
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.set_session_archived("main", True)
    db.close()
    with pytest.raises(RuntimeError, match="no desktop owner"):
        admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")


def test_deferred_jarvis_events_remain_in_their_own_profile(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, adopt_deferred_jarvis_events, owner_event_receipt,
    )

    homes = [tmp_path / "profile-a", tmp_path / "profile-b"]
    for home in homes:
        home.mkdir()
        db = SessionDB(db_path=home / "state.db")
        db.create_session(session_id="main", source="desktop")
        db.set_session_title("main", "Jarvis")
        db.close()
        assert admit_jarvis_event(home, source="calendar", event_id="same-id",
                                  text="Profile-local reminder")["status"] == "deferred"
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=homes[0],
        metadata={"live_session_id": "runtime-a", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        owner_a = {"profile_home": str(homes[0].resolve()), "session_id": "main",
                   "lease_id": lease.lease_id, "live_session_id": "runtime-a"}
        assert adopt_deferred_jarvis_events(homes[0], owner_a) == 1
        with pytest.raises(ValueError, match="different profile home"):
            adopt_deferred_jarvis_events(homes[1], owner_a)
        assert owner_event_receipt(homes[1], source="calendar", event_id="same-id")["status"] == "deferred"
        assert owner_event_receipt(homes[0], source="calendar", event_id="same-id")["status"] == "queued"
    finally:
        lease.release()


def test_headless_event_claim_is_exact_profile_and_not_replayed_after_crash(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, claim_deferred_jarvis_event_for_headless_owner,
        owner_event_receipt,
    )

    homes = [tmp_path / name for name in ("a", "b")]
    for home in homes:
        home.mkdir()
        db = SessionDB(db_path=home / "state.db")
        db.create_session(session_id="main", source="desktop")
        db.set_session_title("main", "Jarvis")
        db.close()
        admit_jarvis_event(home, source="calendar", event_id="same", text="Check")

    a_id = owner_event_receipt(homes[0], source="calendar", event_id="same")["id"]
    child = (
        "import json,os,sys; "
        "from hermes_cli.active_sessions import try_acquire_active_session; "
        "from tui_gateway.owner_event_inbox import claim_deferred_jarvis_event_for_headless_owner; "
        "home=sys.argv[1]; delivery_id=sys.argv[2]; "
        "lease, refusal=try_acquire_active_session(session_id='main',surface='jarvis-event',"
        "config={},registry_home=home,metadata={'live_session_id':'child',"
        "'jarvis_event_consumer':True}); "
        "assert refusal is None; "
        "owner={'profile_home':os.path.realpath(home),'session_id':'main',"
        "'lease_id':lease.lease_id,'live_session_id':'child'}; "
        "claimed=claim_deferred_jarvis_event_for_headless_owner(home,delivery_id,owner,"
        "allow_headless=True); print(json.dumps(claimed),flush=True); os._exit(0)"
    )
    crashed = subprocess.run([sys.executable, "-c", child, str(homes[0]), a_id],
                             check=True, capture_output=True, text=True)
    assert json.loads(crashed.stdout)["status"] == "claimed"
    assert owner_event_receipt(homes[0], source="calendar", event_id="same")["status"] == "claimed"
    assert owner_event_receipt(homes[1], source="calendar", event_id="same")["status"] == "deferred"

    for home in (homes[1], homes[0]):  # A → B → A after the first owner's crash.
        lease, refusal = try_acquire_active_session(
            session_id="main", surface="jarvis-event", config={}, registry_home=home,
            metadata={"live_session_id": "replacement", "jarvis_event_consumer": True},
        )
        assert refusal is None
        owner = dict(profile_home=str(home.resolve()), session_id="main",
                     lease_id=lease.lease_id, live_session_id="replacement")
        delivery_id = owner_event_receipt(home, source="calendar", event_id="same")["id"]
        try:
            with pytest.raises(ValueError, match="explicit opt-in"):
                claim_deferred_jarvis_event_for_headless_owner(home, delivery_id, owner)
            with pytest.raises(ValueError, match="different profile home"):
                claim_deferred_jarvis_event_for_headless_owner(
                    homes[1] if home == homes[0] else homes[0], delivery_id, owner,
                    allow_headless=True,
                )
            if home == homes[1]:
                assert claim_deferred_jarvis_event_for_headless_owner(
                    home, delivery_id, owner, allow_headless=True)["status"] == "claimed"
            with pytest.raises(ValueError, match="not deferred"):
                claim_deferred_jarvis_event_for_headless_owner(
                    home, delivery_id, owner, allow_headless=True)
        finally:
            lease.release()
    assert all(owner_event_receipt(home, source="calendar", event_id="same")["status"] == "claimed"
               for home in homes)


def test_jarvis_event_admission_to_idle_turn_and_restart_receipt(tmp_path):
    """Real DB/lease/mailbox/poller wiring; only the model dispatch is synthetic."""
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tui_gateway import session_notifications
    from tui_gateway.method_ctx import rebind
    from tui_gateway.owner_event_inbox import admit_jarvis_event, owner_event_receipt
    from tui_gateway.session_lifecycle import _session_turn_admission

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    calls = []

    def submit(_rid, _sid, _session, text, **kwargs):
        calls.append(text)
        kwargs["terminal_callback"]({"status": "settled", "text": "One concise result"})
        return True

    poll = rebind(session_notifications._poll_bot_live_delivery_once, {
        "_session_home": lambda _session: tmp_path,
        "_session_turn_admission": _session_turn_admission,
        "_run_prompt_submit": submit,
        "_notif_release_turn": lambda session: session.update(running=False),
    })
    session = {"source": "desktop", "history_lock": threading.RLock(), "agent": object(),
               "session_key": "main", "active_session_lease": SimpleNamespace(
                   lease_id=lease.lease_id, released=False)}
    try:
        # A sleeping poll does no model work, even after a mailbox has existed.
        assert poll("runtime", session) is False
        assert calls == []
        first = admit_jarvis_event(tmp_path, source="calendar", event_id="synthetic-1", text="Check the date")
        assert poll("runtime", session) is True
        assert calls == ["[Event from calendar; id synthetic-1]\nCheck the date"]
        receipt = owner_event_receipt(tmp_path, source="calendar", event_id="synthetic-1")
        assert receipt["id"] == first["id"] and receipt["status"] == "settled"
        assert receipt["reply"] == "One concise result"
        assert poll("runtime", session) is False
        assert len(calls) == 1
    finally:
        lease.release()
        db.close()

    observed = subprocess.run([
        sys.executable, "-c",
        "import json,sys; from tui_gateway.owner_event_inbox import owner_event_receipt; "
        "print(json.dumps(owner_event_receipt(sys.argv[1],source='calendar',event_id='synthetic-1')))",
        str(tmp_path),
    ], check=True, capture_output=True, text=True)
    assert json.loads(observed.stdout)["status"] == "settled"


def test_interrupted_jarvis_claim_is_reported_without_replay(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, complete_delivery, find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, interrupted_jarvis_event_receipts, owner_event_receipt,
    )

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")

    def acquire(live_id):
        lease, refusal = try_acquire_active_session(
            session_id="main", surface="desktop", config={}, registry_home=tmp_path,
            metadata={"live_session_id": live_id, "bot_live_delivery_consumer": True},
        )
        assert refusal is None
        return lease

    first_lease = acquire("first-runtime")
    try:
        first = admit_jarvis_event(tmp_path, source="calendar", event_id="first", text="Check event")
        owner = find_jarvis_live_owner(tmp_path)
        assert claim_pending_delivery(tmp_path, owner)["id"] == first["id"]
        assert interrupted_jarvis_event_receipts(tmp_path) == []  # The old owner is still live.
    finally:
        first_lease.release()

    assert interrupted_jarvis_event_receipts(tmp_path) == []  # No replacement owner yet.
    second_lease = acquire("second-runtime")
    try:
        unknown = interrupted_jarvis_event_receipts(tmp_path)
        assert unknown == [{
            "delivery_id": first["id"],
            "claimed_at": owner_event_receipt(tmp_path, source="calendar", event_id="first")["claimed_at"],
            "status": "outcome_unknown",
        }]
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path)) is None
        assert owner_event_receipt(tmp_path, source="calendar", event_id="first")["status"] == "claimed"

        next_event = admit_jarvis_event(tmp_path, source="calendar", event_id="second", text="New event")
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path))["id"] == next_event["id"]
        complete_delivery(tmp_path, next_event["id"], status="settled", reply="Done")
        assert interrupted_jarvis_event_receipts(tmp_path) == unknown

        other_home = tmp_path / "other-profile"
        other_home.mkdir()
        other_db = SessionDB(db_path=other_home / "state.db")
        other_db.create_session(session_id="main", source="desktop")
        other_db.set_session_title("main", "Jarvis")
        other_lease, refusal = try_acquire_active_session(
            session_id="main", surface="desktop", config={}, registry_home=other_home,
            metadata={"live_session_id": "other-runtime", "bot_live_delivery_consumer": True},
        )
        assert refusal is None
        try:
            assert interrupted_jarvis_event_receipts(other_home) == []
            assert interrupted_jarvis_event_receipts(tmp_path) == unknown
        finally:
            other_lease.release()
            other_db.close()
    finally:
        second_lease.release()
        db.close()


def test_reviewed_jarvis_retry_has_new_durable_identity_and_runs_at_most_once(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, complete_delivery, find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, interrupted_jarvis_event_receipts, owner_event_receipt,
        review_interrupted_jarvis_event,
        retry_interrupted_jarvis_event,
    )

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")

    def acquire(live_id):
        lease, refusal = try_acquire_active_session(
            session_id="main", surface="desktop", config={}, registry_home=tmp_path,
            metadata={"live_session_id": live_id, "bot_live_delivery_consumer": True},
        )
        assert refusal is None
        return lease

    old_lease = acquire("old-runtime")
    try:
        original = admit_jarvis_event(tmp_path, source="synthetic", event_id="first", text="Review a test plan")
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path))["id"] == original["id"]
        with pytest.raises(ValueError, match="interrupted Jarvis owner"):
            review_interrupted_jarvis_event(tmp_path, original["id"])
    finally:
        old_lease.release()

    with pytest.raises(ValueError, match="not open"):
        review_interrupted_jarvis_event(tmp_path, original["id"])
    new_lease = acquire("new-runtime")
    try:
        reviewed = review_interrupted_jarvis_event(tmp_path, original["id"])
        assert reviewed["message"] == original["message"]
        assert reviewed["status"] == "outcome_unknown"
        with pytest.raises(ValueError, match="review it again"):
            retry_interrupted_jarvis_event(tmp_path, original["id"], "wrong")
        queued = retry_interrupted_jarvis_event(tmp_path, original["id"], reviewed["review_digest"])
        assert queued["status"] == "queued" and queued["delivery_id"] != original["id"]
        assert interrupted_jarvis_event_receipts(tmp_path)[0]["retry_status"] == "queued"
        assert retry_interrupted_jarvis_event(tmp_path, original["id"], reviewed["review_digest"]) == queued
        assert owner_event_receipt(tmp_path, source="synthetic", event_id="first")["status"] == "claimed"
        claimed = claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path))
        assert claimed["id"] == queued["delivery_id"]
        assert claimed["message"] == original["message"]
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path)) is None
        complete_delivery(tmp_path, claimed["id"], status="settled", reply="Test-only result")
        assert interrupted_jarvis_event_receipts(tmp_path)[0]["retry_status"] == "settled"
        assert retry_interrupted_jarvis_event(tmp_path, original["id"], reviewed["review_digest"]) == {
            "delivery_id": queued["delivery_id"], "status": "settled"}
    finally:
        new_lease.release()
        db.close()


def test_interrupted_retry_refuses_if_original_settles_after_review(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, complete_delivery, find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import (
        admit_jarvis_event, review_interrupted_jarvis_event, retry_interrupted_jarvis_event,
    )

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    old_lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "old", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        original = admit_jarvis_event(tmp_path, source="synthetic", event_id="first", text="Check")
        claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path))
    finally:
        old_lease.release()
    new_lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "new", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        reviewed = review_interrupted_jarvis_event(tmp_path, original["id"])
        complete_delivery(tmp_path, original["id"], status="settled", reply="Already done")
        with pytest.raises(ValueError, match="no longer awaits review"):
            retry_interrupted_jarvis_event(tmp_path, original["id"], reviewed["review_digest"])
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path)) is None
    finally:
        new_lease.release()
        db.close()
