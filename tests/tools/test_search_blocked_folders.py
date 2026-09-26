"""Search enforces the active profile's local blocked-folder boundary."""

import json

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from model_tools import handle_function_call
from tools import terminal_tool


def _home(tmp_path, name, folders):
    home = tmp_path / name
    home.mkdir()
    (home / "config.yaml").write_text(
        "file_tools:\n  blocked_folders: " + json.dumps([str(p) for p in folders]) + "\n",
        encoding="utf-8",
    )
    return home


def _search(path, target="content", task_id="search-blocked-synthetic"):
    pattern = "*SEARCH_BOUNDARY_TOKEN*" if target == "files" else "SEARCH_BOUNDARY_TOKEN"
    return json.loads(handle_function_call(
        "search_files", {"pattern": pattern, "target": target, "path": path},
        task_id=task_id,
    ))


def test_search_denies_blocked_root_ancestor_and_symlink_with_profile_recovery(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    blocked = workspace / "private"
    public = workspace / "public"
    blocked.mkdir(parents=True)
    public.mkdir()
    (blocked / "secret_SEARCH_BOUNDARY_TOKEN.txt").write_text(
        "SEARCH_BOUNDARY_TOKEN\n", encoding="utf-8")
    (public / "visible_SEARCH_BOUNDARY_TOKEN.txt").write_text(
        "SEARCH_BOUNDARY_TOKEN\n", encoding="utf-8")
    (workspace / "alias").symlink_to(blocked, target_is_directory=True)
    home_a = _home(tmp_path, "profile-a", [blocked])
    home_b = _home(tmp_path, "profile-b", [])
    task_id = "search-blocked-synthetic"
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {task_id: {"cwd": str(workspace)}})

    for home, denied in ((home_a, True), (home_b, False), (home_a, True)):
        token = set_hermes_home_override(home)
        try:
            for target in ("content", "files"):
                for path in ("private", "alias", "."):
                    result = _search(path, target, task_id)
                    assert bool(result.get("error")) is denied, result
                    if denied:
                        assert "blocked" in result["error"].lower(), result
                multi = _search("public, private", target, task_id)
                assert bool(multi.get("error")) is denied, multi
                visible = _search("public", target, task_id)
                assert not visible.get("error"), visible
                assert visible["total_count"] == 1, visible
        finally:
            reset_hermes_home_override(token)


def test_search_invalid_config_and_remote_backend_fail_closed(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "note.txt").write_text("SEARCH_BOUNDARY_TOKEN\n", encoding="utf-8")
    invalid = tmp_path / "invalid"
    invalid.mkdir()
    (invalid / "config.yaml").write_text(
        "file_tools:\n  blocked_folders: [relative-folder]\n", encoding="utf-8")
    task_id = "search-invalid-synthetic"
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {task_id: {"cwd": str(workspace)}})

    token = set_hermes_home_override(invalid)
    try:
        result = _search(".", task_id=task_id)
        assert "invalid" in result.get("error", "").lower(), result
    finally:
        reset_hermes_home_override(token)

    configured = _home(tmp_path, "configured", [workspace / "private"])
    token = set_hermes_home_override(configured)
    try:
        import tools.file_tools as file_tools

        monkeypatch.setattr(file_tools, "_file_ops_uses_host_paths", lambda ops: False)
        result = _search("note.txt", task_id=task_id)
        assert "remote" in result.get("error", "").lower(), result
    finally:
        reset_hermes_home_override(token)
