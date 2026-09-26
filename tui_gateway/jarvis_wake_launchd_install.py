"""Explicit, opt-in macOS user LaunchAgent management for Jarvis wake.

Nothing imports or invokes this manager at startup. The caller must supply the
exact installed profile inputs and explicitly call install/disable/status.
"""

from __future__ import annotations

import os
import pwd
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from tui_gateway.jarvis_wake_launchd import (
    launch_agent_label,
    render_launch_agent_plist,
    validate_launch_agent_readiness,
)


Runner = Callable[[list[str]], subprocess.CompletedProcess[str]]
_NOT_FOUND = re.compile(r"\bCould not find service\b", re.IGNORECASE)
_STATE = re.compile(r"^\s*state = ([a-z]+)\s*$", re.MULTILINE)
_PID = re.compile(r"^\s*pid = \d+\s*$", re.MULTILINE)
_PATH = re.compile(r"^\s*path = (.+?)\s*$", re.MULTILINE)


def _run_launchctl(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=10, check=False)


@dataclass(frozen=True)
class LaunchAgentStatus:
    installed: bool
    loaded: bool
    running: bool


class JarvisWakeLaunchAgent:
    """Manage one exact per-profile plist in the current user's GUI domain."""

    def __init__(
        self, *, profile: str, profile_home: Path | str,
        python_executable: Path | str, entrypoint: Path | str,
        hermes_home: Path | str, user_home: Path | str | None = None,
        runner: Runner = _run_launchctl,
    ) -> None:
        self.inputs = dict(
            profile=profile, profile_home=profile_home,
            python_executable=python_executable, entrypoint=entrypoint,
            hermes_home=hermes_home,
        )
        self.plist = render_launch_agent_plist(**self.inputs)
        self.label = launch_agent_label(profile, profile_home)
        # HOME is process-controlled in the gateway; use the login account's
        # registered home for a real installation. An override is for isolated
        # tests and must never be supplied by a renderer request.
        self.user_home = (Path(pwd.getpwuid(os.getuid()).pw_dir)
                          if user_home is None else Path(user_home))
        if not self.user_home.is_absolute() or ".." in self.user_home.parts:
            raise ValueError("user home must be an absolute path without traversal")
        self.directory = self.user_home / "Library" / "LaunchAgents"
        self.path = self.directory / f"{self.label}.plist"
        self.domain = f"gui/{os.getuid()}"
        self.runner = runner

    def _checked_directory(self, *, create: bool = False) -> bool:
        if os.getuid() == 0 or os.geteuid() != os.getuid():
            raise ValueError("a non-root, unprivileged user session is required")
        current = Path(self.directory.anchor)
        for part in self.directory.parts[1:]:
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError:
                if current != self.directory:
                    raise
                if not create:
                    return False
                current.mkdir(mode=0o700)
                info = current.lstat()
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.getuid()}
                    or (stat.S_IMODE(info.st_mode) & 0o022 and not sticky_root)):
                raise ValueError(f"unsafe LaunchAgents directory component: {current}")
        info = self.directory.lstat()
        if info.st_uid != os.getuid():
            raise ValueError("LaunchAgents directory must belong to this user")
        return True

    def _checked_file(self) -> os.stat_result | None:
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            return None
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077
                or self.path.read_bytes() != self.plist):
            raise ValueError("an unknown or unsafe LaunchAgent occupies the managed path")
        return info

    def _call(self, *args: str) -> subprocess.CompletedProcess[str]:
        result = self.runner(["/bin/launchctl", *args])
        if not isinstance(result, subprocess.CompletedProcess):
            raise ValueError("launchctl runner returned no completed result")
        return result

    def _loaded(self) -> tuple[bool, bool]:
        result = self._call("print", f"{self.domain}/{self.label}")
        if result.returncode != 0:
            if _NOT_FOUND.search(result.stderr or "") and not result.stdout:
                return False, False
            raise RuntimeError("cannot determine the exact launchd job state")
        states = _STATE.findall(result.stdout or "")
        paths = _PATH.findall(result.stdout or "")
        if len(states) != 1 or paths != [str(self.path)]:
            raise RuntimeError("launchd job identity or state is unknown")
        running = states[0] != "waiting" or bool(_PID.search(result.stdout))
        return True, running

    def status(self) -> LaunchAgentStatus:
        directory_exists = self._checked_directory()
        installed = directory_exists and self._checked_file() is not None
        loaded, running = self._loaded()
        if loaded and not installed:
            raise ValueError("an unknown job owns the managed launchd label")
        return LaunchAgentStatus(installed, loaded, running)

    def install(self) -> LaunchAgentStatus:
        """Register only from an idle, opted-in, empty-queue snapshot."""
        validate_launch_agent_readiness(self.plist, **self.inputs)
        queue = Path(self.inputs["profile_home"]) / "runtime" / "jarvis_event_wake"
        if any(queue.iterdir()):
            raise ValueError("wake queue must be empty before installation")
        self._checked_directory(create=True)
        existing = self._checked_file()
        loaded, running = self._loaded()
        if loaded:
            if existing is None:
                raise ValueError("an unknown job owns the managed launchd label")
            if running:
                raise ValueError("the managed launchd job is live")
            return LaunchAgentStatus(True, True, False)

        created: os.stat_result | None = None
        if existing is None:
            descriptor, temporary = tempfile.mkstemp(prefix=f".{self.label}.", dir=self.directory)
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(self.plist)
                    stream.flush()
                    os.fsync(stream.fileno())
                # link is exclusive: never replace a newly appeared foreign file.
                os.link(temporary, self.path, follow_symlinks=False)
                created = self.path.lstat()
                self._sync_directory()
            finally:
                Path(temporary).unlink(missing_ok=True)

        try:
            result = self._call("bootstrap", self.domain, str(self.path))
            if result.returncode != 0:
                raise RuntimeError("launchctl bootstrap failed")
            loaded_after, running_after = self._loaded()
            if not loaded_after:
                raise RuntimeError("launchctl bootstrap did not load the managed job")
        except Exception:
            if created is not None:
                # A failed/ambiguous bootstrap may still have loaded the job.
                # Only remove our file when launchd proves the label absent.
                loaded, _ = self._loaded()
                if not loaded:
                    current = self.path.lstat()
                    if current.st_ino == created.st_ino and current.st_dev == created.st_dev:
                        self.path.unlink()
                        self._sync_directory()
            raise
        return LaunchAgentStatus(True, True, running_after)

    def disable(self) -> LaunchAgentStatus:
        """Unload an idle owned job and remove only its exact managed plist."""
        directory_exists = self._checked_directory()
        existing = self._checked_file() if directory_exists else None
        loaded, running = self._loaded()
        if loaded and existing is None:
            raise ValueError("an unknown job owns the managed launchd label")
        if running:
            raise ValueError("the managed launchd job is live")
        if loaded:
            result = self._call("bootout", f"{self.domain}/{self.label}")
            if result.returncode != 0:
                raise RuntimeError("launchctl bootout failed")
            still_loaded, _ = self._loaded()
            if still_loaded:
                raise RuntimeError("launchctl bootout did not unload the managed job")
        if existing is not None:
            current = self._checked_file()
            if current is None or (current.st_dev, current.st_ino) != (existing.st_dev, existing.st_ino):
                raise RuntimeError("managed LaunchAgent changed during disable")
            self.path.unlink()
            self._sync_directory()
        return LaunchAgentStatus(False, False, False)

    def _sync_directory(self) -> None:
        descriptor = os.open(self.directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
