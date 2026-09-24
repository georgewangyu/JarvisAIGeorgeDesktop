"""Consumer setup backups exclude history and scheduler authority."""

import json
import tarfile

import pytest

from hermes_cli import profiles
from hermes_cli.consumer_setup_export import export_consumer_setup


@pytest.mark.parametrize("name", ["default", "helper"])
def test_setup_backup_excludes_history_credentials_and_active_routines(tmp_path, monkeypatch, name):
    default = tmp_path / "hermes"
    named = default / "profiles" / "helper"
    home = default if name == "default" else named
    home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: default / "profiles")

    (home / "config.yaml").write_text(
        "model: test-model\ndisplay:\n  skin: slate\n  language: en\n"
        "provider:\n  api_key: private-config-token\n",
        encoding="utf-8",
    )
    (home / "SOUL.md").write_text("Helpful setup. OPENROUTER_API_KEY=sk-or-v1-reallyLongSecretKeyValue12345678\n")
    (home / ".env").write_text("OPENROUTER_API_KEY=private-env-token\n")
    (home / "auth.json").write_text('{"token":"private-auth-token"}')
    (home / "state.db").write_bytes(b"hidden worker transcript")
    (home / "sessions").mkdir()
    (home / "sessions" / "chat.json").write_text("private chat")
    (home / "cron").mkdir()
    (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"name": "internal worker", "enabled": True, "prompt": "secret worker brief"}
    ]}))
    (home / "skills" / "demo").mkdir(parents=True)
    (home / "skills" / "demo" / "SKILL.md").write_text("# Useful skill\n")
    (home / "skills" / "demo" / "secret.py").write_text("private plugin code")

    archive = export_consumer_setup(name, str(tmp_path / f"{name}.tgz"), extra_files={
        "desktop.json": '{"version":1,"skin":"slate"}',
    })
    assert archive == tmp_path / f"{name}.tar.gz"
    assert archive.stat().st_mode & 0o777 == 0o600
    with tarfile.open(archive, "r:gz") as tf:
        files = {member.name: tf.extractfile(member).read().decode("utf-8")
                 for member in tf.getmembers() if member.isfile()}
    assert set(files) == {
        f"{name}/config.yaml", f"{name}/SOUL.md", f"{name}/skills/demo/SKILL.md",
        f"{name}/desktop.json", f"{name}/setup-backup.json",
    }
    content = "\n".join(files.values())
    for secret in ("private-config-token", "private-env-token", "private-auth-token",
                   "hidden worker transcript", "private chat", "secret worker brief",
                   "sk-or-v1-reallyLongSecretKeyValue12345678"):
        assert secret not in content
    config = json.loads(files[f"{name}/config.yaml"])
    assert config == {"model": "test-model", "display": {"skin": "slate", "language": "en"}}
    assert "routines" in json.loads(files[f"{name}/setup-backup.json"])["omitted"]

    restored = profiles.import_profile(str(archive), name=f"restored_{name}")
    assert not (restored / "cron" / "jobs.json").exists()
    assert not (restored / "state.db").exists()
    monkeypatch.setenv("HERMES_HOME", str(restored))
    from cron.jobs import load_jobs
    assert load_jobs() == []

    protected = home / "existing.tar.gz"
    protected.write_bytes(b"profile data must remain intact")
    with pytest.raises(ValueError, match="outside Jarvis"):
        export_consumer_setup(name, str(protected))
    assert protected.read_bytes() == b"profile data must remain intact"
    with pytest.raises(ValueError, match="absolute"):
        export_consumer_setup(name, "relative.tar.gz")
    with pytest.raises(ValueError, match="folder does not exist"):
        export_consumer_setup(name, str(tmp_path / "missing" / "setup.tar.gz"))
    outside = tmp_path / "existing.tar.gz"
    outside.write_bytes(b"other user data")
    linked = tmp_path / "linked.tar.gz"
    linked.symlink_to(outside)
    with pytest.raises(ValueError, match="symbolic link"):
        export_consumer_setup(name, str(linked))
    assert outside.read_bytes() == b"other user data"


def test_consumer_export_api_keeps_advanced_export_separate(tmp_path, monkeypatch):
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
    from starlette.testclient import TestClient

    default = tmp_path / "hermes"
    default.mkdir()
    (default / "config.yaml").write_text("model: test-model\n")
    (default / "state.db").write_bytes(b"internal state")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: default / "profiles")

    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    narrow = client.post("/api/profiles/default/export-consumer-setup", json={
        "output": str(tmp_path / "setup.tar.gz"),
    })
    assert narrow.status_code == 200
    with tarfile.open(narrow.json()["archive"], "r:gz") as tf:
        assert "default/state.db" not in tf.getnames()
    bad_extra = client.post("/api/profiles/default/export-consumer-setup", json={
        "output": str(tmp_path / "bad.tar.gz"),
        "extra_files": {"state.db": "injected"},
    })
    assert bad_extra.status_code == 400
    assert not (tmp_path / "bad.tar.gz").exists()
    unsafe_overlay = client.post("/api/profiles/default/export-consumer-setup", json={
        "output": str(tmp_path / "unsafe.tar.gz"),
        "extra_files": {"desktop.json": json.dumps({"version": 1, "layoutTree": {
            "workingDirectory": "/private/worker/path",
        }})},
    })
    assert unsafe_overlay.status_code == 400
    assert not (tmp_path / "unsafe.tar.gz").exists()
