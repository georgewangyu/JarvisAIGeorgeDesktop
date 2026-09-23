"""The permanent desktop chat can receive an event after reopening, without an idle model turn."""

import logging
import threading
from types import SimpleNamespace

from tui_gateway import methods_session
from tui_gateway.method_ctx import rebind


def _pin(lookup, *, source="desktop", tip="main", lazy=False, session_source="desktop"):
    session = {"source": session_source}
    claims = []
    db = SimpleNamespace(
        get_session_by_title=lambda title: lookup,
        get_compression_tip=lambda key: tip,
    )
    ctx = SimpleNamespace(lazy=lazy, params={"source": source}, db=db, target="main")
    pin = rebind(methods_session._resume_pin_jarvis_owner, {
        "_str_param": lambda params, key: str(params.get(key) or ""),
        "_sessions_lock": threading.RLock(),
        "_sessions": {"live": session},
        "_ensure_active_session_slot": lambda sid, record: claims.append((sid, record)) or None,
        "logger": logging.getLogger(__name__),
    })
    response = {"result": {"session_id": "live"}}
    assert pin(ctx, response) is response
    return claims


def test_reopening_the_exact_main_chat_claims_one_idle_delivery_owner():
    main = {"id": "main", "title": "Jarvis", "source": "desktop", "archived": False}
    assert len(_pin(main)) == 1


def test_unrelated_or_non_desktop_resume_does_not_claim_event_owner():
    main = {"id": "main", "title": "Jarvis", "source": "desktop", "archived": False}
    assert _pin(None) == []
    assert _pin(main, source="tui") == []
    assert _pin(main, lazy=True) == []
    assert _pin(main, tip="other") == []
    assert _pin(main, session_source="tui") == []
    assert _pin({**main, "archived": True}) == []
