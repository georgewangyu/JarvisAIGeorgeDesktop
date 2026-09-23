"""Feed generation persists real attempt outcomes without a provider in tests."""

import threading
import time

import pytest

from hermes_cli import feed_editions as feed


def _eventually(getter, status):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        row = getter()
        if row and row["status"] == status:
            return row
        time.sleep(0.01)
    raise AssertionError(f"edition did not reach {status}")


def test_explicit_generation_persists_output_and_refuses_duplicate(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    release = threading.Event()

    def runner(prompt, edition_id):
        assert prompt == "Research the latest release"
        assert edition_id
        assert release.wait(5)
        return "Release notes: https://example.test/release", None

    row = feed.request_edition("Research the latest release", runner=runner)
    assert row["status"] == "generating"
    with pytest.raises(RuntimeError, match="already generating"):
        feed.request_edition("Another edition", runner=runner)
    release.set()
    completed = _eventually(lambda: feed.get_edition(row["id"]), "completed")
    assert completed["content"].startswith("Release notes")
    assert completed["source_urls"] == ["https://example.test/release"]
    assert completed["prompt"] == row["prompt"]
    assert feed.list_editions()[0]["id"] == row["id"]

    # The production FastAPI app mounts the same store behind dashboard auth.
    from starlette.testclient import TestClient
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(feed, "_run_real_agent", lambda *_: ("API output", None))
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    response = client.post("/api/feed/editions", json={"prompt": "API request"})
    assert response.status_code == 202
    api_id = response.json()["edition"]["id"]
    assert _eventually(lambda: feed.get_edition(api_id), "completed")["content"] == "API output"
    assert client.get(f"/api/feed/editions/{api_id}").json()["edition"]["prompt"] == "API request"


def test_failure_and_interruption_require_explicit_retry(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")

    # Another process's fresh lease is still live; its UUID difference alone
    # cannot authorize a second model call. An expired lease may be retried.
    with feed._connect() as db:
        db.execute(
            "INSERT INTO editions VALUES (?, ?, 'generating', ?, NULL, NULL, NULL, ?, 1, ?, '[]', ?)",
            ("other", "Prior prompt", feed._now(), "other-process", "cron.run_job", time.time()),
        )
    with pytest.raises(RuntimeError, match="already generating"):
        feed.request_edition("Make a sourced digest", runner=lambda *_: ("unexpected", None))
    assert feed.get_edition("other")["status"] == "generating"
    with feed._connect() as db:
        db.execute(
            "UPDATE editions SET heartbeat_at=? WHERE id='other'",
            (time.time() - feed._LEASE_SECONDS - 1,),
        )
    assert feed.get_edition("other")["status"] == "interrupted"

    def denied(_prompt, _edition_id):
        raise PermissionError("provider unavailable")

    row = feed.request_edition("Make a sourced digest", runner=denied)
    failed = _eventually(lambda: feed.get_edition(row["id"]), "denied")
    assert failed["content"] is None
    assert "provider unavailable" in failed["error"]
    with pytest.raises(ValueError, match="original prompt"):
        feed.request_edition("Changed prompt", retry_id=row["id"], runner=denied)

    retried = feed.request_edition(
        "Make a sourced digest", retry_id=row["id"],
        runner=lambda prompt, edition_id: ("Verified output", None),
    )
    assert retried["id"] == row["id"]
    assert retried["attempt"] == 2
    assert _eventually(lambda: feed.get_edition(row["id"]), "completed")["content"] == "Verified output"
    with pytest.raises(ValueError, match="Only failed"):
        feed.request_edition("Make a sourced digest", retry_id=row["id"], runner=denied)

    # Production seam executes the agent lifecycle once, without registering a
    # scheduled job or sending a delivery. The test never reaches a provider.
    import cron.scheduler as scheduler

    calls = []

    def fake_run_job(job):
        calls.append(job)
        return True, "audit document", "Agent result", None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    assert feed._run_real_agent("Deliberate request", "abcdef1234567890") == ("Agent result", None)
    assert calls[0]["prompt"] == "Deliberate request"
    assert calls[0]["id"] == "abcdef123456"
    assert calls[0]["deliver"] == "local"


def test_api_editions_are_profile_local_across_a_b_a(tmp_path, monkeypatch):
    """A shared serve process must not mix edition storage between profiles."""
    from starlette.testclient import TestClient

    from hermes_cli import profiles
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    default_home = tmp_path / ".hermes"
    profiles_root = default_home / "profiles"
    other_home = profiles_root / "worker_alpha"
    for home in (default_home, other_home):
        home.mkdir(parents=True)
        (home / "config.yaml").write_text("model: test-model\n", encoding="utf-8")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setattr(feed, "_run_real_agent", lambda prompt, _: (f"Edition: {prompt}", None))

    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    a = client.post("/api/feed/editions", json={"prompt": "Default only"})
    assert a.status_code == 202
    a_id = a.json()["edition"]["id"]
    b = client.post("/api/feed/editions?profile=worker_alpha", json={"prompt": "Worker only"})
    assert b.status_code == 202
    b_id = b.json()["edition"]["id"]

    def listed(profile=None):
        suffix = f"?profile={profile}" if profile else ""
        return client.get(f"/api/feed/editions{suffix}").json()["editions"]

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if len(listed()) == 1 and len(listed("worker_alpha")) == 1:
            if listed()[0]["status"] == listed("worker_alpha")[0]["status"] == "completed":
                break
        time.sleep(0.01)
    assert [row["id"] for row in listed()] == [a_id]
    assert [row["id"] for row in listed("worker_alpha")] == [b_id]
    assert [row["id"] for row in listed()] == [a_id]
    assert client.get(f"/api/feed/editions/{b_id}").status_code == 404
    assert client.get(f"/api/feed/editions/{a_id}?profile=worker_alpha").status_code == 404
    assert (default_home / "feed" / "editions.sqlite3").exists()
    assert (other_home / "feed" / "editions.sqlite3").exists()
