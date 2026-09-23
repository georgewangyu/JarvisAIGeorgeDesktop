"""A recurring built-in tick keeps its schedule and execution history across processes."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


_CHILD = r"""
import json
import sys
from datetime import datetime, timedelta, timezone

from cron import executions, jobs, scheduler

if sys.argv[1] == "first":
    job = jobs.create_job(
        prompt="synthetic restart probe", schedule="every 10m",
        no_agent=True, script="probe.py",
    )
    jobs.update_job(job["id"], {
        "next_run_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    })
    assert scheduler.tick(verbose=False, sync=True) == 1
else:
    job = jobs.load_jobs()[0]
    before = jobs.get_job(job["id"])
    history = executions.list_executions(job_id=job["id"])
    assert before["last_status"] == "ok"
    assert before["last_run_at"] is not None
    assert datetime.fromisoformat(before["next_run_at"]) > datetime.now(timezone.utc)
    assert len(history) == 1 and history[0]["status"] == "completed"
    assert scheduler.tick(verbose=False, sync=True) == 0
    assert executions.list_executions(job_id=job["id"])[0]["id"] == history[0]["id"]
    jobs.update_job(job["id"], {
        "next_run_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    })
    assert scheduler.tick(verbose=False, sync=True) == 1

job = jobs.load_jobs()[0]
history = executions.list_executions(job_id=job["id"])
print("RESTART_PROOF=" + json.dumps({
    "id": job["id"], "next_run_at": job["next_run_at"],
    "last_run_at": job["last_run_at"], "last_status": job["last_status"],
    "execution_ids": [row["id"] for row in history],
    "execution_statuses": [row["status"] for row in history],
}))
"""


def _run_phase(home: Path, phase: str) -> dict:
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    completed = subprocess.run(
        [sys.executable, "-c", _CHILD, phase],
        cwd=Path(__file__).resolve().parents[2], env=env,
        capture_output=True, text=True, timeout=60, check=True,
    )
    return json.loads(next(
        line.removeprefix("RESTART_PROOF=")
        for line in completed.stdout.splitlines()
        if line.startswith("RESTART_PROOF=")
    ))


def test_recurring_next_run_and_history_survive_process_restart(tmp_path):
    home = tmp_path / "synthetic-hermes-home"
    scripts = home / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "probe.py").write_text("print('ok')\n", encoding="utf-8")

    first = _run_phase(home, "first")
    second = _run_phase(home, "second")

    assert second["id"] == first["id"]
    assert second["last_status"] == "ok"
    assert second["last_run_at"] is not None
    assert second["next_run_at"] > second["last_run_at"]
    assert len(second["execution_ids"]) == 2
    assert first["execution_ids"][0] in second["execution_ids"]
    assert second["execution_statuses"] == ["completed", "completed"]
