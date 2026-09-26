"""Local file-tool blocked folders use the active profile and the task's path namespace."""

import json

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from model_tools import handle_function_call
from tools import terminal_tool


def _config(home, folders):
    home.mkdir()
    (home / "config.yaml").write_text(
        "file_tools:\n  blocked_folders: " + json.dumps([str(p) for p in folders]) + "\n"
        "approvals:\n  mode: off\n", encoding="utf-8")


def _call(name, args, task_id="blocked-folder-synthetic"):
    return json.loads(handle_function_call(name, args, task_id=task_id))


def test_blocked_folder_denies_local_read_write_patch_and_symlink(tmp_path, monkeypatch):
    home = tmp_path / "profile"
    workspace = tmp_path / "workspace"
    blocked = workspace / "private"
    blocked.mkdir(parents=True)
    (blocked / "note.txt").write_text("original\n", encoding="utf-8")
    outside = workspace / "outside.txt"
    outside.write_text("not blocked\n", encoding="utf-8")
    (blocked / "outbound.txt").symlink_to(outside)
    alias = workspace / "alias"
    alias.symlink_to(blocked, target_is_directory=True)
    _config(home, [blocked])
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {
        "blocked-folder-synthetic": {"cwd": str(workspace)}})
    token = set_hermes_home_override(home)
    try:
        for path in ("private/note.txt", "alias/note.txt", "private/outbound.txt"):
            denied = _call("read_file", {"path": path})
            assert denied.get("error") and "blocked" in denied["error"].lower(), denied

        denied = _call("write_file", {"path": "alias/new.txt", "content": "nope"})
        assert denied.get("error") and "blocked" in denied["error"].lower(), denied
        assert not (blocked / "new.txt").exists()
        denied = _call("write_file", {"path": "private/outbound.txt", "content": "nope"})
        assert denied.get("error") and "blocked" in denied["error"].lower(), denied
        assert outside.read_text(encoding="utf-8") == "not blocked\n"

        denied = _call("patch", {
            "path": "private/note.txt", "old_string": "original", "new_string": "changed"})
        assert denied.get("error") and "blocked" in denied["error"].lower(), denied
        assert (blocked / "note.txt").read_text(encoding="utf-8") == "original\n"

        denied = _call("patch", {
            "mode": "patch",
            "patch": "*** Begin Patch\n*** Update File: private/note.txt\n@@\n-original\n+changed\n*** End Patch\n",
        })
        assert denied.get("error") and "blocked" in denied["error"].lower(), denied
        assert (blocked / "note.txt").read_text(encoding="utf-8") == "original\n"
    finally:
        reset_hermes_home_override(token)


def test_blocked_folder_policy_does_not_leak_between_profiles(tmp_path, monkeypatch):
    target = tmp_path / "workspace" / "note.txt"
    target.parent.mkdir()
    target.write_text("visible\n", encoding="utf-8")
    home_a = tmp_path / "profile-a"
    home_b = tmp_path / "profile-b"
    _config(home_a, [target.parent])
    _config(home_b, [])
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {
        "blocked-folder-synthetic": {"cwd": str(target.parent)}})

    for home, denied in ((home_a, True), (home_b, False), (home_a, True)):
        token = set_hermes_home_override(home)
        try:
            result = _call("read_file", {"path": str(target)})
            assert bool(result.get("error")) is denied, result
            if not denied:
                assert "visible" in result.get("content", ""), result
        finally:
            reset_hermes_home_override(token)


def test_invalid_blocked_folder_configuration_fails_closed(tmp_path):
    home = tmp_path / "profile"
    home.mkdir()
    (home / "config.yaml").write_text(
        "file_tools:\n  blocked_folders: [relative-folder]\n", encoding="utf-8")
    target = tmp_path / "note.txt"
    target.write_text("visible\n", encoding="utf-8")
    token = set_hermes_home_override(home)
    try:
        result = _call("read_file", {"path": str(target)})
        assert result.get("error") and "invalid" in result["error"].lower(), result
    finally:
        reset_hermes_home_override(token)
