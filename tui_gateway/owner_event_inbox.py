"""Durable admission for events addressed to an exact assistant owner.

This is an adapter over the existing live-owner mailbox. Its receipt proves
admission to that owner's inbox, not that a model turn ran or a reply arrived.
The session notification poller remains the only consumer. Claimed records
remain claimed after a crash, where the turn outcome is ambiguous; they are
never silently replayed into a possibly completed turn.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

from tools.bot_live_delivery import (
    deliver_to_live_owner, find_jarvis_live_owner, find_jarvis_main_session_id,
    read_delivery_result,
)

log = logging.getLogger(__name__)


def _event_delivery_id(source: str, event_id: str) -> str:
    if not isinstance(source, str) or not source.strip():
        raise ValueError("event source is required")
    if not isinstance(event_id, str) or not event_id.strip():
        raise ValueError("event id is required")
    identity = json.dumps([source, event_id], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def admit_owner_event(
    profile_home: Path | str, owner: dict[str, Any], *,
    source: str, event_id: str, text: str,
) -> dict[str, Any]:
    """Queue one event for a pinned owner; retries return the same durable receipt.

    The producer must preserve ``source`` and ``event_id`` across retries. A
    reused identity with different content or owner is rejected by the mailbox.
    """
    delivery_id = _event_delivery_id(source, event_id)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("event text is required")
    message = f"[Event from {source}; id {event_id}]\n{text}"
    return deliver_to_live_owner(profile_home, owner, message, delivery_id=delivery_id)


def admit_jarvis_event(
    profile_home: Path | str, *, source: str, event_id: str, text: str,
) -> dict[str, Any]:
    """Admit an event to the permanent desktop chat, without waking a closed app.

    An identical retry returns its original receipt after the owner exits. If
    that chat exists but has no live lease, its receipt stays deferred until a
    new exact owner adopts it. A missing or non-desktop chat is refused.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("event text is required")
    existing = owner_event_receipt(profile_home, source=source, event_id=event_id)
    if existing is not None:
        expected = f"[Event from {source}; id {event_id}]\n{text}"
        if existing.get("message") != expected:
            raise ValueError("event id already belongs to a different payload")
        return existing
    owner = find_jarvis_live_owner(profile_home)
    if owner is not None:
        return admit_owner_event(profile_home, owner, source=source, event_id=event_id, text=text)
    return _defer_jarvis_event(profile_home, source=source, event_id=event_id, text=text)


def _defer_jarvis_event(
    profile_home: Path | str, *, source: str, event_id: str, text: str,
) -> dict[str, Any]:
    import time
    from tools.bot_live_delivery import _locked, _next_sequence, _read, _write

    home = Path(profile_home).resolve()
    session_id = find_jarvis_main_session_id(home)
    if session_id is None:
        raise RuntimeError("the Jarvis main chat has no desktop owner")
    key = _event_delivery_id(source, event_id)
    message = f"[Event from {source}; id {event_id}]\n{text}"
    with _locked(home) as root:
        path = root / f"{key}.json"
        existing = _read(path)
        if existing is not None:
            if existing.get("message") != message:
                raise ValueError("event id already belongs to a different payload")
            return existing
        if find_jarvis_main_session_id(home) != session_id:
            raise RuntimeError("the Jarvis main chat changed during event admission")
        record = dict(delivery_id=key, id=key, profile_home=str(home),
                      target_session_id=session_id, message=message, status="deferred",
                      created_at=time.time_ns(), sequence=_next_sequence(root))
        _write(path, record)
        return record


