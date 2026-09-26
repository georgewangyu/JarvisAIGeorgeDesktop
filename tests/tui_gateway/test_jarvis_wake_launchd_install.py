"""Synthetic LaunchAgent management; no test invokes the host's launchctl."""

import subprocess
import sys
from pathlib import Path

import pytest

from tui_gateway.jarvis_wake_launchd_install import JarvisWakeLaunchAgent, LaunchAgentStatus


class FakeLaunchctl:
    def __init__(self):
        self.loaded = False
        self.running = False
        self.fail_bootstrap = False
        self.ambiguous_bootstrap = False
        self.calls = []
        self.path = None

    def __call__(self, argv):
        self.calls.append(argv)
        operation = argv[1]
        if operation == "print":
            if not self.loaded:
                return subprocess.CompletedProcess(argv, 113, "", "Could not find service")
            state = "running" if self.running else "waiting"
            return subprocess.CompletedProcess(argv, 0, f"path = {self.path}\nstate = {state}\n", "")
        if operation == "bootstrap":
            if self.ambiguous_bootstrap:
                self.loaded = True
                self.path = argv[-1]
                return subprocess.CompletedProcess(argv, 5, "", "unknown outcome")
            if self.fail_bootstrap:
                return subprocess.CompletedProcess(argv, 5, "", "failure")
            self.loaded = True
            self.path = argv[-1]
            return subprocess.CompletedProcess(argv, 0, "", "")
        if operation == "bootout":
            self.loaded = False
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise AssertionError(argv)


def _manager(tmp_path, *, enabled=True):
    base = tmp_path / "hermes"
    source = base / "hermes-agent"
    queue = base / "runtime" / "jarvis_event_wake"
    queue.mkdir(parents=True, mode=0o700)
    for path in (base, base / "runtime", queue):
        path.chmod(0o700)
    script = source / "tui_gateway" / "headless_owner_event.py"
    python = source / "venv" / "bin" / "python"
    script.parent.mkdir(parents=True)
    python.parent.mkdir(parents=True)
    script.write_text("# synthetic\n")
    python.symlink_to(sys.executable)
    config = base / "config.yaml"
    config.write_text(f"desktop:\n  jarvis_headless_event_activation: {str(enabled).lower()}\n")
    config.chmod(0o600)
    user_home = tmp_path / "user"
    agents = user_home / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, mode=0o700)
    for path in (user_home, user_home / "Library", agents):
        path.chmod(0o700)
    fake = FakeLaunchctl()
    manager = JarvisWakeLaunchAgent(
        profile="default", profile_home=base, hermes_home=base,
        python_executable=python, entrypoint=script,
        user_home=user_home, runner=fake,
    )
    fake.path = str(manager.path)
    return manager, fake, queue


def test_install_and_idempotent_disable(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    assert manager.install() == LaunchAgentStatus(True, True, False)
    assert manager.path.read_bytes() == manager.plist
    assert manager.path.stat().st_mode & 0o777 == 0o600
    assert ["/bin/launchctl", "bootstrap", manager.domain, str(manager.path)] in fake.calls
    assert manager.status() == LaunchAgentStatus(True, True, False)
    assert manager.disable() == LaunchAgentStatus(False, False, False)
    assert manager.disable() == LaunchAgentStatus(False, False, False)
    assert not manager.path.exists()


def test_new_user_without_launchagents_directory_can_opt_in(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    manager.directory.rmdir()
    assert manager.status() == LaunchAgentStatus(False, False, False)
    assert manager.disable() == LaunchAgentStatus(False, False, False)
    assert not manager.directory.exists() and fake.calls
    assert manager.install() == LaunchAgentStatus(True, True, False)
    assert manager.directory.stat().st_mode & 0o777 == 0o700


def test_opt_in_and_nonempty_queue_refuse_without_registration(tmp_path):
    manager, fake, _ = _manager(tmp_path, enabled=False)
    with pytest.raises(ValueError, match="not enabled"):
        manager.install()
    assert fake.calls == []
    manager, fake, queue = _manager(tmp_path / "second")
    (queue / "ticket").touch()
    with pytest.raises(ValueError, match="empty"):
        manager.install()
    assert fake.calls == []


def test_unsafe_directory_file_and_foreign_label_refuse(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    manager.directory.chmod(0o777)
    with pytest.raises(ValueError, match="unsafe"):
        manager.install()
    manager.directory.chmod(0o700)
    manager.path.symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="unknown or unsafe"):
        manager.install()
    manager.path.unlink()
    fake.loaded = True
    with pytest.raises(ValueError, match="unknown job"):
        manager.install()


def test_failed_bootstrap_rolls_back_only_new_file(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    fake.fail_bootstrap = True
    with pytest.raises(RuntimeError, match="bootstrap"):
        manager.install()
    assert not manager.path.exists()


def test_ambiguous_bootstrap_keeps_managed_file_for_recovery(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    fake.ambiguous_bootstrap = True
    with pytest.raises(RuntimeError, match="bootstrap"):
        manager.install()
    assert manager.path.read_bytes() == manager.plist
    assert fake.loaded
    assert manager.status() == LaunchAgentStatus(True, True, False)


def test_live_job_refuses_disable(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    manager.install()
    fake.running = True
    with pytest.raises(ValueError, match="live"):
        manager.disable()
    assert manager.path.exists() and fake.loaded


def test_loaded_job_from_foreign_plist_refuses_disable(tmp_path):
    manager, fake, _ = _manager(tmp_path)
    manager.install()
    fake.path = str(tmp_path / "foreign.plist")
    with pytest.raises(RuntimeError, match="identity"):
        manager.disable()
    assert manager.path.exists() and fake.loaded
