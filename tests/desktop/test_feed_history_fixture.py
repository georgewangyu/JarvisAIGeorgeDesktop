"""Synthetic state checks for the native Feed history fixture."""

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from feed_history_fixture import create_fixture  # noqa: E402


def test_feed_fixture_keeps_earlier_answer_behind_newest_empty_run(tmp_path):
    from cron.jobs import get_job, use_cron_store
    from hermes_state import SessionDB

    root = tmp_path / "feed-fixture"
    data = create_fixture(root)
    home = root / "hermes-home"

    with use_cron_store(home):
        job = get_job(data["job_id"])
    assert job is not None
    assert job["state"] == "paused"
    assert job["enabled"] is False

    db = SessionDB(home / "state.db", read_only=True)
    try:
        runs = db.list_cron_job_runs(data["job_id"], limit=3)
        assert len(runs) == 2
        assert runs[0]["id"].endswith("_latest")
        assert runs[1]["id"].endswith("_earlier")
        earlier = db.get_messages(runs[1]["id"])
        assert any("Earlier saved briefing." in message.get("content", "") for message in earlier)
    finally:
        db.close()