def adopt_deferred_jarvis_events(
    profile_home: Path | str, owner: dict[str, Any],
) -> int:
    """Pin offline receipts to this live Jarvis lease before the idle poller claims.

    Only the exact permanent chat's compression lineage may adopt a ticket.
    A claimed or settled receipt is never moved or replayed.
    """
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _owner, _scan_read, _write

    home = Path(profile_home).resolve()
    pinned = _owner(home, owner)
    if find_jarvis_live_owner(home) != pinned:
        return 0
    if find_jarvis_main_session_id(home) != pinned["session_id"]:
        return 0
    db = SessionDB(db_path=home / "state.db", read_only=True)
    try:
        with _locked(home) as root:
            adopted = 0
            for path in root.glob("*.json"):
                record = _scan_read(path)
                if (record is None or record.get("status") != "deferred"
                        or record.get("profile_home") != str(home)):
                    continue
                target = record.get("target_session_id")
                if (not isinstance(target, str)
                        or db.get_compression_tip(target) != pinned["session_id"]):
                    continue
                record.update(owner=pinned, **pinned, status="queued")
                _write(path, record)
                adopted += 1
            return adopted
    finally:
        db.close()


def claim_deferred_jarvis_event_for_headless_owner(
    profile_home: Path | str, delivery_id: str, owner: dict[str, Any], *,
    allow_headless: bool = False,
) -> dict[str, Any]:
    """Opt in to a single exact-lease claim; this does not start or run a turn.

    The caller must already hold the permanent chat's exclusive session lease.
    A crash after this transition leaves an unknown outcome, never a replayable
    deferred event. No runtime calls this API until a headless consumer exists.
    """
    import os
    import time
    from hermes_cli.active_sessions import active_session_registry_snapshot
    from tools.bot_live_delivery import _delivery_id, _locked, _owner, _read, _write

    if not allow_headless:
        raise ValueError("headless event claiming requires explicit opt-in")
    home = Path(profile_home).resolve()
    pinned = _owner(home, owner)
    key = _delivery_id(delivery_id)
    # Strict liveness is necessary: an unreadable registry cannot authorize a
    # background claimant merely because it presented a plausible lease id.
    def valid_owner() -> bool:
        if find_jarvis_main_session_id(home) != pinned["session_id"]:
            return False
        for entry in active_session_registry_snapshot(registry_home=home, strict=True):
            meta = entry.get("metadata") or {}
            if (entry.get("surface") == "jarvis-event"
                    and entry.get("session_id") == pinned["session_id"]
                    and entry.get("lease_id") == pinned["lease_id"]
                    and entry.get("pid") == os.getpid()
                    and meta.get("live_session_id") == pinned["live_session_id"]
                    and meta.get("jarvis_event_consumer") is True):
                return True
        return False

    if not valid_owner():
        raise ValueError("no exact live Jarvis event owner")
    with _locked(home) as root:
        record_path = root / f"{key}.json"
        record = _read(record_path)
        if record is None:
            raise FileNotFoundError(f"event delivery not found: {key}")
        if (record.get("status") != "deferred"
                or record.get("profile_home") != str(home)
                or record.get("target_session_id") != pinned["session_id"]):
            raise ValueError("event is not deferred for this Jarvis owner")
        if not valid_owner():
            raise ValueError("Jarvis event owner changed during claim")
        record.update(owner=pinned, **pinned, status="claimed", claimed_at=time.time_ns())
        _write(record_path, record)
        return record


def owner_event_receipt(
    profile_home: Path | str, *, source: str, event_id: str,
) -> dict[str, Any] | None:
    """Inspect the exact event receipt after a producer or backend restart."""
    return read_delivery_result(profile_home, _event_delivery_id(source, event_id))


def jarvis_headless_activation_enabled(profile_home: Path | str) -> bool:
    """Read a literal per-profile opt-in without borrowing another profile's scope."""
    from utils import fast_safe_load

    home = Path(profile_home).resolve()
    try:
        with (home / "config.yaml").open(encoding="utf-8") as handle:
            config = fast_safe_load(handle)
    except FileNotFoundError:
        return False
    except Exception as exc:
        log.warning("Jarvis headless activation config unreadable for %s: %s", home, exc)
        return False
    desktop = config.get("desktop") if isinstance(config, dict) else None
    return isinstance(desktop, dict) and desktop.get("jarvis_headless_event_activation") is True


