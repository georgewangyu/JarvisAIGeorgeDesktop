"""A real script interrupted by scheduler death retains one uncertain attempt."""

from __future__ import annotations

import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path

import pytest

from hermes_time import now


@pytest.mark.skipif(sys.platform == "win32", reason="uses POSIX owner signals")
@pytest.mark.live_system_guard_bypass
def test_no_agent_script_owner_death_recovers_once_without_replay(tmp_path, monkeypatch):
    from cron import executions
    from gateway.status import get_process_start_time

    home = tmp_path / "profile"
    cron_dir = home / "cron"
    scripts_dir = home / "scripts"
    cron_dir.mkdir(parents=True)
    scripts_dir.mkdir()
    started = home / "script-started.json"
    effects = home / "effects.txt"
    script = scripts_dir / "blocking.py"
    script.write_text(
        "import json, os, time\n"
        "from pathlib import Path\n"
        f"Path({str(effects)!r}).open('a').write('started\\n')\n"
        f"Path({str(started)!r}).write_text(json.dumps({{'pid': os.getpid()}}))\n"
        "time.sleep(12)\n"
        "print('finished')\n",
        encoding="utf-8",
    )
    slot = (now() - timedelta(minutes=2)).isoformat()
    from cron import jobs

    with jobs.use_cron_store(home):
        job = jobs.create_job(
            prompt=None, schedule="every 4h", name="crash probe",
            script=str(script), no_agent=True, deliver="local",
        )
        jobs.update_job(job["id"], {"next_run_at": slot})
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("HERMES_", "_HERMES_"))
        and not key.endswith(("_API_KEY", "_TOKEN"))
    }
    env["HERMES_HOME"] = str(home)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", cron_dir / "executions.db")
    owner = subprocess.Popen(
        [sys.executable, "-c", "from cron.scheduler import tick; tick(verbose=False, sync=True)"],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    script_pid = None
    script_started_at = None
    try:
        deadline = time.monotonic() + 10
        running = None
        while time.monotonic() < deadline:
            if owner.poll() is not None:
                pytest.fail(f"scheduler owner exited before interruption ({owner.returncode})")
            running = executions.latest_execution(job["id"])
            if started.exists() and running and running["status"] == "running":
                script_pid = json.loads(started.read_text(encoding="utf-8"))["pid"]
                script_started_at = get_process_start_time(script_pid)
                break
            time.sleep(0.05)
        assert script_pid is not None, "test script never reached its blocking phase"
        assert running["pid"] == owner.pid
        assert running["process_started_at"] == get_process_start_time(owner.pid)
        assert effects.read_text(encoding="utf-8").splitlines() == ["started"]

        os.kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=5)
        restarted = subprocess.run(
            [sys.executable, "-c", (
                "import json\n"
                "from cron import executions, scheduler\n"
                "counts = [executions.recover_interrupted_executions(), "
                "executions.recover_interrupted_executions()]\n"
                "fires = [scheduler.tick(verbose=False, sync=True), "
                "scheduler.tick(verbose=False, sync=True)]\n"
                "print(json.dumps({'counts': counts, 'fires': fires, "
                f"'rows': executions.list_executions(job_id={job['id']!r})}}))\n"
            )],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        result = json.loads(restarted.stdout)
        assert result["counts"] == [1, 0]
        assert result["fires"] == [0, 0]
        assert len(result["rows"]) == 1
        assert result["rows"][0]["id"] == running["id"]
        assert result["rows"][0]["status"] == "unknown"
        assert effects.read_text(encoding="utf-8").splitlines() == ["started"]
    finally:
        if owner.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=5)
        if (
            script_pid is not None
            and script_started_at is not None
            and get_process_start_time(script_pid) == script_started_at
        ):
            with contextlib.suppress(ProcessLookupError):
                os.kill(script_pid, signal.SIGKILL)
