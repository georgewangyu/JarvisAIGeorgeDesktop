"""Opaque OS wake tickets only nominate exact, opted-in deferred receipts."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


def _home(path: Path, *, enabled: bool = True) -> Path:
    from hermes_state import SessionDB

    path.mkdir()
    (path / "config.yaml").write_text(
        f"desktop:\n  jarvis_headless_event_activation: {str(enabled).lower()}\n",
        encoding="utf-8",
    )
    db = SessionDB(db_path=path / "state.db")
    db.create_session(session_id="main", source="desktop")
    db.set_session_title("main", "Jarvis")
    db.close()
    return path


def _ticket(home: Path, delivery_id: str) -> Path:
    return home / "runtime" / "jarvis_event_wake" / delivery_id


def test_ticket_requires_literal_producer_and_profile_opt_in(tmp_path):
    from tui_gateway.owner_event_inbox import admit_jarvis_event, read_jarvis_wake_ticket

    home = _home(tmp_path / "enabled")
    plain = admit_jarvis_event(home, source="calendar", event_id="plain", text="Check once")
    assert plain["status"] == "deferred"
    assert not _ticket(home, plain["id"]).exists()
    with pytest.raises(FileNotFoundError):
        read_jarvis_wake_ticket(home, plain["id"])
    with pytest.raises(ValueError, match="not opted in"):
        admit_jarvis_event(
            home, source="calendar", event_id="plain", text="Check once", queue_os_wake=True)
    with pytest.raises(ValueError, match="boolean"):
        admit_jarvis_event(home, source="calendar", event_id="wrong", text="Check", queue_os_wake="yes")

    disabled = _home(tmp_path / "disabled", enabled=False)
    with pytest.raises(ValueError, match="not enabled"):
        admit_jarvis_event(
            disabled, source="calendar", event_id="one", text="Check", queue_os_wake=True)
    assert not (disabled / "runtime" / "jarvis_event_wake").exists()


def test_exact_ticket_is_opaque_durable_and_idempotent_across_profiles(tmp_path):
    from tui_gateway.owner_event_inbox import admit_jarvis_event, read_jarvis_wake_ticket

    homes = [_home(tmp_path / name) for name in ("a", "b")]
    receipts = [admit_jarvis_event(
        home, source="calendar", event_id="same", text="Check once", queue_os_wake=True)
        for home in homes]
    assert receipts[0]["id"] == receipts[1]["id"]
    for home, receipt in zip(homes, receipts):
        ticket = _ticket(home, receipt["id"])
        assert ticket.is_file() and ticket.read_bytes() == b""
        assert ticket.stat().st_mode & 0o077 == 0
        assert read_jarvis_wake_ticket(home, receipt["id"]) == receipt
        assert admit_jarvis_event(
            home, source="calendar", event_id="same", text="Check once",
            queue_os_wake=True) == receipt
        assert list(ticket.parent.iterdir()) == [ticket]
        with pytest.raises(ValueError, match="different payload"):
            admit_jarvis_event(
                home, source="calendar", event_id="same", text="Changed",
                queue_os_wake=True)

    _ticket(homes[1], receipts[1]["id"]).unlink()
    with pytest.raises(FileNotFoundError):
        read_jarvis_wake_ticket(homes[1], receipts[0]["id"])
    assert read_jarvis_wake_ticket(homes[0], receipts[0]["id"])["profile_home"] == str(homes[0])


def test_interrupted_producer_leaves_inert_ticket_then_retry_commits(tmp_path, monkeypatch):
    from tui_gateway import owner_event_inbox as inbox

    home = _home(tmp_path / "home")
    # Simulate death at the only gap between durable marker and receipt write.
    from tools import bot_live_delivery

    def failed_write(*_args, **_kwargs):
        raise OSError("producer stopped before receipt commit")

    with monkeypatch.context() as patch:
        patch.setattr(bot_live_delivery, "_write", failed_write)
        with pytest.raises(OSError, match="producer stopped"):
            inbox.admit_jarvis_event(
                home, source="calendar", event_id="one", text="Check once",
                queue_os_wake=True)
    key = inbox._event_delivery_id("calendar", "one")
    assert _ticket(home, key).is_file()
    with pytest.raises(ValueError, match="no exact opted-in"):
        inbox.read_jarvis_wake_ticket(home, key)

    code = (
        "from tui_gateway.owner_event_inbox import admit_jarvis_event,read_jarvis_wake_ticket; "
        "import sys; home=sys.argv[1]; "
        "r=admit_jarvis_event(home,source='calendar',event_id='one',"
        "text='Check once',queue_os_wake=True); "
        "assert read_jarvis_wake_ticket(home,r['id'])['status']=='deferred'"
    )
    child = subprocess.run(
        [sys.executable, "-c", code, str(home)],
        cwd=Path(__file__).resolve().parents[2], env=os.environ.copy(),
        capture_output=True, text=True, timeout=15,
    )
    assert child.returncode == 0, child.stderr
    assert inbox.read_jarvis_wake_ticket(home, key)["status"] == "deferred"


def test_invalid_ticket_and_changed_owner_never_validate(tmp_path):
    from hermes_state import SessionDB
    from tools.bot_live_delivery import _locked, _read, _write
    from tui_gateway.owner_event_inbox import admit_jarvis_event, read_jarvis_wake_ticket

    home = _home(tmp_path / "home")
    receipt = admit_jarvis_event(
        home, source="calendar", event_id="one", text="Check once", queue_os_wake=True)
    ticket = _ticket(home, receipt["id"])
    with pytest.raises(ValueError, match="lowercase hex"):
        read_jarvis_wake_ticket(home, "../outside")
    ticket.write_text("not opaque", encoding="utf-8")
    with pytest.raises(ValueError, match="opaque private"):
        read_jarvis_wake_ticket(home, receipt["id"])
    ticket.unlink()
    ticket.symlink_to(home / "config.yaml")
    with pytest.raises(ValueError, match="opaque private"):
        read_jarvis_wake_ticket(home, receipt["id"])
    ticket.unlink()
    ticket.touch(mode=0o600)
    with _locked(home) as root:
        path = root / f"{receipt['id']}.json"
        stored = _read(path)
        stored["status"] = "claimed"
        _write(path, stored)
    with pytest.raises(ValueError, match="no exact opted-in"):
        read_jarvis_wake_ticket(home, receipt["id"])
    with _locked(home) as root:
        stored = _read(path)
        stored["status"] = "deferred"
        _write(path, stored)
    db = SessionDB(db_path=home / "state.db")
    db.set_session_archived("main", True)
    db.close()
    with pytest.raises(ValueError, match="no exact opted-in"):
        read_jarvis_wake_ticket(home, receipt["id"])


def test_replaced_queue_directory_is_rejected_without_following_symlink(tmp_path):
    from tui_gateway.owner_event_inbox import admit_jarvis_event, read_jarvis_wake_ticket

    home = _home(tmp_path / "home")
    receipt = admit_jarvis_event(
        home, source="calendar", event_id="one", text="Check once", queue_os_wake=True)
    queue = _ticket(home, receipt["id"]).parent
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    queue.rename(elsewhere / "original-queue")
    queue.symlink_to(elsewhere / "original-queue", target_is_directory=True)
    with pytest.raises(ValueError, match="private owned directory"):
        read_jarvis_wake_ticket(home, receipt["id"])