def _next_opted_in_deferred_event(
    home: Path, *, retry_failed_once: bool = False,
) -> str | None:
    from tools.bot_live_delivery import _locked, _scan_read

    session_id = find_jarvis_main_session_id(home)
    if session_id is None:
        return None
    candidates = []
    with _locked(home) as root:
        for path in root.glob("*.json"):
            record = _scan_read(path)
            if (record is None or record.get("status") != "deferred"
                    or record.get("headless_activation_requested") is not True
                    or record.get("profile_home") != str(home)
                    or record.get("target_session_id") != session_id):
                continue
            if ("headless_activation_failed_exit_code" in record
                    and (not retry_failed_once
                         or record.get("headless_activation_failed_count") != 1)):
                continue
            sequence = record.get("sequence")
            key = record.get("delivery_id")
            if isinstance(sequence, int) and isinstance(key, str):
                candidates.append((sequence, key))
    return min(candidates)[1] if candidates else None


def _reap_and_activate_next(
    home: Path, delivery_id: str, process, attempt_id: str | None = None,
) -> None:
    """Advance after a terminal turn or a proven, unclaimed child failure."""
    from tools.bot_live_delivery import _locked, _read, _write, read_delivery_result

    exit_code = process.wait()
    try:
        if exit_code != 0:
            # A claimed turn may have acted before the child died. Only a still-
            # deferred receipt from this exact launch proves there was no claim.
            if not attempt_id:
                return
            with _locked(home) as root:
                path = root / f"{delivery_id}.json"
                receipt = _read(path)
                if (receipt is None or receipt.get("status") != "deferred"
                        or receipt.get("profile_home") != str(home)
                        or receipt.get("headless_activation_attempt") != attempt_id
                        or "headless_activation_failed_exit_code" in receipt
                        or receipt.get("headless_activation_requested") is not True):
                    return
                receipt["headless_activation_failed_exit_code"] = exit_code
                prior_failures = receipt.get("headless_activation_failed_count", 0)
                receipt["headless_activation_failed_count"] = (
                    prior_failures + 1 if isinstance(prior_failures, int)
                    and not isinstance(prior_failures, bool) and prior_failures >= 0 else 2
                )
                _write(path, receipt)
        else:
            completed = read_delivery_result(home, delivery_id)
            if not completed or completed.get("status") not in {"settled", "failed", "cancelled"}:
                return
        if not jarvis_headless_activation_enabled(home):
            return
        # A sibling that raced a still-live lease gets one retry only after
        # another child has settled. Failed-child reapers never retry failures.
        next_id = _next_opted_in_deferred_event(
            home, retry_failed_once=exit_code == 0)
        if next_id is not None:
            activate_deferred_jarvis_event(home, next_id, allow_headless=True)
    except (OSError, ValueError, RuntimeError) as exc:
        log.warning("Jarvis deferred event handoff stopped for %s: %s", home, exc)


