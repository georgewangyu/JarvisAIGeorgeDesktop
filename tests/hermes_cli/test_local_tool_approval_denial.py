"""A synthetic tool approval round trip through the local TUI/Desktop gateway."""

from concurrent.futures import ThreadPoolExecutor
import time


def test_local_tool_approval_denial_releases_agent_and_gateway(monkeypatch):
    from tools import approval, approval_context
    from tui_gateway import server, server_requests

    session_id = "synthetic-tool-approval-ui"
    session_key = "synthetic-tool-approval-agent"
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    monkeypatch.setenv("HERMES_EXEC_ASK", "1")
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    server._sessions[session_id] = {"session_key": session_key, "history": []}
    approval.register_gateway_notify(
        session_key, lambda data: server._emit_approval_request(session_id, data)
    )

    def agent_tool_call():
        token = approval_context.set_current_session_key(session_key)
        try:
            # This is the production gate for a tool escalation. The synthetic
            # tool has no executor and therefore cannot perform an action.
            return approval.request_tool_approval(
                "synthetic_fixture_tool", "Review a synthetic local action",
                rule_key="synthetic-local-action",
            )
        finally:
            approval_context.reset_current_session_key(token)

    executor = ThreadPoolExecutor(max_workers=1)
    try:
        result = executor.submit(agent_tool_call)
        deadline = time.monotonic() + 5
        requests = []
        while time.monotonic() < deadline:
            requests = server_requests.open_requests(session_id)
            if requests:
                break
            time.sleep(0.01)
        assert len(requests) == 1
        request = requests[0]
        assert request["method"] == "approval"
        assert approval.has_blocking_approval(session_key)
        assert request["params"]["request_id"] == approval.list_gateway_approvals(session_key)[0]["request_id"]

        # A supported local RPC response denies the pending tool call.
        reply = server.handle_request({
            "id": "synthetic-denial", "method": "approval.respond",
            "params": {"session_id": session_id, "request_id": request["params"]["request_id"],
                       "choice": "deny"},
        })
        assert reply["result"] == {"resolved": 1}
        decision = result.result(timeout=5)

        assert decision["approved"] is False
        assert decision["outcome"] == "denied"
        assert decision["user_consent"] is False
        assert "denied by user" in decision["message"]
        assert not approval.has_blocking_approval(session_key)
        assert server_requests.open_requests(session_id) == []
        assert server.handle_request({
            "id": "synthetic-recovery", "method": "approval.pending",
            "params": {"session_id": session_id},
        })["result"] == {"approvals": []}
    finally:
        # Always wake the synthetic agent before joining its thread, including
        # when an assertion fails before the normal denial RPC.
        approval.clear_session(session_key)
        executor.shutdown(wait=True, cancel_futures=True)
        approval.unregister_gateway_notify(session_key)
        server._sessions.pop(session_id, None)
        server_requests.reset_for_tests()
