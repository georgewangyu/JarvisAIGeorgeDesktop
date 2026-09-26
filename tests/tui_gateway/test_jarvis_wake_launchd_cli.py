"""The JSON adapter uses a fake manager; it never registers with launchd."""

from __future__ import annotations

import io
import json
from dataclasses import dataclass

import pytest

from tui_gateway.jarvis_wake_launchd_cli import execute, main


@dataclass(frozen=True)
class _Status:
    installed: bool
    loaded: bool
    running: bool


def test_explicit_actions_derive_only_installed_paths_and_keep_profiles_separate(tmp_path):
    calls = []

    class FakeManager:
        def __init__(self, **inputs):
            calls.append(inputs)

        def status(self):
            return _Status(False, False, False)

        def install(self):
            return _Status(True, True, False)

        def disable(self):
            return _Status(False, False, False)

    base_a, base_b = tmp_path / "a", tmp_path / "b"
    for base, profile, action in (
        (base_a, "default", "status"),
        (base_b, "writing", "install"),
        (base_a, "default", "disable"),
    ):
        output = io.StringIO()
        code = main(
            [action, "--profile", profile], environ={"HERMES_HOME": str(base), "HOME": "/untrusted/home"},
            manager_factory=FakeManager, output=output,
        )
        result = json.loads(output.getvalue())
        assert code == 0
        assert result == {
            "ok": True, "profile": profile,
            "installed": action == "install", "loaded": action == "install", "running": False,
        }
        assert str(base) not in output.getvalue()
        assert "/untrusted/home" not in output.getvalue()
        expected_home = base if profile == "default" else base / "profiles" / profile
        assert calls[-1] == {
            "profile": profile,
            "profile_home": expected_home,
            "python_executable": base / "hermes-agent" / "venv" / "bin" / "python",
            "entrypoint": base / "hermes-agent" / "tui_gateway" / "headless_owner_event.py",
            "hermes_home": base,
        }


@pytest.mark.parametrize("argv,environ", [
    (["status", "--profile", "default"], {}),
    (["install", "--profile", "default"], {"HERMES_HOME": "/"}),
    (["status", "--profile", "default"], {"HERMES_HOME": "/tmp/../other"}),
    (["status", "--profile", "default"], {"HERMES_HOME": "relative"}),
    (["status", "--profile", "default"], {"HERMES_HOME": "/tmp/profiles/writing"}),
    (["status", "--profile", "../other"], {"HERMES_HOME": "/tmp/base"}),
    (["status", "--profile", "WRITING"], {"HERMES_HOME": "/tmp/base"}),
    (["status", "--profile", "default", "--entrypoint", "/bin/sh"], {"HERMES_HOME": "/tmp/base"}),
    (["status", "--profile", "default", "--user-home", "/tmp/other"], {"HERMES_HOME": "/tmp/base"}),
])
def test_invalid_commands_never_construct_manager_or_expose_paths(argv, environ):
    def forbidden_manager(**_inputs):
        raise AssertionError("manager must not be constructed")

    code, result = execute(argv, environ=environ, manager_factory=forbidden_manager)
    assert code == 2
    assert result["error"]["code"] == "invalid_request"
    assert "/tmp" not in json.dumps(result)


def test_manager_error_is_sanitized_and_action_is_not_retried(tmp_path):
    calls = []

    class FailingManager:
        def __init__(self, **_inputs):
            pass

        def install(self):
            calls.append("install")
            raise ValueError(f"private path {tmp_path}/config.yaml is unsafe")

    output = io.StringIO()
    code = main(
        ["install", "--profile", "default"], environ={"HERMES_HOME": str(tmp_path)},
        manager_factory=FailingManager, output=output,
    )
    assert code == 1
    assert calls == ["install"]
    assert json.loads(output.getvalue())["error"]["code"] == "operation_failed"
    assert str(tmp_path) not in output.getvalue()
