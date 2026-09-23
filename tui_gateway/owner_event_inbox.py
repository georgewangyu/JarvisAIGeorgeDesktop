"""Durable admission for events addressed to an exact live Bot Chat owner.

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

from tools.bot_live_delivery import deliver_to_live_owner, read_delivery_result


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


def owner_event_receipt(
    profile_home: Path | str, *, source: str, event_id: str,
) -> dict[str, Any] | None:
    """Inspect the exact event receipt after a producer or backend restart."""
    return read_delivery_result(profile_home, _event_delivery_id(source, event_id))