def activate_deferred_jarvis_event(
    profile_home: Path | str, delivery_id: str, *, allow_headless: bool = False,
) -> int:
    """Launch one exact deferred receipt in a fresh, target-profile process.

    The producer must opt in. A failed launch leaves the receipt deferred; the
    child's exclusive lease and atomic claim fence concurrent launch attempts.
    This runs only when an already-running producer calls it, not as a watcher.
    """
    from hermes_cli.profiles import get_profile_dir
    from tools.bot_live_delivery import _delivery_id, _locked, _read, _write
    from tools.environments.local import served_profile_child_env

    if not allow_headless:
        raise ValueError("headless event activation requires explicit opt-in")
    home = Path(profile_home).resolve()
    key = _delivery_id(delivery_id)
    if not jarvis_headless_activation_enabled(home):
        raise ValueError("headless activation is not enabled for the exact profile")
    if home == get_profile_dir("default").resolve():
        profile = "default"
    elif home.parent.name == "profiles" and home == get_profile_dir(home.name).resolve():
        profile = home.name
    else:
        raise ValueError("event home is not a registered local profile")
    env = served_profile_child_env(target_home=home, inherit_credentials=True)
    if Path(env.get("HERMES_HOME", "")).resolve() != home:
        raise RuntimeError("activation child lacks the exact profile home")
    session_id = find_jarvis_main_session_id(home)
    with _locked(home) as root:
        path = root / f"{key}.json"
        receipt = _read(path)
        if (receipt is None or receipt.get("status") != "deferred"
                or receipt.get("profile_home") != str(home)
                or receipt.get("target_session_id") != session_id):
            raise ValueError("event is not deferred for the exact Jarvis profile")
        attempt_id = uuid.uuid4().hex
        receipt["headless_activation_requested"] = True
        receipt["headless_activation_attempt"] = attempt_id
        receipt.pop("headless_activation_failed_exit_code", None)
        _write(path, receipt)
    process = subprocess.Popen(
        [sys.executable, "-m", "tui_gateway.headless_owner_event",
         "--profile", profile, "--expected-profile-home", str(home),
         "--delivery-id", key, "--allow-headless"],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True,
    )
    try:
        threading.Thread(
            target=_reap_and_activate_next, args=(home, key, process, attempt_id),
            name="jarvis-event-child-reaper", daemon=True).start()
    except RuntimeError:
        log.warning("Jarvis event child started but its wait thread could not start")
    return process.pid


def interrupted_jarvis_event_receipts(profile_home: Path | str) -> list[dict[str, Any]]:
    """Describe claimed turns from a *retired* Jarvis lease without replaying them.

    The result is intentionally metadata-only. A claim may have performed an
    action before its process exited, so neither inspecting nor displaying it
    may turn it back into queued work. A later consumer can offer a separately
    reviewed retry, but must give that retry a new event identity.
    """
    from hermes_cli.active_sessions import active_session_registry_snapshot
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _root, _scan_read

    home = Path(profile_home).resolve()
    if not _root(home).is_dir():
        return []
    owner = find_jarvis_live_owner(home)
    if owner is None:
        return []
    live_leases = {
        entry["lease_id"] for entry in active_session_registry_snapshot(
            registry_home=home, strict=True)
    }
    db = SessionDB(db_path=home / "state.db", read_only=True)
    try:
        with _locked(home) as root:
            interrupted = []
            retries: dict[str, str] = {}
            records = []
            for path in root.glob("*.json"):
                receipt = _scan_read(path)
                if receipt is not None:
                    records.append(receipt)
                    if (isinstance(receipt.get("reviewed_retry_of"), str)
                            and isinstance(receipt.get("owner"), dict)
                            and receipt["owner"].get("profile_home") == str(home)):
                        retries[receipt["reviewed_retry_of"]] = receipt.get("status", "unknown")
            for receipt in records:
                if receipt is None or receipt.get("status") != "claimed":
                    continue
                pinned = receipt.get("owner")
                if not isinstance(pinned, dict):
                    continue
                if (pinned.get("profile_home") != str(home)
                        or pinned.get("lease_id") in live_leases
                        or pinned.get("live_session_id") == owner["live_session_id"]):
                    continue
                original_session = pinned.get("session_id")
                if not isinstance(original_session, str) or not original_session:
                    continue
                if db.get_compression_tip(original_session) != owner["session_id"]:
                    continue
                event = {
                    "delivery_id": receipt["delivery_id"],
                    "claimed_at": receipt.get("claimed_at"),
                    "status": "outcome_unknown",
                }
                if receipt["delivery_id"] in retries:
                    event["retry_status"] = retries[receipt["delivery_id"]]
                interrupted.append(event)
    finally:
        db.close()
    return sorted(interrupted, key=lambda item: (item["claimed_at"] or 0, item["delivery_id"]))


def _reviewed_retry_id(delivery_id: str) -> str:
    from tools.bot_live_delivery import _delivery_id

    original_id = _delivery_id(delivery_id)
    return hashlib.sha256(f"jarvis-reviewed-retry:{original_id}".encode("ascii")).hexdigest()


