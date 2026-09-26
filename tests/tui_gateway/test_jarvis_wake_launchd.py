"""Synthetic contract tests; these never register a LaunchAgent."""

import plistlib

import pytest

from tui_gateway.jarvis_wake_launchd import (
    launch_agent_label,
    render_launch_agent_plist,
    validate_launch_agent_plist,
)


def _contract(tmp_path, profile):
    return {
        "profile": profile,
        "profile_home": tmp_path / "profiles" / profile,
        "python_executable": tmp_path / "stable" / "bin" / "python3",
        "entrypoint": tmp_path / "stable" / "tui_gateway" / "headless_owner_event.py",
    }


def test_on_demand_exact_profile_queue_and_one_shot_argv(tmp_path):
    a = _contract(tmp_path, "default")
    b = _contract(tmp_path, "research")
    for inputs in (a, b, a):
        data = render_launch_agent_plist(**inputs)
        validate_launch_agent_plist(data, **inputs)
        job = plistlib.loads(data)
        assert job["Label"] == launch_agent_label(inputs["profile"], inputs["profile_home"])
        assert job["QueueDirectories"] == [str(inputs["profile_home"] / "runtime" / "jarvis_event_wake")]
        assert job["ProgramArguments"] == [
            str(inputs["python_executable"]), str(inputs["entrypoint"]),
            "--scan-wake-queue", "--allow-headless", "--profile", inputs["profile"],
            "--expected-profile-home", str(inputs["profile_home"]),
        ]
        assert job["WorkingDirectory"] == str(inputs["entrypoint"].parent.parent)
        assert job["EnvironmentVariables"] == {"PYTHONPATH": job["WorkingDirectory"]}
        assert set(job) == {
            "Label", "ProgramArguments", "WorkingDirectory", "EnvironmentVariables",
            "QueueDirectories",
        }
    assert launch_agent_label(a["profile"], a["profile_home"]) != launch_agent_label(
        b["profile"], b["profile_home"])
    assert launch_agent_label("default", tmp_path / "other-home") != launch_agent_label(
        a["profile"], a["profile_home"])


@pytest.mark.parametrize("change", [
    {"KeepAlive": True}, {"StartInterval": 5}, {"RunAtLoad": True},
    {"WatchPaths": ["/tmp"]}, {"QueueDirectories": ["/tmp"]},
    {"ProgramArguments": ["/bin/sh", "-c", "echo unsafe"]},
    {"Label": "ai.hermes.jarvis-wake.other"},
])
def test_validator_refuses_trigger_or_identity_changes(tmp_path, change):
    inputs = _contract(tmp_path, "research")
    job = plistlib.loads(render_launch_agent_plist(**inputs))
    job.update(change)
    with pytest.raises(ValueError, match="exact one-shot wake contract"):
        validate_launch_agent_plist(plistlib.dumps(job), **inputs)


@pytest.mark.parametrize("field,value", [
    ("profile", "../escape"), ("profile", "A"), ("profile", "a;echo"),
    ("profile_home", "/tmp/a/../b"), ("profile_home", "relative/home"),
    ("profile_home", "/"), ("python_executable", "/bin/sh"),
    ("python_executable", "/tmp/bin/../python"),
    ("entrypoint", "/tmp/other.py"), ("entrypoint", "/tmp/tui_gateway/./headless_owner_event.py"),
])
def test_renderer_refuses_unsafe_inputs(tmp_path, field, value):
    inputs = _contract(tmp_path, "research")
    inputs[field] = value
    with pytest.raises(ValueError):
        render_launch_agent_plist(**inputs)
