"""Durable admission for events addressed to an exact live assistant owner.

This is an adapter over the existing live-owner mailbox. Its receipt proves
admission to that owner's inbox, not that a model turn ran or a reply arrived.
The session notification poller remains the only consumer. Claimed records
remain claimed after a crash, where the turn outcome is ambiguous; they are
never silently replayed into a possibly completed turn.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from tools.bot_live_delivery import deliver_to_live_owner, find_jarvis_live_owner, read_delivery_result


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
    """Admit an event to the currently live permanent desktop chat only.

    This does not start a backend or promise delivery after the Mac app exits.
    An identical retry returns its original receipt even after the owner exits;
    a new event without a live owner is refused rather than queued for a wrong chat.
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
    if owner is None:
        raise RuntimeError("the Jarvis main chat has no live desktop owner")
    return admit_owner_event(profile_home, owner, source=source, event_id=event_id, text=text)


def owner_event_receipt(
    profile_home: Path | str, *, source: str, event_id: str,
) -> dict[str, Any] | None:
    """Inspect the exact event receipt after a producer or backend restart."""
    return read_delivery_result(profile_home, _event_delivery_id(source, event_id))


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
            for path in root.glob("*.json"):
                receipt = _scan_read(path)
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
                interrupted.append({
                    "delivery_id": receipt["delivery_id"],
                    "claimed_at": receipt.get("claimed_at"),
                    "status": "outcome_unknown",
                })
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
