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
