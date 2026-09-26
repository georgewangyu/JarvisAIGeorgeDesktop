"""Consequential tool approvals must stop the actual handler before its side effect.

The synthetic lifecycle directive models an installed approval policy. These
tests intentionally do not imply that all ordinary writes/navigation prompt by
default; that is a separate product-policy choice.
"""

from __future__ import annotations

import json

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from model_tools import handle_function_call
from tools import approval
from tools.approval_context import (
    reset_current_session_key,
    reset_hermes_interactive_context,
    set_current_session_key,
    set_hermes_interactive_context,
)


@pytest.mark.parametrize("tool_name", ("write_file", "browser_navigate", "browser_click"))
def test_plugin_flagged_real_handler_obeys_manual_refusal_and_off_mode(
    tmp_path, monkeypatch, tool_name
):
    """Exercise the model dispatcher, approval gate, and real tool handler."""
    home = tmp_path / "profile"
    home.mkdir()
    config = home / "config.yaml"
    config.write_text("approvals:\n  mode: manual\n", encoding="utf-8")
    home_token = set_hermes_home_override(home)
    session_token = set_current_session_key(f"handler-{tool_name}")
    interactive_token = set_hermes_interactive_context(True)
    prompts = []
    target = tmp_path / "synthetic-target.txt"
    browser_calls = []

    def deny(*_args, **_kwargs):
        prompts.append("asked")
        return "deny"

    def directive(hook_name, **_kwargs):
        if hook_name == "pre_tool_call":
            return [{"action": "approve", "message": "Synthetic test action", "rule_key": "handler-fixture"}]
        return []

    monkeypatch.setattr("hermes_cli.lifecycle.invoke_hook", directive)
    monkeypatch.setattr("tools.terminal_tool._get_approval_callback", lambda: deny)

    if tool_name == "write_file":
        args = {"path": str(target), "content": "synthetic content"}
    else:
        from tools import browser_tool

        args = ({"url": "https://example.com/synthetic-test"} if tool_name == "browser_navigate"
                else {"ref": "@e1"})
        if tool_name == "browser_navigate":
            monkeypatch.setattr(browser_tool, "_navigation_session_key", lambda *_args: "synthetic-browser")
            monkeypatch.setattr(browser_tool._session, "_get_session_info", lambda *_args: {"_first_nav": False})
        else:
            monkeypatch.setattr(browser_tool, "_last_session_key", lambda *_args: "synthetic-browser")
            monkeypatch.setattr(browser_tool, "_blocked_private_page_action", lambda *_args: None)

        def browser_command(_session_key, command, arguments, **_kwargs):
            browser_calls.append((command, arguments))
            return {"success": True, "data": {"url": "https://example.com/synthetic-test", "title": "Synthetic"}}

        monkeypatch.setattr(browser_tool._session, "_run_browser_command", browser_command)

    def run():
        return json.loads(handle_function_call(tool_name, args, task_id=f"synthetic-{tool_name}"))

    try:
        denied = run()
        assert denied.get("error")
        assert prompts == ["asked"]
        assert not target.exists()
        assert browser_calls == []

        config.write_text("approvals:\n  mode: off\n", encoding="utf-8")
        allowed = run()
        assert allowed.get("success") is True or allowed.get("error") is None, allowed
        assert prompts == ["asked"]
        if tool_name == "write_file":
            assert target.read_text(encoding="utf-8") == "synthetic content"
        else:
            expected_command = "open" if tool_name == "browser_navigate" else "click"
            assert any(command == expected_command for command, _ in browser_calls)
    finally:
        approval.clear_session(f"handler-{tool_name}")
        reset_hermes_interactive_context(interactive_token)
        reset_current_session_key(session_token)
        reset_hermes_home_override(home_token)


def test_protected_file_handler_refusal_prevents_write_even_with_off_mode(tmp_path, monkeypatch):
    """The protected instruction gate is unconditional and runs before file mutation."""
    from tools.terminal_tool import set_approval_callback

    target = tmp_path / "AGENTS.md"
    decisions = []

    def deny(*_args, **_kwargs):
        decisions.append("deny")
        return "deny"

    monkeypatch.setattr("tools.file_tools_write_guards._protected_instruction_config", lambda: (True, []))
    home = tmp_path / "profile"
    home.mkdir()
    (home / "config.yaml").write_text("approvals:\n  mode: off\n", encoding="utf-8")
    home_token = set_hermes_home_override(home)
    set_approval_callback(deny)
    try:
        result = json.loads(handle_function_call("write_file", {"path": str(target), "content": "injected"}))
        assert result.get("error")
        assert not target.exists()
        assert decisions == ["deny"]
    finally:
        set_approval_callback(None)
        reset_hermes_home_override(home_token)
