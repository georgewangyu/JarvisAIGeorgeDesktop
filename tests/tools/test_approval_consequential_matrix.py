"""A synthetic matrix for the shared plugin escalation gate.

The named tools represent distinct plugin-flagged actions; no handler runs here.
This tests the real profile config and approval state, not a renderer toggle.
"""

from __future__ import annotations

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import approval
from tools.approval_context import (
    reset_current_session_key,
    reset_hermes_interactive_context,
    set_current_session_key,
    set_hermes_interactive_context,
)


_ACTIONS = (
    ("terminal", "change a synthetic file mode", "shell-change"),
    ("write_file", "replace a synthetic local file", "file-write"),
    ("browser_navigate", "submit a synthetic web form", "network-submit"),
)


def test_actual_shell_pattern_obeys_manual_and_off_profile_modes(tmp_path):
    """The real command detector feeds the gate; the command is never executed."""
    home = tmp_path / "shell-profile"
    home.mkdir()
    config = home / "config.yaml"
    config.write_text("approvals:\n  mode: manual\n", encoding="utf-8")
    home_token = set_hermes_home_override(home)
    session_token = set_current_session_key("matrix-shell-guard")
    interactive_token = set_hermes_interactive_context(True)
    prompts = []

    def refuse(*_args, **_kwargs):
        prompts.append(True)
        return "deny"

    command = "chmod 777 /tmp/synthetic-approval-fixture"
    try:
        result = approval.check_dangerous_command(
            command, "local", approval_callback=refuse
        )
        assert result["approved"] is False
        assert prompts == [True]

        config.write_text("approvals:\n  mode: off\n", encoding="utf-8")
        assert approval.check_dangerous_command(command, "local")["approved"] is True
        assert prompts == [True]
    finally:
        approval.clear_session("matrix-shell-guard")
        reset_hermes_interactive_context(interactive_token)
        reset_current_session_key(session_token)
        reset_hermes_home_override(home_token)


@pytest.mark.parametrize("tool_name,reason,rule_key", _ACTIONS)
def test_manual_refusal_and_off_mode_for_plugin_flagged_tools(
    tmp_path, tool_name, reason, rule_key
):
    """Manual mode asks and obeys denial; off mode follows its documented bypass."""
    home = tmp_path / "profile"
    home.mkdir()
    config = home / "config.yaml"
    config.write_text("approvals:\n  mode: manual\n", encoding="utf-8")
    home_token = set_hermes_home_override(home)
    session_token = set_current_session_key(f"matrix-{tool_name}")
    interactive_token = set_hermes_interactive_context(True)
    choices = []

    def refuse(*_args, **_kwargs):
        choices.append("asked")
        return "deny"

    try:
        denied = approval.request_tool_approval(
            tool_name, reason, rule_key=rule_key, approval_callback=refuse
        )
        assert denied["approved"] is False
        assert denied["pattern_key"].startswith(f"plugin_rule:{len(tool_name)}:{tool_name}:")
        assert choices == ["asked"]

        config.write_text("approvals:\n  mode: off\n", encoding="utf-8")
        allowed = approval.request_tool_approval(
            tool_name, reason, rule_key=rule_key, approval_callback=refuse
        )
        assert allowed["approved"] is True
        assert choices == ["asked"]

        # Revoking the bypass returns the next model turn to manual review.
        config.write_text("approvals:\n  mode: manual\n", encoding="utf-8")
        approval.clear_session(f"matrix-{tool_name}")
        denied_again = approval.request_tool_approval(
            tool_name, reason, rule_key=rule_key, approval_callback=refuse
        )
        assert denied_again["approved"] is False
        assert choices == ["asked", "asked"]
    finally:
        approval.clear_session(f"matrix-{tool_name}")
        reset_hermes_interactive_context(interactive_token)
        reset_current_session_key(session_token)
        reset_hermes_home_override(home_token)


def test_saved_plugin_grant_stays_in_its_profile_and_is_revocable(tmp_path):
    homes = (tmp_path / "a", tmp_path / "b")
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text("approvals:\n  mode: manual\n", encoding="utf-8")

    session_key = "shared-matrix-session"
    tool_name, reason, rule_key = _ACTIONS[1]
    decisions = iter(("session", "deny", "deny"))
    prompts = []

    def choose(*_args, **_kwargs):
        prompts.append(True)
        return next(decisions)

    interactive_token = set_hermes_interactive_context(True)
    session_token = set_current_session_key(session_key)
    try:
        for index, home in enumerate((homes[0], homes[0], homes[1], homes[0])):
            home_token = set_hermes_home_override(home)
            try:
                if index == 3:
                    approval.clear_session(session_key)
                result = approval.request_tool_approval(
                    tool_name, reason, rule_key=rule_key, approval_callback=choose
                )
                assert result["approved"] is (index in (0, 1))
            finally:
                reset_hermes_home_override(home_token)
    finally:
        for home in homes:
            home_token = set_hermes_home_override(home)
            try:
                approval.clear_session(session_key)
            finally:
                reset_hermes_home_override(home_token)
        reset_current_session_key(session_token)
        reset_hermes_interactive_context(interactive_token)

    assert len(prompts) == 3
