"""Opt-in, one-receipt Jarvis event consumer for a fresh gateway process.

This module does not watch a mailbox or start a service.  A caller supplies an
exact profile and delivery id; an absent or already claimed id does no model
work.  A claimed receipt with no terminal callback remains claimed after a
crash or timeout, so an operator can review its unknown outcome.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import threading
import uuid
from pathlib import Path
from typing import Any

_TURN_STOP_GRACE_SECONDS = 3.0


def _quarantine_wake_entry(home: Path, name: str) -> bool:
    """Move one still-present queue entry outside launchd's watched directory."""
    from tools.bot_live_delivery import _locked
    from tui_gateway.owner_event_inbox import _checked_wake_queue
    from utils import fsync_directory

    with _locked(home):
        queue = _checked_wake_queue(home)
        entry = queue / name
        try:
            entry.lstat()
        except FileNotFoundError:
            return False
        quarantine = home / "runtime" / "jarvis_event_wake_quarantine"
        quarantine.mkdir(mode=0o700, exist_ok=True)
        info = quarantine.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise ValueError("Jarvis wake quarantine is not a private owned directory")
        target = quarantine / f"{uuid.uuid4().hex}-{name[:120]}"
        entry.rename(target)
        fsync_directory(queue)
        fsync_directory(quarantine)
        return True


def scan_one_wake_ticket(
    profile: str, *, allow_headless: bool = False,
    wait_seconds: float = 120.0, expected_profile_home: Path | str | None = None,
) -> dict[str, Any]:
    """Scan one profile once; run at most one valid ticket and clear inert entries.

    Invalid and unclaimable entries remain recoverable outside the watched
    directory. This one-shot command does not install or manage an OS job.
    """
    if not allow_headless:
        raise ValueError("headless event consumption requires explicit opt-in")
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("an exact profile name is required")
    if expected_profile_home is None:
        raise ValueError("queue scan requires the exact expected profile home")

    from tui_gateway import server
    from tui_gateway.owner_event_inbox import _checked_wake_queue, read_jarvis_wake_ticket

    resolved = server._profile_home(profile.strip())
    home = Path(resolved or server._hermes_home).resolve()
    if home != Path(expected_profile_home).resolve():
        raise ValueError("resolved profile does not match the exact event home")
    try:
        queue = _checked_wake_queue(home)
    except FileNotFoundError:
        return {"status": "empty"}

    # Names are opaque nominations. Revalidation happens under the mailbox
    # lock in read_jarvis_wake_ticket and again in run_one_wake_ticket.
    candidate = None
    for entry in sorted(queue.iterdir(), key=lambda item: item.name):
        try:
            read_jarvis_wake_ticket(home, entry.name)
        except (OSError, ValueError):
            _quarantine_wake_entry(home, entry.name)
            continue
        if candidate is None:
            candidate = entry.name
    if candidate is None:
        return {"status": "empty"}
    try:
        return run_one_wake_ticket(
            profile, candidate, allow_headless=True,
            wait_seconds=wait_seconds, expected_profile_home=home)
    except Exception:
        # A competing desktop lease, changed owner, or race cannot leave a
        # watched ticket behind to relaunch indefinitely. Preserve for review.
        _quarantine_wake_entry(home, candidate)
        from tools.bot_live_delivery import read_delivery_result

        try:
            receipt = read_delivery_result(home, candidate)
        except (OSError, ValueError):
            receipt = None
        state = receipt.get("status") if isinstance(receipt, dict) else None
        if state in {"settled", "failed", "cancelled"}:
            status = state
        elif state == "deferred":
            status = "deferred_for_review"
        else:
            # Claimed and unreadable receipts have an unknown turn outcome.
            status = "unknown_for_review"
        return {"delivery_id": candidate, "status": status}


def _retire_consumed_wake_ticket(home: Path, delivery_id: str) -> bool:
    """Remove only this profile's ticket after its receipt can never be replayed.

    Keep deferred tickets when a lease or gateway admission fails. The mailbox
    lock serializes this check with the producer's ticket/receipt commit.
    """
    from tools.bot_live_delivery import _delivery_id, _locked, _read
    from tui_gateway.owner_event_inbox import _checked_wake_queue, _checked_wake_ticket
    from utils import fsync_directory

    key = _delivery_id(delivery_id)
    with _locked(home) as root:
        receipt = _read(root / f"{key}.json")
        if (receipt is None or receipt.get("delivery_id") != key
                or receipt.get("id") != key
                or receipt.get("profile_home") != str(home)
                or receipt.get("os_wake_requested") is not True
                or receipt.get("status") not in {"claimed", "settled", "failed", "cancelled"}):
            return False
        try:
            queue = _checked_wake_queue(home)
            ticket = _checked_wake_ticket(queue, key)
        except (FileNotFoundError, ValueError):
            # An invalid ticket is not ours to unlink; preserve the original
            # validation failure instead of masking it during cleanup.
            return False
        ticket.unlink()
        fsync_directory(queue)
        return True


