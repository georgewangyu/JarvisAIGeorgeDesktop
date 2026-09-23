"""Deliberate, profile-local Feed editions.

An edition is an execution record, not a placeholder article.  The only way to
create one is an explicit request; failed and interrupted attempts remain
visible and may be retried explicitly.
"""

from __future__ import annotations

import logging
import json
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from hermes_constants import get_hermes_home

log = logging.getLogger(__name__)
_PROCESS_OWNER = uuid.uuid4().hex
_LEASE_SECONDS = 60


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    return get_hermes_home().resolve() / "feed" / "editions.sqlite3"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("""CREATE TABLE IF NOT EXISTS editions (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, finished_at TEXT, content TEXT,
        error TEXT, owner TEXT NOT NULL, attempt INTEGER NOT NULL,
        execution TEXT NOT NULL, source_urls TEXT NOT NULL DEFAULT '[]',
        heartbeat_at REAL NOT NULL
    )""")
    db.commit()
    return db


def _row(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["source_urls"] = json.loads(item["source_urls"])
    item["source_urls_verified"] = False
    return item


def _interrupt_stale(db: sqlite3.Connection, edition_id: str | None = None) -> None:
    sql = (
        "UPDATE editions SET status='interrupted', finished_at=?, "
        "error='Backend stopped before generation finished' "
        "WHERE status='generating' AND heartbeat_at < ?"
    )
    args: tuple = (_now(), time.time() - _LEASE_SECONDS)
    if edition_id is not None:
        sql += " AND id=?"
        args += (edition_id,)
    db.execute(sql, args)


def list_editions(limit: int = 20) -> list[dict]:
    """Newest first. Previous-process in-flight work is marked interrupted."""
    with _connect() as db:
        _interrupt_stale(db)
        rows = db.execute(
            "SELECT * FROM editions ORDER BY created_at DESC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
        return [_row(row) for row in rows]


def get_edition(edition_id: str) -> dict | None:
    with _connect() as db:
        _interrupt_stale(db, edition_id)
        row = db.execute("SELECT * FROM editions WHERE id=?", (edition_id,)).fetchone()
        return _row(row) if row else None


def _run_real_agent(prompt: str, edition_id: str) -> tuple[str, str | None]:
    """Use the existing cron agent lifecycle, runtime preflight and watchdog.

    ``run_job`` creates a real isolated session and tears down the agent.  This
    one-off job is never registered with the scheduler or delivered to a chat.
    """
    from cron.scheduler import run_job

    job = {
        "id": edition_id[:12], "name": "Feed edition", "prompt": prompt,
        "skills": [], "skill": None, "script": None, "no_agent": False,
        "deliver": "local", "schedule": {"kind": "once"},
    }
    success, _document, response, error = run_job(job)
    if not success:
        raise RuntimeError(error or "Agent did not complete the Feed edition")
    if not response or not response.strip():
        raise RuntimeError("Agent returned no Feed edition")
    return response.strip(), None


def _finish(edition_id: str, attempt: int, prompt: str, runner) -> None:
    heartbeat_stop = threading.Event()

    def heartbeat() -> None:
        while not heartbeat_stop.wait(_LEASE_SECONDS / 4):
            try:
                with _connect() as db:
                    db.execute(
                        "UPDATE editions SET heartbeat_at=? WHERE id=? AND owner=? "
                        "AND attempt=? AND status='generating'",
                        (time.time(), edition_id, _PROCESS_OWNER, attempt),
                    )
            except Exception:
                log.exception("Feed edition %s heartbeat failed", edition_id)

    # ContextVar profile routing must be copied independently for this thread.
    import contextvars
    heartbeat_thread = threading.Thread(
        target=contextvars.copy_context().run, args=(heartbeat,),
        name=f"feed-heartbeat-{edition_id[:8]}", daemon=True,
    )
    heartbeat_thread.start()
    try:
        content, _ = runner(prompt, edition_id)
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Agent returned no Feed edition")
        status, error = "completed", None
    except Exception as exc:
        log.exception("Feed edition %s failed", edition_id)
        from cron.scheduler_preflight import BLOCKED_CONFIG_MARKER, BLOCKED_CONFIG_SILENT_MARKER

        denied = isinstance(exc, PermissionError) or any(
            marker in str(exc) for marker in (BLOCKED_CONFIG_MARKER, BLOCKED_CONFIG_SILENT_MARKER)
        )
        content, status, error = None, "denied" if denied else "failed", f"{type(exc).__name__}: {exc}"
    finally:
        heartbeat_stop.set()
    # These are URLs printed by the agent, not independently verified sources.
    source_urls = sorted(set(re.findall(r"https?://[^\s<>)\]]+", content or "")))
    with _connect() as db:
        db.execute(
            "UPDATE editions SET status=?, content=?, error=?, source_urls=?, finished_at=? "
            "WHERE id=? AND owner=? AND attempt=? AND status='generating'",
            (status, content, error, json.dumps(source_urls), _now(), edition_id, _PROCESS_OWNER, attempt),
        )


def request_edition(prompt: str, *, retry_id: str | None = None, runner=None) -> dict:
    """Create or explicitly retry an edition and launch its actual agent run.

    Returns the durable generating record immediately. Concurrent generations
    in a profile are refused so a double click cannot make duplicate model calls.
    """
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
        raise ValueError("prompt must contain 1 to 8000 characters")
    prompt = prompt.strip()
    edition_id = retry_id or uuid.uuid4().hex
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        _interrupt_stale(db)
        if db.execute("SELECT 1 FROM editions WHERE status='generating' LIMIT 1").fetchone():
            raise RuntimeError("A Feed edition is already generating")
        if retry_id:
            previous = db.execute("SELECT * FROM editions WHERE id=?", (retry_id,)).fetchone()
            if previous is None:
                raise LookupError("Feed edition not found")
            if previous["status"] not in ("failed", "denied", "interrupted"):
                raise ValueError("Only failed, denied, or interrupted editions may be retried")
            if prompt != previous["prompt"]:
                raise ValueError("Retry must use the original prompt")
            attempt = previous["attempt"] + 1
            db.execute(
                "UPDATE editions SET status='generating', owner=?, attempt=?, "
                "finished_at=NULL, content=NULL, error=NULL, source_urls='[]', heartbeat_at=? WHERE id=?",
                (_PROCESS_OWNER, attempt, time.time(), edition_id),
            )
        else:
            attempt = 1
            db.execute(
                "INSERT INTO editions VALUES (?, ?, 'generating', ?, NULL, NULL, NULL, ?, ?, ?, '[]', ?)",
                (edition_id, prompt, _now(), _PROCESS_OWNER, attempt, "cron.run_job", time.time()),
            )
        row = db.execute("SELECT * FROM editions WHERE id=?", (edition_id,)).fetchone()
    # The profile's runtime scope is task-local, so copy it into the worker.
    import contextvars
    context = contextvars.copy_context()
    thread = threading.Thread(
        target=context.run, args=(_finish, edition_id, attempt, prompt, runner or _run_real_agent),
        name=f"feed-edition-{edition_id[:8]}", daemon=True,
    )
    try:
        thread.start()
    except Exception as exc:
        with _connect() as db:
            db.execute(
                "UPDATE editions SET status='failed', error=?, finished_at=? WHERE id=?",
                (f"Worker start failed: {exc}", _now(), edition_id),
            )
        raise
    return _row(row)
