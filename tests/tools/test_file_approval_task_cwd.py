"""Approval for a relative file write must follow the task's actual target."""

import json

import pytest

from model_tools import handle_function_call
from tools import terminal_tool


@pytest.mark.parametrize("tool_name", ("write_file", "patch"))
def test_relative_ssh_config_write_obeys_denial_at_task_cwd(tmp_path, monkeypatch, tool_name):
    from agent import file_safety
    from tools import approval
    from tools.approval_context import (
        reset_current_session_key,
        reset_hermes_interactive_context,
        set_current_session_key,
        set_hermes_interactive_context,
    )

    synthetic_home = tmp_path / "synthetic-home"
    ssh_dir = synthetic_home / ".ssh"
    ssh_dir.mkdir(parents=True)
    target = ssh_dir / "config"
    if tool_name == "patch":
        target.write_text("Host original\n", encoding="utf-8")
    monkeypatch.setattr(file_safety, "_guard_homes", lambda _path="": {str(synthetic_home)})
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {"synthetic-task": {"cwd": str(ssh_dir)}})
    decisions = []

    def deny(*_args, **_kwargs):
        decisions.append("deny")
        return "deny"

    monkeypatch.setattr("tools.terminal_tool._get_approval_callback", lambda: deny)

    session_token = set_current_session_key("synthetic-task")
    interactive_token = set_hermes_interactive_context(True)
    try:
        args = ({"path": "config", "content": "Host synthetic\n"} if tool_name == "write_file"
                else {"path": "config", "old_string": "Host original", "new_string": "Host synthetic"})
        result = json.loads(handle_function_call(
            tool_name, args, task_id="synthetic-task"
        ))
        assert result.get("error"), result
        assert decisions == ["deny"]
        if tool_name == "write_file":
            assert not target.exists()
        else:
            assert target.read_text(encoding="utf-8") == "Host original\n"
    finally:
        approval.clear_session("synthetic-task")
        reset_hermes_interactive_context(interactive_token)
        reset_current_session_key(session_token)
