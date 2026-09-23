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