def run_one_wake_ticket(
    profile: str, delivery_id: str, *, allow_headless: bool = False,
    wait_seconds: float = 120.0, expected_profile_home: Path | str | None = None,
) -> dict[str, Any]:
    """Consume one exact, opted-in OS ticket through the existing event path.

    A claimed receipt is an unknown outcome and is never retried. A terminal
    receipt also cannot run again. Both may have a leftover ticket after a
    crash, which this entrypoint can retire without starting a model turn.
    """
    if not allow_headless:
        raise ValueError("headless event consumption requires explicit opt-in")
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("an exact profile name is required")

    from tui_gateway import server
    from tui_gateway.owner_event_inbox import read_jarvis_wake_ticket

    resolved = server._profile_home(profile.strip())
    home = Path(resolved or server._hermes_home).resolve()
    if expected_profile_home is not None and home != Path(expected_profile_home).resolve():
        raise ValueError("resolved profile does not match the exact event home")
    try:
        read_jarvis_wake_ticket(home, delivery_id)
    except (FileNotFoundError, ValueError):
        _retire_consumed_wake_ticket(home, delivery_id)
        raise
    try:
        return run_one_deferred_event(
            profile, delivery_id, allow_headless=True,
            wait_seconds=wait_seconds, expected_profile_home=home,
        )
    finally:
        _retire_consumed_wake_ticket(home, delivery_id)


class _DiscardTransport:
    """Headless turns have no human client to answer requests or render events."""

    def write(self, _frame: dict) -> bool:
        return True

    def close(self) -> None:
        pass


