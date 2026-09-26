"""Disposable loopback Desktop chat with one real gateway approval request.

Manual rehearsal, from the repo root with its Python environment::

    python tests/desktop/test_tool_approval_fixture.py start --root /tmp/hermes-approval-UNIQUE
    # Add the printed URL/token as a Desktop remote connection and open the
    # saved "Synthetic approval rehearsal" chat before triggering.
    python tests/desktop/test_tool_approval_fixture.py trigger --root /tmp/hermes-approval-UNIQUE
    # Or send the exact text "Request the synthetic approval action." in that
    # chat. The loopback model requests a permission change on a dummy file in
    # fixture's sandbox-target directory; approve or reject the card.
    # To rehearse one background child in the same saved chat, send the exact
    # text "Run the synthetic delegate check." The loopback model delays the
    # child's tool-free response so its running state can be inspected.
    # "Run the synthetic failing delegate check." requests an isolated child
    # whose loopback provider fails, without performing any external action.
    # "Run the synthetic delegated approval check." starts a child that asks
    # twice to change only a dummy fixture file. Deny both approval cards to
    # inspect the wait, retry, and final no-action outcome.
    python tests/desktop/test_tool_approval_fixture.py status --root /tmp/hermes-approval-UNIQUE
    # After stopping/crashing only this fixture process, reuse its exact
    # test-owned root and token to inspect gateway-restart behavior:
    python tests/desktop/test_tool_approval_fixture.py resume --root /tmp/hermes-approval-UNIQUE
    python tests/desktop/test_tool_approval_fixture.py stop --root /tmp/hermes-approval-UNIQUE

The explicit trigger uses a synthetic tool name with no executor. The approval
rehearsal uses a deterministic local mock to request a real terminal tool, but
its only command changes a dummy file inside a private test-owned directory.
The delegate rehearsal makes one background child with no executable action.
The status command reports the explicit trigger's gate state, not the model
rehearsal; stop shuts down only this exact foreground fixture. No real model
or account is used.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from fastapi import Request as FastAPIRequest


ROOT = Path(__file__).resolve().parents[2]
MARKER = ".hermes-desktop-tool-approval-fixture"
KIND = "hermes-desktop-tool-approval-fixture-v1"
MODEL_APPROVAL_PROMPT = "Request the synthetic approval action."
MODEL_BACKGROUND_SUCCESS_PROMPT = "Finish the synthetic background check."
MODEL_BACKGROUND_FAILURE_PROMPT = "Fail the synthetic background check."
MODEL_DELEGATE_PROMPT = "Run the synthetic delegate check."
MODEL_DELEGATE_CHILD_GOAL = "Return the synthetic child check result. Do not use tools."
MODEL_DELEGATE_CHILD_RESULT = "The synthetic child check finished."
MODEL_DELEGATE_RESULT = "The synthetic delegate check finished."
MODEL_DELEGATE_FAILURE_PROMPT = "Run the synthetic failing delegate check."
MODEL_DELEGATE_FAILURE_CHILD_GOAL = "Attempt the synthetic unavailable child check. Do not use tools."
MODEL_DELEGATE_APPROVAL_PROMPT = "Run the synthetic delegated approval check."
MODEL_DELEGATE_APPROVAL_CHILD_GOAL = "Request the synthetic child action and report whether it was denied."
MODEL_DELEGATE_APPROVAL_DENIED = "The background action was denied twice and did not run."
MODEL_DELEGATE_APPROVAL_ALLOWED = "The background action was allowed and finished."
MODEL_DELEGATE_APPROVAL_RESULT = "The background action could not run without permission."


def fixture_completion(body: dict, root: Path) -> tuple[dict, str]:
    """One deterministic model tool call, then a denial-aware final answer.

    The only possible command targets a directory owned by this fixture.
    Requests unrelated to the exact rehearsal phrase are refused.
    """
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise ValueError("model messages required")
    user_index = next((index for index in range(len(messages) - 1, -1, -1)
                       if isinstance(messages[index], dict) and messages[index].get("role") == "user"), -1)
    if user_index < 0:
        raise ValueError("only synthetic approval or background-check rehearsals are supported")
    user_content = messages[user_index].get("content")
    if user_content == MODEL_DELEGATE_CHILD_GOAL:
        return {"role": "assistant", "content": MODEL_DELEGATE_CHILD_RESULT}, "stop"
    if user_content == MODEL_DELEGATE_APPROVAL_CHILD_GOAL:
        after_user = messages[user_index + 1:]
        tool_results = [item for item in after_user
                        if isinstance(item, dict) and item.get("role") == "tool"]
        if tool_results:
            raw_result = tool_results[-1].get("content")
            try:
                result = json.loads(raw_result) if isinstance(raw_result, str) else raw_result
            except json.JSONDecodeError:
                result = {}
            if isinstance(result, dict) and result.get("exit_code") == 0:
                return {"role": "assistant", "content": MODEL_DELEGATE_APPROVAL_ALLOWED}, "stop"
            if not isinstance(result, dict) or result.get("status") != "blocked":
                return {"role": "assistant", "content": "The background action could not finish."}, "stop"
        if len(tool_results) >= 2:
            return {"role": "assistant", "content": MODEL_DELEGATE_APPROVAL_DENIED}, "stop"
        command = f"chmod 666 {root / 'sandbox-target' / 'delegate-approval-marker'}"
        return {
            "role": "assistant", "content": None,
            "tool_calls": [{"index": 0, "id": f"call_synthetic_child_approval_{len(tool_results) + 1}",
                            "type": "function", "function": {"name": "terminal",
                            "arguments": json.dumps({"command": command})}}],
        }, "tool_calls"
    if user_content in {MODEL_DELEGATE_PROMPT, MODEL_DELEGATE_FAILURE_PROMPT,
                        MODEL_DELEGATE_APPROVAL_PROMPT}:
        after_user = messages[user_index + 1:]
        if any(isinstance(item, dict) and item.get("role") == "tool" for item in after_user):
            return {"role": "assistant", "content": "The background check is running."}, "stop"
        child_goal = {
            MODEL_DELEGATE_PROMPT: MODEL_DELEGATE_CHILD_GOAL,
            MODEL_DELEGATE_FAILURE_PROMPT: MODEL_DELEGATE_FAILURE_CHILD_GOAL,
            MODEL_DELEGATE_APPROVAL_PROMPT: MODEL_DELEGATE_APPROVAL_CHILD_GOAL,
        }[user_content]
        return {
            "role": "assistant", "content": None,
            "tool_calls": [{"index": 0, "id": "call_synthetic_delegate", "type": "function",
                            "function": {"name": "delegate_task", "arguments": json.dumps({
                                "tasks": [{"goal": child_goal}],
                            })}}],
        }, "tool_calls"
    if (isinstance(user_content, str)
            and user_content.startswith("[ASYNC DELEGATION BATCH COMPLETE — ")
            and MODEL_DELEGATE_CHILD_GOAL in user_content
            and MODEL_DELEGATE_CHILD_RESULT in user_content):
        return {"role": "assistant", "content": MODEL_DELEGATE_RESULT}, "stop"
    if (isinstance(user_content, str)
            and user_content.startswith("[ASYNC DELEGATION BATCH COMPLETE — ")
            and MODEL_DELEGATE_FAILURE_CHILD_GOAL in user_content
            and "status=failed" in user_content):
        return {"role": "assistant", "content": "The background check could not finish."}, "stop"
    if (isinstance(user_content, str)
            and user_content.startswith("[ASYNC DELEGATION BATCH COMPLETE — ")
            and MODEL_DELEGATE_APPROVAL_CHILD_GOAL in user_content
            and MODEL_DELEGATE_APPROVAL_DENIED in user_content):
        return {"role": "assistant", "content": MODEL_DELEGATE_APPROVAL_RESULT}, "stop"
    if (isinstance(user_content, str)
            and user_content.startswith("[ASYNC DELEGATION BATCH COMPLETE — ")
            and MODEL_DELEGATE_APPROVAL_CHILD_GOAL in user_content
            and MODEL_DELEGATE_APPROVAL_ALLOWED in user_content):
        return {"role": "assistant", "content": "The background action finished."}, "stop"
    if user_content != MODEL_APPROVAL_PROMPT:
        if user_content == MODEL_BACKGROUND_SUCCESS_PROMPT:
            return {"role": "assistant", "content": "The synthetic background check finished."}, "stop"
        raise ValueError("only synthetic approval, background-check, or delegate rehearsals are supported")
    after_user = messages[user_index + 1:]
    tool_results = [message for message in after_user
                    if isinstance(message, dict) and message.get("role") == "tool"]
    if tool_results:
        raw_result = tool_results[-1].get("content")
        try:
            result = json.loads(raw_result) if isinstance(raw_result, str) else raw_result
        except json.JSONDecodeError:
            result = {}
        denied = isinstance(result, dict) and result.get("status") == "blocked"
        content = ("The synthetic action was denied and was not run." if denied
                   else "The synthetic command returned a result; check the tool row for its outcome.")
        return {"role": "assistant", "content": content}, "stop"
    command = f"chmod 666 {root / 'sandbox-target' / 'approval-marker'}"
    return {
        "role": "assistant", "content": None,
        "tool_calls": [{"index": 0, "id": "call_synthetic_approval", "type": "function",
                        "function": {"name": "terminal", "arguments": json.dumps({"command": command})}}],
    }, "tool_calls"


def fixture_sse(message: dict, finish_reason: str) -> str:
    delta = {key: value for key, value in message.items() if key in {"role", "content", "tool_calls"}}
    frames = [
        {"id": "fixture-approval", "object": "chat.completion.chunk", "model": "approval-fixture-model",
         "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
        {"id": "fixture-approval", "object": "chat.completion.chunk", "model": "approval-fixture-model",
         "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]},
    ]
    return "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"


def isolated_environment(root: Path, token: str | None = None) -> dict[str, str]:
    """Keep ambient account/provider credentials out of the test gateway."""
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({"HOME": str(root), "HERMES_HOME": str(root / "hermes-home"),
                "PYTHONPATH": str(ROOT), "HERMES_SERVE_HEADLESS": "1",
                "HERMES_GATEWAY_SESSION": "1", "HERMES_EXEC_ASK": "1"})
    if token is not None:
        env["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    return env


def paths(root: Path) -> tuple[Path, Path, Path]:
    return root / MARKER, root / "hermes-home", root / "approval-state.json"


def read_fixture(root: Path) -> dict:
    marker, _home, _state = paths(root)
    if root.is_symlink() or not marker.is_file():
        raise ValueError(f"Not an owned fixture root: {root}")
    data = json.loads(marker.read_text(encoding="utf-8"))
    if data.get("kind") != KIND or data.get("root") != str(root):
        raise ValueError(f"Fixture ownership marker mismatch: {marker}")
    return data


def create_fixture(root: Path) -> dict:
    if root.is_symlink() or (root.exists() and any(root.iterdir())):
        raise ValueError(f"Fixture root must be a unique empty directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    marker, home, state = paths(root)
    home.mkdir()
    (root / "sandbox-target").mkdir(mode=0o700)
    marker_file = root / "sandbox-target" / "approval-marker"
    marker_file.write_text("synthetic fixture\n", encoding="utf-8")
    marker_file.chmod(0o600)
    child_marker_file = root / "sandbox-target" / "delegate-approval-marker"
    child_marker_file.write_text("synthetic delegated fixture\n", encoding="utf-8")
    child_marker_file.chmod(0o600)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
    (home / "config.yaml").write_text(
        "approvals:\n  mode: manual\n  timeout: 90\n"
        "model:\n  default: approval-fixture-model\n"
        "  provider: custom:approval-fixture\n"
        "auxiliary:\n  title_generation:\n    enabled: false\n"
        "providers:\n  approval-fixture:\n"
        f"    api: http://127.0.0.1:{port}/v1\n"
        "    transport: chat_completions\n"
        "    default_model: approval-fixture-model\n"
        "    key_env: APPROVAL_FIXTURE_API_KEY\n",
        encoding="utf-8",
    )
    from hermes_state import SessionDB

    session_id = f"synthetic-approval-{uuid.uuid4().hex}"
    db = SessionDB(home / "state.db")
    try:
        db.create_session(session_id, "desktop", cwd=str(root), profile_name="default")
        db.set_session_title(session_id, "Synthetic approval rehearsal")
        db.append_message(session_id, "user", "Show me the synthetic approval flow.")
        db.append_message(session_id, "assistant", "Open this chat and send the exact synthetic approval prompt. It changes only a dummy file inside a private test directory; you can approve or reject it.")
    finally:
        db.close()
    data = {"kind": KIND, "root": str(root), "session_id": session_id,
            "session_token": secrets.token_urlsafe(32), "port": port}
    marker.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    marker.chmod(0o600)
    state.write_text(json.dumps({"state": "ready", "tool_executed": False}) + "\n", encoding="utf-8")
    return data


def load_fixture_for_resume(root: Path) -> dict:
    data = read_fixture(root)
    _marker, _home, state_path = paths(root)
    current = json.loads(state_path.read_text(encoding="utf-8"))
    if current.get("state") == "waiting":
        # Only the old process held the executable approval queue. Do not
        # report that stale state as a live approval or infer its outcome.
        pending_path = state_path.with_suffix(".tmp")
        pending_path.write_text(
            json.dumps({**current, "state": "interrupted", "outcome": "unknown", "pending": False}) + "\n",
            encoding="utf-8",
        )
        os.replace(pending_path, state_path)
    return data


def serve(root: Path, *, resume: bool = False) -> None:
    # In particular, never let a cold session build see the caller's provider
    # tokens, even when this fixture is launched manually from a signed-in shell.
    fixture_env = isolated_environment(root)
    os.environ.clear()
    os.environ.update(fixture_env)
    os.environ["APPROVAL_FIXTURE_API_KEY"] = "synthetic-loopback-only"
    data = load_fixture_for_resume(root) if resume else create_fixture(root)
    _marker, _home, state_path = paths(root)
    # Import the production app only after binding it to this disposable home.
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = data["session_token"]

    from fastapi import Header, HTTPException, Response
    import uvicorn
    from hermes_cli.web_server import app, _configure_auth_gate
    from tui_gateway import server as gateway
    from tools import approval, approval_context

    _configure_auth_gate("127.0.0.1", False, None, None)
    app.state.bound_host = "127.0.0.1"
    app.state.initial_profile = ""
    lock = threading.Lock()
    worker: threading.Thread | None = None
    server: uvicorn.Server | None = None

    def require_token(token: str | None) -> None:
        if not token or not secrets.compare_digest(token, data["session_token"]):
            raise HTTPException(status_code=401, detail="fixture token required")

    def write_state(value: dict) -> None:
        pending_path = state_path.with_suffix(".tmp")
        pending_path.write_text(json.dumps({**value, "tool_executed": False}) + "\n", encoding="utf-8")
        os.replace(pending_path, state_path)

    @app.get("/fixture/approval/status")
    def fixture_status(x_hermes_session_token: str | None = Header(default=None)):
        require_token(x_hermes_session_token)
        marker_file = root / "sandbox-target" / "approval-marker"
        return {**json.loads(state_path.read_text(encoding="utf-8")),
                "model_action_executed": marker_file.is_file() and (marker_file.stat().st_mode & 0o777) == 0o666}

    @app.get("/v1/models")
    def fixture_models():
        return {"object": "list", "data": [{"id": "approval-fixture-model", "object": "model"}]}

    @app.post("/v1/chat/completions")
    async def fixture_model(request: FastAPIRequest):
        body = await request.json()
        messages = body.get("messages")
        if isinstance(messages, list):
            latest_user = next((item.get("content") for item in reversed(messages)
                                if isinstance(item, dict) and item.get("role") == "user"), None)
            if latest_user in {MODEL_BACKGROUND_SUCCESS_PROMPT, MODEL_BACKGROUND_FAILURE_PROMPT,
                               MODEL_DELEGATE_CHILD_GOAL, MODEL_DELEGATE_FAILURE_CHILD_GOAL}:
                # Allow a native test to leave the owning chat before the
                # provider returns. No external model or user data is touched.
                await asyncio.sleep(8)
                if latest_user in {MODEL_BACKGROUND_FAILURE_PROMPT, MODEL_DELEGATE_FAILURE_CHILD_GOAL}:
                    raise HTTPException(status_code=503, detail="synthetic provider unavailable")
        try:
            message, finish_reason = fixture_completion(body, root)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if body.get("stream"):
            return Response(fixture_sse(message, finish_reason), media_type="text/event-stream")
        return {
            "id": "fixture-approval", "object": "chat.completion", "model": "approval-fixture-model",
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        }

    @app.post("/fixture/approval/trigger")
    def fixture_trigger(x_hermes_session_token: str | None = Header(default=None)):
        nonlocal worker
        require_token(x_hermes_session_token)
        with lock:
            current = json.loads(state_path.read_text(encoding="utf-8"))
            if current["state"] != "ready":
                raise HTTPException(status_code=409, detail="fixture approval already triggered")
            live = gateway._find_live_session_by_key(data["session_id"])
            if live is None or not gateway._session_has_live_transport(live[1]):
                raise HTTPException(status_code=409, detail="open the saved chat in Desktop first")
            sid, session = live
            key = session["session_key"]
            # approval.respond currently calls _sess(), so do not trigger a
            # request until the loopback-only agent has finished initializing.
            ready = session.get("agent_ready")
            if ready is not None and not ready.wait(timeout=10):
                raise HTTPException(status_code=409, detail="synthetic chat is still opening")
            if session.get("agent") is None or session.get("agent_error"):
                raise HTTPException(status_code=409, detail="synthetic agent could not initialize")
            write_state({"state": "waiting", "session_id": sid})
            approval.register_gateway_notify(key, lambda payload: gateway._emit_approval_request(sid, payload))

            def run_gate() -> None:
                token = approval_context.set_current_session_key(key)
                try:
                    result = approval.request_tool_approval(
                        "synthetic_fixture_tool", "Review a synthetic local action",
                        rule_key="synthetic-local-action",
                    )
                    write_state({"state": "denied" if result.get("outcome") == "denied" else "closed",
                                 "outcome": result.get("outcome"), "approved": bool(result.get("approved")),
                                 "pending": approval.has_blocking_approval(key)})
                except Exception as exc:
                    write_state({"state": "error", "error_type": type(exc).__name__})
                finally:
                    approval_context.reset_current_session_key(token)
                    approval.unregister_gateway_notify(key)

            worker = threading.Thread(target=run_gate, name="synthetic-approval-gate", daemon=True)
            worker.start()
        return {"state": "waiting", "session_id": sid}

    @app.post("/fixture/approval/stop")
    def fixture_stop(x_hermes_session_token: str | None = Header(default=None)):
        require_token(x_hermes_session_token)
        if server is not None:
            server.should_exit = True
        return {"stopping": True}

    # The dashboard's catch-all mount precedes late-added test routes. Place
    # these exact fixture endpoints ahead of it so the normal app serves them.
    fixture_routes = [route for route in app.router.routes
                      if getattr(route, "path", "").startswith("/fixture/approval/")
                      or getattr(route, "path", "").startswith("/v1/")]
    app.router.routes[:] = fixture_routes + [route for route in app.router.routes if route not in fixture_routes]

    config = uvicorn.Config(app, host="127.0.0.1", port=data["port"], log_level="warning")
    server = uvicorn.Server(config)
    print(json.dumps({"url": f"http://127.0.0.1:{data['port']}", "profile": "default",
                      "session_id": data["session_id"], "session_token": data["session_token"]}), flush=True)
    try:
        server.run()
    finally:
        approval.clear_session(data["session_id"])
        (root / "sandbox-target" / "approval-marker").chmod(0o600)
        if worker is not None:
            worker.join(timeout=2)


def request(root: Path, command: str) -> dict:
    data = read_fixture(root)
    if command == "status":
        method = "GET"
    else:
        method = "POST"
    req = Request(f"http://127.0.0.1:{data['port']}/fixture/approval/{command}",
                  method=method, headers={"X-Hermes-Session-Token": data["session_token"]})
    with urlopen(req, timeout=5) as response:
        return json.load(response)


def test_fixture_owns_only_a_new_root(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    data = create_fixture(root)
    assert read_fixture(root)["session_id"] == data["session_id"]
    assert json.loads(paths(root)[2].read_text(encoding="utf-8")) == {
        "state": "ready", "tool_executed": False,
    }
    assert ((root / "sandbox-target").stat().st_mode & 0o777) == 0o700
    assert ((root / "sandbox-target" / "approval-marker").stat().st_mode & 0o777) == 0o600
    try:
        create_fixture(root)
    except ValueError:
        pass
    else:
        raise AssertionError("fixture reused an occupied root")


def test_resume_marks_a_lost_wait_unknown_without_replaying_it(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    data = create_fixture(root)
    state_path = paths(root)[2]
    state_path.write_text(
        json.dumps({"state": "waiting", "session_id": "synthetic-runtime", "tool_executed": False}) + "\n",
        encoding="utf-8",
    )
    assert load_fixture_for_resume(root) == data
    assert json.loads(state_path.read_text(encoding="utf-8")) == {
        "state": "interrupted", "session_id": "synthetic-runtime", "tool_executed": False,
        "outcome": "unknown", "pending": False,
    }


def test_model_rehearsal_is_exact_and_test_owned(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    create_fixture(root)
    request_body = {"messages": [{"role": "user", "content": MODEL_APPROVAL_PROMPT}], "stream": True}
    message, finish_reason = fixture_completion(request_body, root)
    assert finish_reason == "tool_calls"
    assert message["tool_calls"][0]["function"]["name"] == "terminal"
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {
        "command": f"chmod 666 {root / 'sandbox-target' / 'approval-marker'}",
    }
    assert "finish_reason\": \"tool_calls" in fixture_sse(message, finish_reason)
    assert "data: [DONE]" in fixture_sse(message, finish_reason)
    request_body["messages"].append({"role": "tool", "content": '{"status":"blocked"}'})
    final, final_reason = fixture_completion(request_body, root)
    assert final_reason == "stop"
    assert "denied" in final["content"]
    request_body["messages"][-1]["content"] = '{"status":"success"}'
    allowed, _ = fixture_completion(request_body, root)
    assert "denied" not in allowed["content"]
    request_body["messages"] = [{"role": "user", "content": MODEL_BACKGROUND_SUCCESS_PROMPT}]
    finished, finished_reason = fixture_completion(request_body, root)
    assert finished == {"role": "assistant", "content": "The synthetic background check finished."}
    assert finished_reason == "stop"
    assert "data: [DONE]" in fixture_sse(finished, finished_reason)
    request_body["messages"] = [{"role": "user", "content": "Unrelated real request"}]
    try:
        fixture_completion(request_body, root)
    except ValueError:
        pass
    else:
        raise AssertionError("unrelated model request was accepted")


def test_model_delegate_rehearsal_routes_one_child_and_completion(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    create_fixture(root)
    messages = [{"role": "user", "content": MODEL_DELEGATE_PROMPT}]
    spawned, reason = fixture_completion({"messages": messages}, root)
    assert reason == "tool_calls"
    assert len(spawned["tool_calls"]) == 1
    call = spawned["tool_calls"][0]
    assert call["function"]["name"] == "delegate_task"
    assert json.loads(call["function"]["arguments"]) == {
        "tasks": [{"goal": MODEL_DELEGATE_CHILD_GOAL}],
    }
    assert "terminal" not in fixture_sse(spawned, reason)

    child, reason = fixture_completion(
        {"messages": [{"role": "user", "content": MODEL_DELEGATE_CHILD_GOAL}]}, root,
    )
    assert (child, reason) == ({"role": "assistant", "content": MODEL_DELEGATE_CHILD_RESULT}, "stop")
    assert "tool_calls" not in child

    dispatched, reason = fixture_completion({"messages": messages + [
        spawned, {"role": "tool", "content": '{"status":"dispatched"}'},
    ]}, root)
    assert (dispatched, reason) == ({"role": "assistant", "content": "The background check is running."}, "stop")

    completion = ("[ASYNC DELEGATION BATCH COMPLETE — synthetic-id]\n"
                  f"--- TASK 1/1: {MODEL_DELEGATE_CHILD_GOAL} (status=completed) ---\n"
                  f"{MODEL_DELEGATE_CHILD_RESULT}")
    final, reason = fixture_completion({"messages": messages + [
        {"role": "user", "content": completion},
    ]}, root)
    assert (final, reason) == ({"role": "assistant", "content": MODEL_DELEGATE_RESULT}, "stop")


def test_model_delegate_failure_rehearsal_preserves_attention_outcome(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    create_fixture(root)
    messages = [{"role": "user", "content": MODEL_DELEGATE_FAILURE_PROMPT}]
    spawned, reason = fixture_completion({"messages": messages}, root)
    assert reason == "tool_calls"
    assert json.loads(spawned["tool_calls"][0]["function"]["arguments"]) == {
        "tasks": [{"goal": MODEL_DELEGATE_FAILURE_CHILD_GOAL}],
    }

    completion = ("[ASYNC DELEGATION BATCH COMPLETE — synthetic-id]\n"
                  f"--- TASK 1/1: {MODEL_DELEGATE_FAILURE_CHILD_GOAL} (status=failed) ---\n"
                  "Error: synthetic provider unavailable")
    final, reason = fixture_completion({"messages": messages + [
        {"role": "user", "content": completion},
    ]}, root)
    assert (final, reason) == (
        {"role": "assistant", "content": "The background check could not finish."}, "stop",
    )


def test_model_delegate_approval_retries_only_a_denied_fixture_action(tmp_path: Path) -> None:
    root = tmp_path / "approval-fixture"
    create_fixture(root)
    messages = [{"role": "user", "content": MODEL_DELEGATE_APPROVAL_PROMPT}]
    spawned, reason = fixture_completion({"messages": messages}, root)
    assert reason == "tool_calls"
    assert json.loads(spawned["tool_calls"][0]["function"]["arguments"]) == {
        "tasks": [{"goal": MODEL_DELEGATE_APPROVAL_CHILD_GOAL}],
    }

    child_messages = [{"role": "user", "content": MODEL_DELEGATE_APPROVAL_CHILD_GOAL}]
    first, reason = fixture_completion({"messages": child_messages}, root)
    assert reason == "tool_calls"
    assert first["tool_calls"][0]["function"]["name"] == "terminal"
    command = json.loads(first["tool_calls"][0]["function"]["arguments"])["command"]
    assert command == f"chmod 666 {root / 'sandbox-target' / 'delegate-approval-marker'}"

    child_messages.extend([first, {"role": "tool", "content": '{"status":"blocked"}'}])
    retried, reason = fixture_completion({"messages": child_messages}, root)
    assert reason == "tool_calls"
    assert retried["tool_calls"][0]["id"] != first["tool_calls"][0]["id"]
    assert json.loads(retried["tool_calls"][0]["function"]["arguments"])["command"] == command
    child_messages.extend([retried, {"role": "tool", "content": '{"status":"blocked"}'}])
    child_final, reason = fixture_completion({"messages": child_messages}, root)
    assert (child_final, reason) == (
        {"role": "assistant", "content": MODEL_DELEGATE_APPROVAL_DENIED}, "stop",
    )
    assert ((root / "sandbox-target" / "delegate-approval-marker").stat().st_mode & 0o777) == 0o600

    completion = ("[ASYNC DELEGATION BATCH COMPLETE — synthetic-id]\n"
                  f"--- TASK 1/1: {MODEL_DELEGATE_APPROVAL_CHILD_GOAL} (status=completed) ---\n"
                  f"{MODEL_DELEGATE_APPROVAL_DENIED}")
    parent_final, reason = fixture_completion({"messages": messages + [
        {"role": "user", "content": completion},
    ]}, root)
    assert (parent_final, reason) == (
        {"role": "assistant", "content": MODEL_DELEGATE_APPROVAL_RESULT}, "stop",
    )


def test_loopback_delegated_child_waits_for_two_real_gateway_denials(tmp_path: Path) -> None:
    """A delegated child uses the owner's live approval queue, and denial never runs its command."""
    from urllib.error import URLError
    from websockets.sync.client import connect

    root = tmp_path / "approval-server"
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "start", "--root", str(root)],
        cwd=ROOT, env=isolated_environment(root), stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    try:
        readable, _, _ = select.select([child.stdout], [], [], 15)
        assert readable, "fixture did not print its connection details"
        details = json.loads(child.stdout.readline())
        deadline = time.monotonic() + 15
        while True:
            try:
                assert request(root, "status")["state"] == "ready"
                break
            except (URLError, ConnectionError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

        with connect(f"ws://127.0.0.1:{read_fixture(root)['port']}/api/ws?token={details['session_token']}",
                     open_timeout=5) as ws:
            assert json.loads(ws.recv(timeout=10))["params"]["type"] == "gateway.ready"
            seen: list[dict] = []

            def call(method: str, params: dict, rid: int) -> dict:
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
                while True:
                    frame = json.loads(ws.recv(timeout=30))
                    if frame.get("id") == rid:
                        return frame
                    seen.append(frame)

            assert "result" in call("client.capabilities", {"server_requests": True}, 1)
            resumed = call("session.resume", {"session_id": details["session_id"]}, 2)
            assert "result" in resumed, resumed
            started = call("prompt.submit", {
                "session_id": resumed["result"]["session_id"],
                "text": MODEL_DELEGATE_APPROVAL_PROMPT,
            }, 3)
            assert started.get("result", {}).get("status") == "streaming", started

            def next_approval() -> dict:
                deadline = time.monotonic() + 35
                while True:
                    for index, frame in enumerate(seen):
                        if frame.get("method") == "approval":
                            return seen.pop(index)
                    assert time.monotonic() < deadline, "delegated child never requested approval"
                    seen.append(json.loads(ws.recv(timeout=10)))

            requests = []
            for rid in (4, 5):
                approval_frame = next_approval()
                params = approval_frame["params"]
                assert "delegate-approval-marker" in params["command"]
                requests.append(params["request_id"])
                denied = call("approval.respond", {
                    "session_id": params["session_id"],
                    "request_id": params["request_id"], "choice": "deny",
                }, rid)
                assert denied.get("result") == {"resolved": 1}, denied
            assert requests[0] != requests[1]
            assert ((root / "sandbox-target" / "delegate-approval-marker").stat().st_mode & 0o777) == 0o600

        assert request(root, "stop") == {"stopping": True}
        assert child.wait(timeout=10) == 0
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


def test_loopback_gateway_denial_round_trip(tmp_path: Path) -> None:
    """The real WebSocket dispatcher receives and resolves the synthetic gate."""
    from urllib.error import URLError
    from websockets.sync.client import connect

    root = tmp_path / "approval-server"
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "start", "--root", str(root)],
        cwd=ROOT, env=isolated_environment(root), stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    try:
        readable, _, _ = select.select([child.stdout], [], [], 15)
        assert readable, "fixture did not print its connection details"
        details = json.loads(child.stdout.readline())
        deadline = time.monotonic() + 15
        while True:
            try:
                assert request(root, "status")["state"] == "ready"
                break
            except (URLError, ConnectionError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

        model_request = Request(
            f"http://127.0.0.1:{read_fixture(root)['port']}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": MODEL_APPROVAL_PROMPT}],
                             "stream": False}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urlopen(model_request, timeout=5) as response:
            model_reply = json.load(response)
        assert model_reply["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "terminal"

        with connect(f"ws://127.0.0.1:{read_fixture(root)['port']}/api/ws?token={details['session_token']}",
                     open_timeout=5) as ws:
            def call(method: str, params: dict, rid: int) -> dict:
                ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
                while True:
                    frame = json.loads(ws.recv(timeout=10))
                    if frame.get("id") == rid:
                        return frame

            assert json.loads(ws.recv(timeout=10))["params"]["type"] == "gateway.ready"
            assert "result" in call("client.capabilities", {"server_requests": True}, 1)
            resumed = call("session.resume", {"session_id": details["session_id"]}, 2)
            assert "result" in resumed, resumed
            assert request(root, "trigger")["state"] == "waiting"
            while True:
                approval_frame = json.loads(ws.recv(timeout=10))
                if approval_frame.get("method") == "approval":
                    break
            assert approval_frame["params"]["command"].startswith("<synthetic_fixture_tool>")
            denied = call("approval.respond", {
                "session_id": approval_frame["params"]["session_id"],
                "request_id": approval_frame["params"]["request_id"], "choice": "deny",
            }, 3)
            assert denied.get("result") == {"resolved": 1}, denied
            deadline = time.monotonic() + 5
            while request(root, "status")["state"] == "waiting" and time.monotonic() < deadline:
                time.sleep(0.02)
            assert request(root, "status") == {
                "state": "denied", "outcome": "denied", "approved": False,
                "pending": False, "tool_executed": False, "model_action_executed": False,
            }
        assert request(root, "stop") == {"stopping": True}
        assert child.wait(timeout=10) == 0
        resumed = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "resume", "--root", str(root)],
            cwd=ROOT, env=isolated_environment(root), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        try:
            readable, _, _ = select.select([resumed.stdout], [], [], 15)
            assert readable, "resumed fixture did not print its connection details"
            resumed_details = json.loads(resumed.stdout.readline())
            assert resumed_details == details
            deadline = time.monotonic() + 15
            while True:
                try:
                    assert request(root, "status")["state"] == "denied"
                    break
                except (URLError, ConnectionError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            assert request(root, "stop") == {"stopping": True}
            assert resumed.wait(timeout=10) == 0
        finally:
            if resumed.poll() is None:
                resumed.send_signal(signal.SIGINT)
                resumed.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "resume", "trigger", "status", "stop"))
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    selected_root = args.root.expanduser().resolve(strict=False)
    if args.command in {"start", "resume"}:
        serve(selected_root, resume=args.command == "resume")
    else:
        print(json.dumps(request(selected_root, args.command), indent=2))
