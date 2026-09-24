"""The packaged-app rehearsal starts with a real, closed-app deferred receipt."""

import pytest

from offline_jarvis_event_fixture import EVENT_ID, SOURCE, init, read_fixture, status


def test_fixture_owns_one_offline_event_without_model_calls(tmp_path):
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    root = tmp_path / "offline-root"
    data = init(root)
    assert read_fixture(root) == data
    assert status(root)["receipt_status"] == "deferred"
    assert status(root)["model_calls"] == 0
    with pytest.raises(ValueError, match="different payload"):
        admit_jarvis_event(root / "hermes-home", source=SOURCE, event_id=EVENT_ID,
                           text="Changed event")
    with pytest.raises(ValueError, match="unique empty directory"):
        init(root)
