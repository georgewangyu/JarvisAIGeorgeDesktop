"""An exact-owner event survives process restart and cannot be admitted twice."""

import json
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest


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


def test_jarvis_event_requires_the_exact_live_desktop_owner(tmp_path):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, find_jarvis_live_owner
    from tui_gateway.owner_event_inbox import admit_jarvis_event, owner_event_receipt

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    with pytest.raises(RuntimeError, match="no live desktop owner"):
        admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        owner = find_jarvis_live_owner(tmp_path)
        assert owner and owner["lease_id"] == lease.lease_id
        admitted = admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")
        assert admitted["status"] == "queued"
        assert admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today") == admitted
        assert claim_pending_delivery(tmp_path, owner)["id"] == admitted["id"]
    finally:
        lease.release()
        db.close()
    assert owner_event_receipt(tmp_path, source="calendar", event_id="one")["status"] == "claimed"
    assert admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Review today")["id"] == admitted["id"]
    with pytest.raises(ValueError, match="different payload"):
        admit_jarvis_event(tmp_path, source="calendar", event_id="one", text="Changed event")
    with pytest.raises(RuntimeError, match="no live desktop owner"):
        admit_jarvis_event(tmp_path, source="calendar", event_id="two", text="Review tomorrow")


@pytest.mark.parametrize("title,source,consumer", [
    ("Side chat", "desktop", True),
    ("Jarvis", "cli", True),
    ("Jarvis", "desktop", False),
])
def test_jarvis_event_refuses_lookalike_or_nonconsumer_owner(tmp_path, title, source, consumer):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import find_jarvis_live_owner

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
    finally:
        lease.release()
        db.close()


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
        admit_jarvis_event, owner_event_receipt, review_interrupted_jarvis_event,
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
        assert retry_interrupted_jarvis_event(tmp_path, original["id"], reviewed["review_digest"]) == queued
        assert owner_event_receipt(tmp_path, source="synthetic", event_id="first")["status"] == "claimed"
        claimed = claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path))
        assert claimed["id"] == queued["delivery_id"]
        assert claimed["message"] == original["message"]
        assert claim_pending_delivery(tmp_path, find_jarvis_live_owner(tmp_path)) is None
        complete_delivery(tmp_path, claimed["id"], status="settled", reply="Test-only result")
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
