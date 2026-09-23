"""The desktop must show script-only runs from the profile-local execution ledger."""

from pathlib import Path

from cron.executions import create_execution, finish_execution
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli.web_routers import cron as router


def _record(home: Path, job_id: str, *, success: bool, error: str | None = None,
            delivery_outcome: str | None = None):
    token = set_hermes_home_override(str(home))
    try:
        row = create_execution(job_id, source="scheduler")
        finish_execution(row["id"], success=success, error=error,
                         delivery_outcome=delivery_outcome)
        return row["id"]
    finally:
        reset_hermes_home_override(token)


def test_script_history_is_profile_local_and_omits_raw_error(tmp_path, monkeypatch):
    homes = {"a": tmp_path / "a", "b": tmp_path / "b"}
    monkeypatch.setattr(router, "_find_cron_job_profile", lambda job_id: "a")
    monkeypatch.setattr(router, "_cron_profile_home", lambda profile: (profile, homes[profile]))
    monkeypatch.setattr(
        router, "_call_cron_for_profile",
        lambda profile, method, job_id: {"id": job_id, "no_agent": True},
    )

    a_id = _record(homes["a"], "same-job", success=False, error="private script output")
    b_id = _record(homes["b"], "same-job", success=True, delivery_outcome="queued")

    a = router._list_cron_job_executions_sync("same-job", profile="a")
    b = router._list_cron_job_executions_sync("same-job", profile="b")
    a_again = router._list_cron_job_executions_sync("same-job", profile="a")

    assert [run["id"] for run in a["executions"]] == [a_id]
    assert [run["id"] for run in b["executions"]] == [b_id]
    assert a_again == a
    assert a["executions"][0]["status"] == "failed"
    assert b["executions"][0]["delivery_outcome"] == "queued"
    assert "private script output" not in str(a)


def test_script_history_rejects_unrecognized_delivery_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(router, "_find_cron_job_profile", lambda job_id: "a")
    monkeypatch.setattr(router, "_cron_profile_home", lambda profile: (profile, tmp_path / profile))
    monkeypatch.setattr(
        router, "_call_cron_for_profile",
        lambda profile, method, job_id: {"id": job_id, "no_agent": True},
    )

    _record(tmp_path / "a", "script-job", success=True,
            delivery_outcome="secret=should-not-render")
    result = router._list_cron_job_executions_sync("script-job", profile="a")

    assert result["executions"][0]["delivery_outcome"] is None
    assert "should-not-render" not in str(result)


def test_agent_job_does_not_duplicate_its_chat_history(tmp_path, monkeypatch):
    monkeypatch.setattr(router, "_find_cron_job_profile", lambda job_id: "a")
    monkeypatch.setattr(router, "_cron_profile_home", lambda profile: (profile, tmp_path / profile))
    monkeypatch.setattr(
        router, "_call_cron_for_profile",
        lambda profile, method, job_id: {"id": job_id, "no_agent": False},
    )

    assert router._list_cron_job_executions_sync("agent-job") == {"executions": []}
