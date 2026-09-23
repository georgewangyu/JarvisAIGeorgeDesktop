"""An exact-owner event survives process restart and cannot be admitted twice."""

import json
import subprocess
import sys

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
