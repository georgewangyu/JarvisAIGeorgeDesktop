"""Real profile-config approval gates, not renderer-only setting state."""

from __future__ import annotations

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import approval
from tools.approval_context import (
    reset_current_session_key,
    reset_hermes_interactive_context,
    set_current_session_key,
    set_hermes_interactive_context,
)


def test_profile_mode_routes_actual_tool_gate_and_returns_to_first_profile(tmp_path):
    homes = [tmp_path / "ask", tmp_path / "fewer-prompts"]
    for home, mode in zip(homes, ("manual", "off")):
        home.mkdir()
        (home / "config.yaml").write_text(f"approvals:\n  mode: {mode}\n", encoding="utf-8")

    asked = []

    def deny(*_args, **_kwargs):
        asked.append(True)
        return "deny"

    interactive = set_hermes_interactive_context(True)
    try:
        for index, home in enumerate((homes[0], homes[1], homes[0])):
            home_token = set_hermes_home_override(home)
            session_token = set_current_session_key(f"fixture-{index}")
            try:
                decision = approval.request_tool_approval(
                    "synthetic_tool", "Synthetic consequential action", rule_key="fixture-action",
                    approval_callback=deny,
                )
                assert decision["approved"] is (home == homes[1])
            finally:
                reset_current_session_key(session_token)
                reset_hermes_home_override(home_token)
    finally:
        reset_hermes_interactive_context(interactive)

    assert asked == [True, True]


def test_fewer_prompts_does_not_bypass_hard_safety_floor(tmp_path):
    home = tmp_path / "off"
    home.mkdir()
    (home / "config.yaml").write_text("approvals:\n  mode: off\n", encoding="utf-8")
    home_token = set_hermes_home_override(home)
    try:
        # Detection only: this test never launches the command.
        decision = approval.check_dangerous_command("rm -rf /", "local")
    finally:
        reset_hermes_home_override(home_token)

    assert decision["approved"] is False


def test_session_grants_do_not_cross_profiles_with_same_session_id(tmp_path):
    homes = (tmp_path / "profile-a", tmp_path / "profile-b")
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text("approvals:\n  mode: manual\n", encoding="utf-8")

    session_key = "shared-session-id"
    rule_key = "consequential-action"
    pattern_key = f"plugin_rule:{len('synthetic_tool')}:synthetic_tool:{rule_key}"
    asked = []

    def deny(*_args, **_kwargs):
        asked.append(True)
        return "deny"

    interactive = set_hermes_interactive_context(True)
    session_token = set_current_session_key(session_key)
    try:
        for index, home in enumerate((homes[0], homes[1], homes[0])):
            home_token = set_hermes_home_override(home)
            try:
                if index == 0:
                    approval.approve_session(session_key, pattern_key)
                    approval.enable_session_yolo(session_key)
                assert approval.is_approved(session_key, pattern_key) is (home == homes[0])
                assert approval.is_session_yolo_enabled(session_key) is (home == homes[0])
                if index == 1:
                    decision = approval.request_tool_approval(
                        "synthetic_tool", "Synthetic consequential action", rule_key=rule_key,
                        approval_callback=deny,
                    )
                    assert decision["approved"] is False
                # The unconditional floor remains active even while profile A has YOLO.
                assert approval.check_dangerous_command("rm -rf /", "local")["approved"] is False
            finally:
                if index == 2:
                    approval.clear_session(session_key)
                reset_hermes_home_override(home_token)
    finally:
        reset_current_session_key(session_token)
        reset_hermes_interactive_context(interactive)

    assert asked == [True]
