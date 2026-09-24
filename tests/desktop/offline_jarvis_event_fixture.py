"""Test-owned loopback profile for a Jarvis event admitted before Desktop opens.

Manual rehearsal with an unsigned package:
    python tests/desktop/offline_jarvis_event_fixture.py init --root <empty-temp-dir>
    python tests/desktop/offline_jarvis_event_fixture.py serve --root <same-dir>
    # In another shell, launch the packaged app with HERMES_HOME=<root>/hermes-home
    # and HERMES_DESKTOP_USER_DATA_DIR=<root>/user-data.
    python tests/desktop/offline_jarvis_event_fixture.py status --root <same-dir>

Only one exact synthetic event is accepted. The model answers only that event;
all data and the loopback endpoint remain inside the disposable root.
"""

from __future__ import annotations

import argparse
import json
import socket
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

MARKER = ".jarvis-offline-event-fixture"
KIND = "jarvis-offline-event-fixture-v1"
SOURCE = "synthetic"
EVENT_ID = "offline-1"
EVENT_TEXT = "Summarize this test-owned event in one sentence."
EVENT_MESSAGE = f"[Event from {SOURCE}; id {EVENT_ID}]\n{EVENT_TEXT}"
REPLY = "Jarvis received the synthetic offline event after reopening."


def read_fixture(root: Path) -> dict:
    if root.is_symlink() or not (root / MARKER).is_file():
        raise ValueError("not an owned offline-event fixture")
    data = json.loads((root / MARKER).read_text(encoding="utf-8"))
    if data.get("kind") != KIND or data.get("root") != str(root):
        raise ValueError("offline-event fixture ownership mismatch")
    return data


def init(root: Path) -> dict:
    if root.is_symlink() or (root.exists() and any(root.iterdir())):
        raise ValueError("fixture root must be a unique empty directory")
    root.mkdir(parents=True, exist_ok=True)
    home = root / "hermes-home"
    home.mkdir(mode=0o700)
    (root / "user-data").mkdir(mode=0o700)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
    (home / "config.yaml").write_text(
        "model:\n  default: offline-fixture-model\n  provider: custom:offline-fixture\n"
        "auxiliary:\n  title_generation:\n    enabled: false\n"
        "providers:\n  offline-fixture:\n"
        f"    api: http://127.0.0.1:{port}/v1\n"
        "    transport: chat_completions\n"
        "    default_model: offline-fixture-model\n"
        "    key_env: OFFLINE_FIXTURE_API_KEY\n",
        encoding="utf-8",
    )
    (home / ".env").write_text("OFFLINE_FIXTURE_API_KEY=synthetic-loopback-only\n", encoding="utf-8")
    (home / ".env").chmod(0o600)
    from hermes_state import SessionDB
    from tui_gateway.owner_event_inbox import admit_jarvis_event

    session_id = f"jarvis-fixture-{uuid.uuid4().hex}"
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session(session_id, "desktop", profile_name="default")
        db.set_session_title(session_id, "Jarvis")
        db.append_message(session_id, "assistant", "Synthetic Jarvis chat, waiting for one offline event.")
    finally:
        db.close()
    receipt = admit_jarvis_event(home, source=SOURCE, event_id=EVENT_ID, text=EVENT_TEXT)
    if receipt["status"] != "deferred":
        raise AssertionError("event must be deferred before Desktop opens")
    data = {"kind": KIND, "root": str(root), "port": port,
            "session_id": session_id, "delivery_id": receipt["id"]}
    marker = root / MARKER
    marker.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    marker.chmod(0o600)
    (root / "model-calls.json").write_text("[]\n", encoding="utf-8")
    return data


def status(root: Path) -> dict:
    from tui_gateway.owner_event_inbox import owner_event_receipt

    data = read_fixture(root)
    receipt = owner_event_receipt(root / "hermes-home", source=SOURCE, event_id=EVENT_ID)
    calls = json.loads((root / "model-calls.json").read_text(encoding="utf-8"))
    return {"receipt_status": receipt["status"] if receipt else "missing",
            "reply": receipt.get("reply") if receipt else None,
            "model_calls": len(calls), "port": data["port"]}


def serve(root: Path) -> None:
    import uvicorn

    data = read_fixture(root)
    app = FastAPI()

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": "offline-fixture-model", "object": "model"}]}

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        body = await request.json()
        messages = body.get("messages") or []
        if not any(isinstance(message, dict) and message.get("role") == "user"
                   and message.get("content") == EVENT_MESSAGE for message in messages):
            raise HTTPException(status_code=409, detail="only the synthetic offline event is supported")
        calls_path = root / "model-calls.json"
        calls = json.loads(calls_path.read_text(encoding="utf-8"))
        calls.append({"event": EVENT_ID})
        calls_path.write_text(json.dumps(calls) + "\n", encoding="utf-8")
        if body.get("stream"):
            frames = [
                {"id": "fixture-offline", "object": "chat.completion.chunk", "model": "offline-fixture-model",
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": REPLY}, "finish_reason": None}]},
                {"id": "fixture-offline", "object": "chat.completion.chunk", "model": "offline-fixture-model",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            return Response("".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n",
                            media_type="text/event-stream")
        return JSONResponse({"id": "fixture-offline", "object": "chat.completion",
                             "model": "offline-fixture-model", "choices": [{"index": 0,
                             "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}]})

    uvicorn.run(app, host="127.0.0.1", port=data["port"], log_level="warning")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "status"))
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=False)
    if args.command == "init":
        print(json.dumps(init(root), indent=2))
    elif args.command == "serve":
        serve(root)
    else:
        print(json.dumps(status(root), indent=2))


if __name__ == "__main__":
    main()