def run_one_deferred_event(
    profile: str, delivery_id: str, *, allow_headless: bool = False,
    wait_seconds: float = 120.0, expected_profile_home: Path | str | None = None,
) -> dict[str, Any]:
    """Run at most one exact deferred event through the gateway session turn.

    This requires an empty gateway process: gateway state, environment and
    agent hooks are process-wide.  No agent is built until the exact receipt,
    permanent desktop conversation and exclusive lease have been verified.
    """
    if not allow_headless:
        raise ValueError("headless event consumption requires explicit opt-in")
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("an exact profile name is required")
    if not isinstance(wait_seconds, (int, float)) or not 0 < wait_seconds <= 3600:
        raise ValueError("wait_seconds must be between 0 and 3600")

    from hermes_cli.active_sessions import try_acquire_active_session
    from tools.bot_live_delivery import (
        complete_delivery, find_jarvis_main_session_id, read_delivery_result,
    )
    from tui_gateway import server
    from tui_gateway.headless_owner_event_token import resume_creation_token
    from tui_gateway.owner_event_inbox import claim_deferred_jarvis_event_for_headless_owner
    from tui_gateway.transport import bind_transport, reset_transport
    from tui_gateway.turn_marker import read_turn_marker

    with server._sessions_lock:
        if server._sessions:
            raise RuntimeError("headless event consumption requires a fresh gateway process")
    resolved = server._profile_home(profile.strip())
    home = Path(resolved or server._hermes_home).resolve()
    if expected_profile_home is not None and home != Path(expected_profile_home).resolve():
        raise ValueError("resolved profile does not match the exact event home")
    receipt = read_delivery_result(home, delivery_id)
    if receipt is None:
        raise FileNotFoundError("exact event receipt not found in profile")
    if receipt.get("status") != "deferred" or receipt.get("profile_home") != str(home):
        raise ValueError("event is not deferred for the exact profile")
    session_id = find_jarvis_main_session_id(home)
    if not session_id or receipt.get("target_session_id") != session_id:
        raise ValueError("event does not target the permanent Jarvis desktop chat")
    if read_turn_marker(home, session_id) is not None:
        raise RuntimeError("Jarvis chat has an interrupted turn requiring review")

    live_id = uuid.uuid4().hex
    with server._session_profile_runtime_scope({"profile_home": str(home)}):
        config = server._load_cfg()
    lease, refusal = try_acquire_active_session(
        session_id=session_id, surface="jarvis-event", config=config,
        registry_home=home, track_liveness=True,
        metadata={"live_session_id": live_id, "jarvis_event_consumer": True},
    )
    if refusal is not None or lease is None:
        raise RuntimeError(f"Jarvis chat has another owner or no safe lease: {refusal}")

    sink = _DiscardTransport()
    token = bind_transport(sink)
    sid: str | None = None
    owned_session = False
    session: dict[str, Any] | None = None
    worker: threading.Thread | None = None
    try:
        creation_token = resume_creation_token.set(live_id)
        try:
            response = server.handle_request({
                "jsonrpc": "2.0", "id": "jarvis-event-resume", "method": "session.resume",
                "params": {"session_id": session_id, "profile": profile.strip(),
                           "source": "jarvis-event", "eager_build": True},
            })
        finally:
            resume_creation_token.reset(creation_token)
        result = response.get("result") if isinstance(response, dict) else None
        sid = result.get("session_id") if isinstance(result, dict) else None
        if not isinstance(sid, str) or not sid:
            raise RuntimeError(f"Jarvis session resume failed: {(response or {}).get('error')}")
        with server._sessions_lock:
            session = server._sessions.get(sid)
            exact_runtime = set(server._sessions) == {sid}
        if (not exact_runtime or session is None or session.get("source") != "jarvis-event"
                or session.get("_headless_creation_token") != live_id
                or session.get("session_key") != session_id
                or Path(session.get("profile_home") or server._hermes_home).resolve() != home
                or session.get("transport") is not sink
                or session.get("active_session_lease") is not None):
            raise RuntimeError("resumed session did not prove exact headless ownership")
        owned_session = True
        if server._session_uses_compute_host(session) is not False:
            raise RuntimeError("headless event refuses compute-host turn isolation")
        session["active_session_lease"] = lease
        owner = {"profile_home": str(home), "session_id": session_id,
                 "lease_id": lease.lease_id, "live_session_id": live_id}
        finished = threading.Event()
        terminal: dict[str, Any] = {}

        def settle(outcome: dict[str, Any]) -> None:
            status = str(outcome.get("status") or "failed")
            if status not in {"settled", "cancelled"}:
                status = "failed"
            terminal["receipt"] = complete_delivery(
                home, delivery_id, status=status,
                reply=str(outcome.get("text") or "") if status == "settled" else "",
                error=str(outcome.get("error") or ""),
                reason="cancelled" if status == "cancelled" else "",
            )
            finished.set()

        with server._session_turn_admission(session) as admitted:
            if not admitted or session.get("running") or session.get("_closing"):
                raise RuntimeError("Jarvis session is not idle for one event turn")
            claimed = claim_deferred_jarvis_event_for_headless_owner(
                home, delivery_id, owner, allow_headless=True)
            session["running"] = True
        try:
            started = server._run_prompt_submit(
                f"__jarvis_event__{delivery_id}", sid, session, claimed["message"],
                image_paths=[], display_kind="hidden", terminal_callback=settle)
        except Exception as exc:
            settle({"status": "failed", "error": str(exc)})
            raise
        if not started:
            settle({"status": "failed", "error": "gateway refused the claimed event turn"})
        if not finished.wait(wait_seconds):
            agent = session.get("agent")
            if agent is not None:
                agent.interrupt()
            # A late completion may still settle; otherwise the claimed receipt
            # remains an unknown outcome and is never replayed automatically.
            finished.wait(_TURN_STOP_GRACE_SECONDS)
        worker = session.get("_run_thread")
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=_TURN_STOP_GRACE_SECONDS)
        return terminal.get("receipt") or read_delivery_result(home, delivery_id)
    finally:
        if owned_session and worker is None and session is not None:
            worker = session.get("_run_thread")

        def release_after_turn() -> None:
            try:
                if sid is not None and owned_session:
                    server._close_session_by_id(sid, end_reason="jarvis_event_consumed")
            finally:
                lease.release()

        try:
            # A timed-out or post-receipt worker may still be writing history.
            # Keep its exclusive lease until the actual worker exits, including
            # when this callable runs inside a longer-lived host process.
            if worker is not None and worker.is_alive():
                def finish_later() -> None:
                    worker.join()
                    release_after_turn()

                cleanup = threading.Thread(target=finish_later, name="jarvis-event-cleanup", daemon=True)
                try:
                    cleanup.start()
                except Exception:
                    finish_later()  # no safe bounded release if a watcher cannot start
            else:
                release_after_turn()
        finally:
            reset_transport(token)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Consume one exact deferred Jarvis event")
    parser.add_argument("--profile", required=True)
    parser.add_argument("--delivery-id")
    parser.add_argument("--allow-headless", action="store_true")
    parser.add_argument("--wait-seconds", type=float, default=120.0)
    parser.add_argument("--expected-profile-home")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--wake-ticket", action="store_true",
                      help="require one exact opted-in opaque OS wake ticket")
    mode.add_argument("--scan-wake-queue", action="store_true",
                      help="scan one exact profile's opaque OS wake queue once")
    args = parser.parse_args(argv)
    if args.scan_wake_queue:
        if args.delivery_id is not None or args.expected_profile_home is None:
            parser.error("queue scan requires --expected-profile-home and no --delivery-id")
        receipt = scan_one_wake_ticket(
            args.profile, allow_headless=args.allow_headless,
            wait_seconds=args.wait_seconds, expected_profile_home=args.expected_profile_home)
    else:
        if args.delivery_id is None:
            parser.error("--delivery-id is required outside queue scan mode")
        consumer = run_one_wake_ticket if args.wake_ticket else run_one_deferred_event
        receipt = consumer(
            args.profile, args.delivery_id, allow_headless=args.allow_headless,
            wait_seconds=args.wait_seconds, expected_profile_home=args.expected_profile_home)
    print(json.dumps({key: receipt[key] for key in ("delivery_id", "status") if key in receipt}), flush=True)
    return 0 if receipt["status"] in {"empty", "settled", "failed", "cancelled", "deferred_for_review"} else 2


if __name__ == "__main__":
    result_code = main()
    if result_code == 2:
        # A claimed/unknown turn may still have a daemon worker.  Normal
        # atexit gateway teardown would release its lease before process death.
        os._exit(result_code)
    raise SystemExit(result_code)