def _review_context(profile_home: Path | str):
    from hermes_cli.active_sessions import active_session_registry_snapshot
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _root

    home = Path(profile_home).resolve()
    if not _root(home).is_dir():
        raise ValueError("no interrupted event is available for review")
    owner = find_jarvis_live_owner(home)
    if owner is None:
        raise ValueError("the Jarvis main chat is not open on this Mac")
    live_leases = {
        entry["lease_id"] for entry in active_session_registry_snapshot(
            registry_home=home, strict=True)
    }
    return home, owner, live_leases, SessionDB(db_path=home / "state.db", read_only=True)


def _reviewable_record(root: Path, delivery_id: str, home: Path, owner: dict[str, Any],
                       live_leases: set[str], db) -> dict[str, Any]:
    from tools.bot_live_delivery import _delivery_id, _read

    record = _read(root / f"{_delivery_id(delivery_id)}.json")
    pinned = record.get("owner") if record else None
    if not isinstance(pinned, dict) or record.get("status") != "claimed":
        raise ValueError("this event no longer awaits review")
    original_session = pinned.get("session_id")
    if (pinned.get("profile_home") != str(home)
            or pinned.get("lease_id") in live_leases
            or pinned.get("live_session_id") == owner["live_session_id"]
            or not isinstance(original_session, str)
            or not original_session
            or db.get_compression_tip(original_session) != owner["session_id"]):
        raise ValueError("this event does not belong to an interrupted Jarvis owner")
    if not isinstance(record.get("message"), str) or not record["message"].strip():
        raise ValueError("the original event is unavailable")
    return record


def review_interrupted_jarvis_event(profile_home: Path | str, delivery_id: str) -> dict[str, Any]:
    """Reveal one exact interrupted request to the owning profile, without dispatching it."""
    from tools.bot_live_delivery import _locked

    home, owner, live_leases, db = _review_context(profile_home)
    try:
        with _locked(home) as root:
            record = _reviewable_record(root, delivery_id, home, owner, live_leases, db)
            message = record["message"]
            digest = hashlib.sha256(f"{delivery_id}\0{message}".encode("utf-8")).hexdigest()
            return {"delivery_id": delivery_id, "message": message,
                    "review_digest": digest, "status": "outcome_unknown"}
    finally:
        db.close()


def retry_interrupted_jarvis_event(
    profile_home: Path | str, delivery_id: str, review_digest: str,
) -> dict[str, Any]:
    """Queue at most one new event after exact-content review, never replay the old claim.

    The new ID is stable across transport retries. A second click returns the
    same receipt; the original claimed record remains untouched and inspectable.
    """
    import time
    from tools.bot_live_delivery import _locked, _next_sequence, _owner, _read, _write

    retry_id = _reviewed_retry_id(delivery_id)
    home, owner, live_leases, db = _review_context(profile_home)
    try:
        with _locked(home) as root:
            path = root / f"{retry_id}.json"
            existing = _read(path)
            if existing is not None:
                if existing.get("reviewed_retry_of") != delivery_id:
                    raise ValueError("retry identity belongs to a different event")
                return {"delivery_id": retry_id, "status": existing["status"]}
            original = _reviewable_record(root, delivery_id, home, owner, live_leases, db)
            expected = hashlib.sha256(f"{delivery_id}\0{original['message']}".encode("utf-8")).hexdigest()
            if not isinstance(review_digest, str) or review_digest != expected:
                raise ValueError("the original event changed; review it again")
            pinned = _owner(home, owner)
            record = dict(delivery_id=retry_id, id=retry_id, owner=pinned, **pinned,
                          message=original["message"], status="queued", created_at=time.time_ns(),
                          sequence=_next_sequence(root), reviewed_retry_of=delivery_id)
            if isinstance(original.get("author"), dict):
                record["author"] = dict(original["author"])
            if original.get("notification_category") == "diagnostic":
                record["notification_category"] = "diagnostic"
            _write(path, record)
            return {"delivery_id": retry_id, "status": "queued"}
    finally:
        db.close()
