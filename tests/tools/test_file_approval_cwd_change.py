"""A file approval must apply to the exact path eventually written."""

import json

from model_tools import handle_function_call


def test_write_file_pins_target_when_task_cwd_changes_during_guard(tmp_path, monkeypatch):
    from agent import file_safety
    from tools import file_tools, terminal_tool

    ordinary_dir = tmp_path / "ordinary"
    ordinary_dir.mkdir()
    synthetic_home = tmp_path / "synthetic-home"
    ssh_dir = synthetic_home / ".ssh"
    ssh_dir.mkdir(parents=True)
    protected_target = ssh_dir / "config"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.setattr(file_safety, "_guard_homes", lambda _path="": {str(synthetic_home)})
    overrides = {"synthetic-task": {"cwd": str(ordinary_dir)}}
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", overrides)
    original_guard = file_tools._check_approval_required_write

    def change_cwd_after_guard(paths, task_id):
        result = original_guard(paths, task_id)
        overrides["synthetic-task"]["cwd"] = str(ssh_dir)
        return result

    monkeypatch.setattr(file_tools, "_check_approval_required_write", change_cwd_after_guard)
    result = json.loads(handle_function_call(
        "write_file", {"path": "config", "content": "Host synthetic\n"}, task_id="synthetic-task"))

    assert not result.get("error"), result
    assert (ordinary_dir / "config").read_text(encoding="utf-8") == "Host synthetic\n"
    assert not protected_target.exists()


def test_write_file_denies_protected_target_then_allows_safe_retry(tmp_path, monkeypatch):
    from agent import file_safety
    from tools import terminal_tool

    synthetic_home = tmp_path / "synthetic-home"
    ssh_dir = synthetic_home / ".ssh"
    ssh_dir.mkdir(parents=True)
    ordinary_dir = tmp_path / "ordinary"
    ordinary_dir.mkdir()
    protected_target = ssh_dir / "config"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.setattr(file_safety, "_guard_homes", lambda _path="": {str(synthetic_home)})
    overrides = {"synthetic-task": {"cwd": str(ssh_dir)}}
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", overrides)

    denied = json.loads(handle_function_call(
        "write_file", {"path": "config", "content": "Host denied\n"}, task_id="synthetic-task"))
    assert denied.get("error"), denied
    assert not protected_target.exists()

    overrides["synthetic-task"]["cwd"] = str(ordinary_dir)
    allowed = json.loads(handle_function_call(
        "write_file", {"path": "config", "content": "Host safe\n"}, task_id="synthetic-task"))
    assert not allowed.get("error"), allowed
    assert (ordinary_dir / "config").read_text(encoding="utf-8") == "Host safe\n"
    assert not protected_target.exists()
