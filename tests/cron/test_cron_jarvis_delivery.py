"""Explicit scheduled delivery goes only to the permanent desktop chat."""

import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
from unittest.mock import Mock
from datetime import timedelta
from pathlib import Path

import pytest

from cron import scheduler_delivery as delivery
from cron.scheduler_preflight import _preflight_check_delivery


def test_jarvis_target_is_explicit_and_needs_no_gateway_credentials():
    job = {"id": "routine", "deliver": "jarvis-main"}
    assert delivery._resolve_delivery_targets(job) == [
        {"platform": "jarvis-main", "chat_id": "", "thread_id": None}]
    assert _preflight_check_delivery(job) is None
    assert any(target["id"] == "jarvis-main" and "next open" in target["name"]
               for target in delivery.cron_delivery_targets())
    assert delivery._resolve_delivery_targets({"id": "routine", "deliver": "local"}) == []


def test_jarvis_delivery_uses_real_owner_mailbox_and_never_falls_back(tmp_path, monkeypatch):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tools.bot_live_delivery import claim_pending_delivery, complete_delivery
    from tui_gateway.owner_event_inbox import adopt_deferred_jarvis_events, owner_event_receipt

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("_HERMES_CRON_EXTERNAL_WORKER", raising=False)
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    job = {"id": "routine", "name": "Daily brief", "execution_id": "run-1", "deliver": "jarvis-main"}
    assert "awaiting app reopen" in delivery._deliver_to_jarvis_main(job, "synthetic output")
    assert owner_event_receipt(tmp_path, source="cron", event_id="routine:run-1")["status"] == "deferred"
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        queued = delivery._deliver_to_jarvis_main(job, "synthetic output")
        assert queued and "awaiting app reopen" in queued
        receipt = owner_event_receipt(tmp_path, source="cron", event_id="routine:run-1")
        assert receipt["message"].endswith('Scheduled routine "Daily brief" finished.\nsynthetic output')
        owner = {"profile_home": str(tmp_path.resolve()), "session_id": "main",
                 "lease_id": lease.lease_id, "live_session_id": "runtime"}
        assert adopt_deferred_jarvis_events(tmp_path, owner) == 1
        assert claim_pending_delivery(tmp_path, owner)["id"] == receipt["id"]
        complete_delivery(tmp_path, receipt["id"], status="settled", reply="Concise summary")
    finally:
        lease.release()
        db.close()
    assert delivery._deliver_to_jarvis_main(job, "synthetic output") is None
    assert "different payload" in delivery._deliver_to_jarvis_main(job, "changed output")
    assert "awaiting app reopen" in delivery._deliver_to_jarvis_main(
        {**job, "execution_id": "run-2"}, "synthetic output")


def test_jarvis_delivery_refuses_without_a_permanent_desktop_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    job = {"id": "routine", "execution_id": "run-1", "deliver": "jarvis-main"}
    assert "no desktop owner" in delivery._deliver_to_jarvis_main(job, "synthetic output")
    assert not (tmp_path / "runtime" / "bot_live_delivery").exists()


