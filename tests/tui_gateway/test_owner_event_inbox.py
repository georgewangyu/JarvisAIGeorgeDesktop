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
