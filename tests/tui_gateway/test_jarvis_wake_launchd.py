"""Synthetic contract tests; these never register a LaunchAgent."""

import plistlib
import sys
from pathlib import Path

import pytest

from tui_gateway.jarvis_wake_launchd import (
    launch_agent_label,
    render_launch_agent_plist,
    validate_launch_agent_readiness,
    validate_launch_agent_plist,
)


def _contract(tmp_path, profile):
    base_home = tmp_path / "hermes-home"
    source = base_home / "hermes-agent"
    return {
        "profile": profile,
        "profile_home": base_home if profile == "default" else base_home / "profiles" / profile,
        "hermes_home": base_home,
        "python_executable": source / "venv" / "bin" / "python",
        "entrypoint": source / "tui_gateway" / "headless_owner_event.py",
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
        assert job["EnvironmentVariables"] == {
            "HERMES_HOME": str(inputs["hermes_home"]),
            "PYTHONPATH": job["WorkingDirectory"],
        }
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


def test_validator_refuses_unpinned_base_home(tmp_path):
    inputs = _contract(tmp_path, "research")
    job = plistlib.loads(render_launch_agent_plist(**inputs))
    job["EnvironmentVariables"].pop("HERMES_HOME")
    with pytest.raises(ValueError, match="exact one-shot wake contract"):
        validate_launch_agent_plist(plistlib.dumps(job), **inputs)


@pytest.mark.parametrize("field,value", [
    ("profile", "../escape"), ("profile", "A"), ("profile", "a;echo"),
    ("profile_home", "/tmp/a/../b"), ("profile_home", "relative/home"),
    ("profile_home", "/"), ("python_executable", "/bin/sh"),
    ("python_executable", "/tmp/bin/../python"),
    ("entrypoint", "/tmp/other.py"), ("entrypoint", "/tmp/tui_gateway/./headless_owner_event.py"),
    ("hermes_home", "/"), ("hermes_home", "relative/home"),
])
def test_renderer_refuses_unsafe_inputs(tmp_path, field, value):
    inputs = _contract(tmp_path, "research")
    inputs[field] = value
    with pytest.raises(ValueError):
        render_launch_agent_plist(**inputs)


def test_renderer_refuses_a_different_install_root_or_default_profile_home(tmp_path):
    inputs = _contract(tmp_path, "research")
    inputs["python_executable"] = tmp_path / "other-checkout" / "venv" / "bin" / "python"
    with pytest.raises(ValueError, match="installed Jarvis venv"):
        render_launch_agent_plist(**inputs)

    inputs = _contract(tmp_path, "default")
    inputs["profile_home"] = tmp_path / "other-profile"
    with pytest.raises(ValueError, match="default profile home"):
        render_launch_agent_plist(**inputs)

    inputs = _contract(tmp_path, "research")
    inputs["profile_home"] = tmp_path / "other-profile"
    with pytest.raises(ValueError, match="named profile home"):
        render_launch_agent_plist(**inputs)


def _installed_contract(tmp_path: Path, profile: str, *, enabled: bool = True):
    inputs = _contract(tmp_path, profile)
    base = inputs["hermes_home"]
    home = inputs["profile_home"]
    for directory in (base, home, home / "runtime",
                      home / "runtime" / "jarvis_event_wake"):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
    if profile != "default":
        (base / "profiles").chmod(0o700)
    source = base / "hermes-agent"
    for directory in (source, source / "tui_gateway", source / "venv" / "bin"):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    inputs["entrypoint"].write_text("# synthetic installed source\n", encoding="utf-8")
    if not inputs["python_executable"].exists():
        inputs["python_executable"].symlink_to(sys.executable)
    config = home / "config.yaml"
    config.write_text(
        f"desktop:\n  jarvis_headless_event_activation: {str(enabled).lower()}\n",
        encoding="utf-8",
    )
    config.chmod(0o600)
    return inputs


def test_readiness_is_exact_profile_scoped_across_a_b_a(tmp_path):
    a = _installed_contract(tmp_path, "default")
    b = _installed_contract(tmp_path, "research")
    for inputs in (a, b, a):
        validate_launch_agent_readiness(render_launch_agent_plist(**inputs), **inputs)
    b["profile_home"].joinpath("config.yaml").write_text(
        "desktop:\n  jarvis_headless_event_activation: false\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not enabled"):
        validate_launch_agent_readiness(render_launch_agent_plist(**b), **b)
    validate_launch_agent_readiness(render_launch_agent_plist(**a), **a)


def test_readiness_denials_and_recovery(tmp_path):
    inputs = _installed_contract(tmp_path, "default")
    data = render_launch_agent_plist(**inputs)

    def check():
        validate_launch_agent_readiness(data, **inputs)

    check()
    queue = inputs["profile_home"] / "runtime" / "jarvis_event_wake"
    queue.chmod(0o755)
    with pytest.raises(ValueError, match="owner-private"):
        check()
    queue.chmod(0o700)
    check()

    script = inputs["entrypoint"]
    script.unlink()
    with pytest.raises(FileNotFoundError):
        check()
    script.write_text("# restored\n", encoding="utf-8")
    check()

    python = inputs["python_executable"]
    python.unlink()
    with pytest.raises(FileNotFoundError):
        check()
    inert_python = tmp_path / "inert-python"
    inert_python.write_text("not an interpreter\n", encoding="utf-8")
    python.symlink_to(inert_python)
    with pytest.raises(ValueError, match="not executable"):
        check()
    python.unlink()
    python.symlink_to(sys.executable)
    check()

    config = inputs["profile_home"] / "config.yaml"
    config.unlink()
    config.symlink_to(tmp_path / "other-config")
    with pytest.raises(ValueError, match="symlinked"):
        check()
    config.unlink()
    config.write_text("desktop:\n  jarvis_headless_event_activation: true\n", encoding="utf-8")
    config.chmod(0o600)
    check()

    source = inputs["hermes_home"] / "hermes-agent"
    moved = inputs["hermes_home"] / "moved-source"
    source.rename(moved)
    source.symlink_to(moved)
    with pytest.raises(ValueError, match="symlinked"):
        check()
    source.unlink()
    moved.rename(source)
    check()