def test_closed_chat_activation_is_opt_in_and_pins_each_profile(tmp_path, monkeypatch):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from hermes_state import SessionDB
    from tui_gateway import owner_event_inbox
    from tui_gateway.owner_event_inbox import owner_event_receipt

    root = tmp_path / "hermes"
    homes = (root, root / "profiles" / "b")
    launched = []

    class Child:
        pid = 1234

        def wait(self):
            return 0

    def spawn(argv, **kwargs):
        launched.append((argv, kwargs))
        return Child()

    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(owner_event_inbox.subprocess, "Popen", spawn)
    for home in homes:
        home.mkdir(parents=True, exist_ok=True)
        (home / ".env").write_text(
            f"OPENAI_API_KEY={'default-only' if home == root else 'b-only'}\n",
            encoding="utf-8")
        db = SessionDB(db_path=home / "state.db")
        db.create_session(session_id="main", source="desktop")
        db.set_session_title("main", "Jarvis")
        db.close()
    job = {"id": "routine", "name": "Brief", "execution_id": "one"}
    monkeypatch.setenv("OPENAI_API_KEY", "default-only")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ambient-default-only")
    assert "awaiting app reopen" in delivery._deliver_to_jarvis_main(job, "first")
    assert launched == []
    for home in homes:
        (home / "config.yaml").write_text(
            "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
        event_id = "one" if home != root else "two"
        token = set_hermes_home_override(home)
        try:
            assert "activation started" in delivery._deliver_to_jarvis_main(
                {**job, "execution_id": event_id}, "first")
        finally:
            reset_hermes_home_override(token)
        argv, kwargs = launched[-1]
        assert argv[argv.index("--expected-profile-home") + 1] == str(home)
        assert kwargs["env"]["HERMES_HOME"] == str(home)
        assert kwargs["env"]["OPENAI_API_KEY"] == (
            "default-only" if home == root else "b-only")
        if home != root:
            assert "ANTHROPIC_API_KEY" not in kwargs["env"]
        assert kwargs["stdin"] is owner_event_inbox.subprocess.DEVNULL
        assert owner_event_receipt(home, source="cron", event_id=f"routine:{event_id}")["status"] == "deferred"
    assert len(launched) == 2


def test_failed_activation_keeps_deferred_receipt_for_retry(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import owner_event_inbox
    from tui_gateway.owner_event_inbox import owner_event_receipt

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    def fail_spawn(*_args, **_kwargs):
        raise OSError("spawn refused")
    monkeypatch.setattr(owner_event_inbox.subprocess, "Popen", fail_spawn)
    job = {"id": "routine", "name": "Brief", "execution_id": "one"}
    assert "spawn refused" in delivery._deliver_to_jarvis_main(job, "first")
    assert owner_event_receipt(tmp_path, source="cron", event_id="routine:one")["status"] == "deferred"
    launched = []
    class Child:
        pid = 1234

        def wait(self):
            return 0

    monkeypatch.setattr(owner_event_inbox.subprocess, "Popen", lambda *_a, **_kw: launched.append(1) or Child())
    assert "activation started" in delivery._deliver_to_jarvis_main(job, "first")
    assert launched == [1]


def test_scheduler_records_jarvis_admission_as_queued_not_delivered(tmp_path, monkeypatch):
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from cron import jobs
    from gateway import config
    from tools.cronjob_tools import _manual_run_delivery_note

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("_HERMES_CRON_EXTERNAL_WORKER", raising=False)
    monkeypatch.setattr(delivery._sched, "load_config", lambda: {})
    monkeypatch.setattr(config, "load_gateway_config", lambda: None)
    monkeypatch.setattr(delivery, "_run_bot_chat_turn", Mock(side_effect=AssertionError("CLI fallback")))
    updates = []
    monkeypatch.setattr(jobs, "update_job", lambda key, values: updates.append(values))
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    lease, refusal = try_acquire_active_session(
        session_id="main", surface="desktop", config={}, registry_home=tmp_path,
        metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
    )
    assert refusal is None
    try:
        job = {"id": "routine", "name": "Daily brief", "execution_id": "run-1", "deliver": "jarvis-main"}
        assert delivery._deliver_result(job, "synthetic output") is None
        assert updates[-1]["last_delivery_queued"]["jarvis-main"]["status"] == "queued"
        assert "queued for Jarvis main chat" in _manual_run_delivery_note(job["deliver"], job)
    finally:
        lease.release()
        db.close()
    offline_job = {"id": "routine", "name": "Daily brief", "execution_id": "run-2",
                   "deliver": "jarvis-main"}
    assert delivery._deliver_result(offline_job, "synthetic output") is None
    assert updates[-1]["last_delivery_queued"]["jarvis-main"]["status"] == "deferred"
    assert "when the app reopens" in _manual_run_delivery_note(offline_job["deliver"], offline_job)


@pytest.mark.parametrize("live_owner", [False, True])
def test_due_script_occurrence_produces_one_jarvis_event(tmp_path, monkeypatch, live_owner):
    from cron import executions, jobs, scheduler
    from hermes_cli.active_sessions import try_acquire_active_session
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import adopt_deferred_jarvis_events, owner_event_receipt

    home = tmp_path / "home"
    (home / "cron" / "output").mkdir(parents=True)
    (home / "scripts").mkdir()
    script = home / "scripts" / "brief.sh"
    script.write_text("#!/bin/sh\necho one-test-owned-brief\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("_HERMES_CRON_EXTERNAL_WORKER", raising=False)
    monkeypatch.setattr(jobs, "HERMES_DIR", home)
    monkeypatch.setattr(jobs, "CRON_DIR", home / "cron")
    monkeypatch.setattr(jobs, "JOBS_FILE", home / "cron" / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", home / "cron" / "output")
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", home / "cron" / "executions.db")
    monkeypatch.setattr(scheduler, "_hermes_home", home)
    db = SessionDB(db_path=home / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    lease = None
    if live_owner:
        lease, refusal = try_acquire_active_session(
            session_id="main", surface="desktop", config={}, registry_home=home,
            metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
        )
        assert refusal is None
    try:
        job = jobs.create_job(
            prompt=None, schedule="every 1h", name="brief", script="brief.sh",
            no_agent=True, deliver="jarvis-main")
        stored = jobs.load_jobs()
        next(row for row in stored if row["id"] == job["id"])["next_run_at"] = (
            jobs._hermes_now() - timedelta(minutes=1)).isoformat()
        jobs.save_jobs(stored)
        assert scheduler.tick(verbose=False, sync=True) == 1
        run = executions.latest_execution(job["id"])
        assert run and run["status"] == "completed"
        receipt = owner_event_receipt(home, source="cron", event_id=f"{job['id']}:{run['id']}")
        assert receipt and receipt["status"] == ("queued" if live_owner else "deferred")
        assert "one-test-owned-brief" in receipt["message"]
        assert scheduler.tick(verbose=False, sync=True) == 0
        assert len(list((home / "runtime" / "bot_live_delivery").glob("*.json"))) == 1
        if not live_owner:
            lease, refusal = try_acquire_active_session(
                session_id="main", surface="desktop", config={}, registry_home=home,
                metadata={"live_session_id": "runtime", "bot_live_delivery_consumer": True},
            )
            assert refusal is None
            owner = {"profile_home": str(home.resolve()), "session_id": "main",
                     "lease_id": lease.lease_id, "live_session_id": "runtime"}
            assert adopt_deferred_jarvis_events(home, owner) == 1
            assert owner_event_receipt(home, source="cron", event_id=f"{job['id']}:{run['id']}")["status"] == "queued"
    finally:
        if lease is not None:
            lease.release()
        db.close()
        scheduler._shutdown_parallel_pool()


def test_due_cron_event_settles_headlessly_with_desktop_closed(tmp_path, monkeypatch):
    """A running cron producer can settle one event without an Electron owner."""
    from cron import executions, jobs, scheduler
    from hermes_state import SessionDB
    from tools.bot_live_delivery import find_jarvis_live_owner
    from tui_gateway import owner_event_inbox
    from tui_gateway.owner_event_inbox import owner_event_receipt

    home = tmp_path / "home"
    (home / "cron" / "output").mkdir(parents=True)
    (home / "scripts").mkdir()
    script = home / "scripts" / "brief.sh"
    script.write_text("#!/bin/sh\necho one-test-owned-brief\n", encoding="utf-8")
    script.chmod(0o755)
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session(session_id="main", source="desktop")
        db.set_session_title("main", "Jarvis")
    finally:
        db.close()

    calls = []

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(request)
            answer = {
                "id": "cron-headless-test", "object": "chat.completion.chunk",
                "model": "test-model", "choices": [{"index": 0,
                "delta": {"role": "assistant", "content": "ONE_CRON_EVENT_SETTLED"},
                "finish_reason": "stop"}],
            }
            raw = ("data: " + json.dumps(answer) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, _format, *_args):
            pass

    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    base_url = f"http://127.0.0.1:{provider.server_port}/v1"
    (home / "config.yaml").write_text(
        "model:\n  provider: custom\n  default: test-model\n"
        f"  base_url: {base_url}\n  api_mode: chat_completions\n"
        "memory:\n  memory_enabled: false\n  user_profile_enabled: false\n"
        "terminal:\n  env: local\n"
        "desktop:\n  jarvis_headless_event_activation: true\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_DIR", str(tmp_path / "shared-auth"))
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(tmp_path / "managed"))
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    monkeypatch.setenv("OPENAI_BASE_URL", base_url)
    monkeypatch.setenv("OPENAI_API_KEY", "local-test-only")
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).resolve().parents[2]))
    monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
    monkeypatch.delenv("_HERMES_CRON_EXTERNAL_WORKER", raising=False)
    monkeypatch.setattr(jobs, "HERMES_DIR", home)
    monkeypatch.setattr(jobs, "CRON_DIR", home / "cron")
    monkeypatch.setattr(jobs, "JOBS_FILE", home / "cron" / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", home / "cron" / "output")
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", home / "cron" / "executions.db")
    monkeypatch.setattr(scheduler, "_hermes_home", home)

    spawned = []
    original_popen = subprocess.Popen

    def capture_headless_child(argv, **kwargs):
        child = original_popen(argv, **kwargs)
        if isinstance(argv, list) and argv[1:3] == ["-m", "tui_gateway.headless_owner_event"]:
            assert kwargs.get("start_new_session") is True
            spawned.append(child)
        return child

    monkeypatch.setattr(owner_event_inbox.subprocess, "Popen", capture_headless_child)
    try:
        assert find_jarvis_live_owner(home) is None
        job = jobs.create_job(
            prompt=None, schedule="every 1h", name="brief", script="brief.sh",
            no_agent=True, deliver="jarvis-main")
        stored = jobs.load_jobs()
        next(row for row in stored if row["id"] == job["id"])["next_run_at"] = (
            jobs._hermes_now() - timedelta(minutes=1)).isoformat()
        jobs.save_jobs(stored)
        assert scheduler.tick(verbose=False, sync=True) == 1
        run = executions.latest_execution(job["id"])
        assert run and run["status"] == "completed"
        event_id = f"{job['id']}:{run['id']}"
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            receipt = owner_event_receipt(home, source="cron", event_id=event_id)
            if receipt and receipt["status"] == "settled":
                break
            time.sleep(0.05)
        else:
            pytest.fail(f"headless cron event did not settle: {receipt}")
        assert receipt["claimed_at"]
        assert "one-test-owned-brief" in receipt["message"]
        assert receipt["reply"] == "ONE_CRON_EVENT_SETTLED"
        assert len(spawned) == 1
        assert spawned[0].wait(timeout=5) == 0
        assert len([call for call in calls if "messages" in call]) == 1
        assert find_jarvis_live_owner(home) is None
        assert scheduler.tick(verbose=False, sync=True) == 0
        assert executions.latest_execution(job["id"])["id"] == run["id"]
        assert len([call for call in calls if "messages" in call]) == 1
        assert len(list((home / "runtime" / "bot_live_delivery").glob("*.json"))) == 1
    finally:
        try:
            for child in spawned:
                if child.poll() is None:
                    try:
                        if os.name == "posix":
                            os.killpg(child.pid, signal.SIGTERM)
                        else:
                            child.terminate()
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        try:
                            if os.name == "posix":
                                os.killpg(child.pid, signal.SIGKILL)
                            else:
                                child.kill()
                        except ProcessLookupError:
                            pass
                child.wait(timeout=5)
        finally:
            provider.shutdown()
            provider.server_close()
            provider_thread.join(timeout=5)
            scheduler._shutdown_parallel_pool()
