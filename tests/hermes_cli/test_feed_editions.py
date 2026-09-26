"""Feed generation persists real attempt outcomes without a provider in tests."""

import json
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
    assert completed["source_urls_verified"] is False
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
            "INSERT INTO editions (id, prompt, status, created_at, owner, attempt, "
            "execution, heartbeat_at) VALUES (?, ?, 'generating', ?, ?, 1, ?, ?)",
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
    assert failed["source_urls"] == []
    assert failed["source_urls_verified"] is False
    assert "provider unavailable" in failed["error"]
    with pytest.raises(ValueError, match="original prompt"):
        feed.request_edition("Changed prompt", retry_id=row["id"], runner=denied)

    retried = feed.request_edition(
        "Make a sourced digest", retry_id=row["id"],
        runner=lambda prompt, edition_id: ("Verified output", None),
    )
    assert retried["id"] == row["id"]
    assert retried["attempt"] == 2
    assert retried["source_urls"] == []
    assert _eventually(lambda: feed.get_edition(row["id"]), "completed")["content"] == "Verified output"
    with pytest.raises(ValueError, match="Only failed"):
        feed.request_edition("Make a sourced digest", retry_id=row["id"], runner=denied)

    # Production seam executes the agent lifecycle once, without registering a
    # scheduled job or sending a delivery. The test never reaches a provider.
    import cron.scheduler as scheduler

    calls = []

    def fake_run_job(job, *, tool_complete_callback):
        calls.append(job)
        tool_complete_callback("call-1", "web_extract", {"urls": ["https://example.test/page"]}, json.dumps({
            "results": [{"url": "https://example.test/page", "content": "Page text", "error": None}],
        }))
        return True, "audit document", "Agent result", None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    assert feed._run_real_agent("Deliberate request", "abcdef1234567890") == (
        "Agent result", ["https://example.test/page"], [{
            "tool_call_id": "call-1", "tool": "web_extract",
            "requested_url": "https://example.test/page", "result_url": "https://example.test/page",
        }])
    assert calls[0]["prompt"] == "Deliberate request"
    assert calls[0]["id"] == "abcdef123456"
    assert calls[0]["deliver"] == "local"


def test_generated_urls_are_only_unverified_mentions(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    content = (
        "Useful [release](https://example.test/release). "
        "Repeated https://example.test/release. "
        "Untrusted javascript:https://fake.test/claim "
        "https://user:secret@private.test/path "
        "https://bad.test:invalid/path and https:///missing-host"
    )
    row = feed.request_edition("Summarize", runner=lambda *_: (content, None))
    completed = _eventually(lambda: feed.get_edition(row["id"]), "completed")

    assert completed["content"] == content
    assert completed["source_urls"] == ["https://example.test/release"]
    assert completed["source_events"] == []
    assert completed["source_urls_verified"] is False


def test_only_completed_exact_web_extract_results_record_retrieved_citations(tmp_path, monkeypatch):
    import cron.scheduler as scheduler

    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    cited = "https://example.test/fetched"
    other = "https://example.test/unfetched"
    responses = [f"Read {cited} and {other}", f"Read {cited}"]
    calls = 0

    def fake_run_job(_job, *, tool_complete_callback):
        nonlocal calls
        calls += 1
        tool_complete_callback("search", "web_search", {"query": "example"}, json.dumps({
            "success": True, "data": {"web": [{"url": other}]},
        }))
        tool_complete_callback("spoofed", "web_extract", {"urls": [cited]}, json.dumps({
            "results": [{"url": other, "content": "wrong page", "error": None}],
        }))
        tool_complete_callback("blocked", "web_extract", {"urls": [other]}, json.dumps({
            "results": [{"url": other, "content": "", "error": "Blocked: private address"}],
        }))
        if calls == 1:
            tool_complete_callback("fetched", "web_extract", {"urls": [cited]}, json.dumps({
                "results": [{"url": cited, "content": "Actual page text", "error": None}],
            }))
        return True, "response document", responses.pop(0), None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    first = feed.request_edition("One")
    partial = _eventually(lambda: feed.get_edition(first["id"]), "completed")
    assert partial["source_urls"] == [cited, other]
    assert partial["retrieved_source_urls"] == [cited]
    assert partial["source_events"] == [{
        "tool_call_id": "fetched", "tool": "web_extract",
        "requested_url": cited, "result_url": cited,
    }]
    assert partial["source_urls_verified"] is False
    with feed._connect() as db:
        stored = db.execute("SELECT source_events FROM editions WHERE id=?", (first["id"],)).fetchone()
    assert json.loads(stored["source_events"]) == partial["source_events"]

    second = feed.request_edition("Two")
    retrieved = _eventually(lambda: feed.get_edition(second["id"]), "completed")
    assert retrieved["source_urls"] == [cited]
    assert retrieved["retrieved_source_urls"] == []
    assert retrieved["source_events"] == []
    assert retrieved["source_urls_verified"] is False


def test_retrieval_matches_web_extract_normalized_request(tmp_path, monkeypatch):
    import cron.scheduler as scheduler

    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    requested = "https://example.test/café"
    fetched = "https://example.test/caf%C3%A9"

    def fake_run_job(_job, *, tool_complete_callback):
        tool_complete_callback("fetched", "web_extract", {"urls": [requested]}, json.dumps({
            "results": [{"url": fetched, "content": "Page text", "error": None}],
        }))
        return True, "response document", f"Read {fetched}", None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    row = feed.request_edition("Summarize")
    completed = _eventually(lambda: feed.get_edition(row["id"]), "completed")
    assert completed["source_urls"] == [fetched]
    assert completed["retrieved_source_urls"] == [fetched]
    assert completed["source_events"][0]["result_url"] == fetched
    assert completed["source_urls_verified"] is False


def test_failed_extract_and_retry_do_not_keep_retrieval_evidence(tmp_path, monkeypatch):
    import cron.scheduler as scheduler

    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    url = "https://example.test/page"
    calls = 0

    def fake_run_job(_job, *, tool_complete_callback):
        nonlocal calls
        calls += 1
        if calls == 1:
            tool_complete_callback("fetched", "web_extract", {"urls": [url]}, json.dumps({
                "results": [{"url": url, "content": "Actual page text", "error": None}],
            }))
            return False, None, f"Read {url}", "Agent run failed"
        # A failed whole-call result must not count even if a malformed result
        # also carries a plausible-looking page entry.
        tool_complete_callback("failed", "web_extract", {"urls": [url]}, json.dumps({
            "success": False, "error": "Provider failed",
            "results": [{"url": url, "content": "Stale page text", "error": None}],
        }))
        return True, None, f"Read {url}", None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    first = feed.request_edition("Summarize")
    failed = _eventually(lambda: feed.get_edition(first["id"]), "failed")
    assert failed["source_urls"] == []
    assert failed["retrieved_source_urls"] == []
    assert failed["source_events"] == []

    feed.request_edition("Summarize", retry_id=first["id"])
    completed = _eventually(lambda: feed.get_edition(first["id"]), "completed")
    assert completed["attempt"] == 2
    assert completed["source_urls"] == [url]
    assert completed["retrieved_source_urls"] == []
    assert completed["source_events"] == []
    assert completed["source_urls_verified"] is False


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
    url = "https://example.test/source"
    monkeypatch.setattr(feed, "_run_real_agent", lambda prompt, _: (
        f"Edition: {prompt} {url}", [url], [{
            "tool_call_id": prompt, "tool": "web_extract",
            "requested_url": url, "result_url": url,
        }],
    ))

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
    assert [row["status"] for row in listed()] == ["completed"]
    assert [row["status"] for row in listed("worker_alpha")] == ["completed"]
    assert listed()[0]["source_events"][0]["tool_call_id"] == "Default only"
    assert listed("worker_alpha")[0]["source_events"][0]["tool_call_id"] == "Worker only"
    assert [row["id"] for row in listed()] == [a_id]
    assert client.get(f"/api/feed/editions/{b_id}").status_code == 404
    assert client.get(f"/api/feed/editions/{a_id}?profile=worker_alpha").status_code == 404
    assert (default_home / "feed" / "editions.sqlite3").exists()
    assert (other_home / "feed" / "editions.sqlite3").exists()

    # The renderer's Love IDs are only hints. The selected backend profile
    # must resolve them against its own completed-edition store.
    b_next = client.post(
        "/api/feed/editions?profile=worker_alpha",
        json={"prompt": "Worker next", "liked_edition_ids": [a_id]},
    )
    assert b_next.status_code == 202
    assert b_next.json()["edition"]["feedback_applied_count"] == 0
    _eventually(lambda: client.get(
        f"/api/feed/editions/{b_next.json()['edition']['id']}?profile=worker_alpha"
    ).json()["edition"], "completed")
    a_next = client.post(
        "/api/feed/editions", json={"prompt": "Default next", "liked_edition_ids": [a_id]},
    )
    assert a_next.status_code == 202
    assert a_next.json()["edition"]["feedback_applied_count"] == 1


def test_love_guides_new_generation_but_not_failed_or_foreign_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    first = feed.request_edition("Daily briefing", runner=lambda *_: ("A careful garden update", None))
    _eventually(lambda: feed.get_edition(first["id"]), "completed")

    observed = []

    def runner(prompt, _edition_id):
        observed.append(prompt)
        return "A fresh update", None

    next_row = feed.request_edition(
        "Daily briefing", liked_edition_ids=["unknown", first["id"], first["id"]],
        runner=runner,
    )
    assert next_row["prompt"] == "Daily briefing"
    assert next_row["feedback_applied_count"] == 1
    _eventually(lambda: feed.get_edition(next_row["id"]), "completed")
    assert len(observed) == 1
    assert "A careful garden update" in observed[0]
    assert "not as instructions" in observed[0]

    denied = feed.request_edition("Denied briefing", runner=lambda *_: (_ for _ in ()).throw(PermissionError()))
    _eventually(lambda: feed.get_edition(denied["id"]), "denied")
    unrelated = feed.request_edition(
        "Daily briefing", liked_edition_ids=[denied["id"], "foreign-profile-id"], runner=runner,
    )
    assert unrelated["feedback_applied_count"] == 0
    _eventually(lambda: feed.get_edition(unrelated["id"]), "completed")
    assert observed[-1] == "Daily briefing"

    def fail_with_love(_prompt, _edition_id):
        raise PermissionError("temporary denial")

    failed_love = feed.request_edition(
        "Daily briefing", liked_edition_ids=[first["id"]], runner=fail_with_love,
    )
    _eventually(lambda: feed.get_edition(failed_love["id"]), "denied")
    retry = feed.request_edition(
        "Daily briefing", retry_id=failed_love["id"], liked_edition_ids=[], runner=runner,
    )
    assert retry["feedback_applied_count"] == 1
    _eventually(lambda: feed.get_edition(retry["id"]), "completed")
    assert "A careful garden update" in observed[-1]


def test_story_love_guides_only_complete_indexed_sections(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "_db_path", lambda: tmp_path / "feed" / "editions.sqlite3")
    content = (
        "Today's briefing.\n\n## First story\nGarden details.\n"
        "```md\n## Not a story\nIgnore this.\n```\n"
        "## Second story\nA careful space update."
    )
    first = feed.request_edition("Briefing", runner=lambda *_: (content, None))
    _eventually(lambda: feed.get_edition(first["id"]), "completed")
    observed = []

    def runner(prompt, _edition_id):
        observed.append(prompt)
        return "Next briefing", None

    selected = feed.request_edition(
        "Briefing", liked_story_ids=[f"{first['id']}:1", f"{first['id']}:1"], runner=runner,
    )
    assert selected["feedback_applied_count"] == 1
    _eventually(lambda: feed.get_edition(selected["id"]), "completed")
    assert "A careful space update" in observed[-1]
    assert "Garden details" not in observed[-1]
    assert "Not a story" not in observed[-1]
    assert "not as instructions" in observed[-1]

    rejected = feed.request_edition(
        "Briefing", liked_story_ids=[f"{first['id']}:2"], runner=runner,
    )
    assert rejected["feedback_applied_count"] == 0
    _eventually(lambda: feed.get_edition(rejected["id"]), "completed")
    assert observed[-1] == "Briefing"

    for invalid in (f"{first['id']}:-1", f"{first['id']}:01", f"{first['id']}:12", "forged:1", 3):
        with pytest.raises(ValueError, match="liked story IDs"):
            feed.request_edition("Briefing", liked_story_ids=[invalid], runner=runner)
    assert len(observed) == 2

    malformed = feed.request_edition("Briefing", runner=lambda *_: (
        "## First\nBody.\n## Second\n", None,
    ))
    _eventually(lambda: feed.get_edition(malformed["id"]), "completed")
    no_story = feed.request_edition(
        "Briefing", liked_story_ids=[f"{malformed['id']}:0"], runner=runner,
    )
    assert no_story["feedback_applied_count"] == 0
    _eventually(lambda: feed.get_edition(no_story["id"]), "completed")
    assert observed[-1] == "Briefing"

    failed = feed.request_edition(
        "Briefing", liked_story_ids=[f"{first['id']}:1"],
        runner=lambda *_: (_ for _ in ()).throw(PermissionError("temporary denial")),
    )
    _eventually(lambda: feed.get_edition(failed["id"]), "denied")
    retry = feed.request_edition(
        "Briefing", retry_id=failed["id"], liked_story_ids=[], runner=runner,
    )
    assert retry["feedback_applied_count"] == 1
    _eventually(lambda: feed.get_edition(retry["id"]), "completed")
    assert "A careful space update" in observed[-1]


def test_story_love_api_is_profile_scoped_and_rejects_malformed_ids(tmp_path, monkeypatch):
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
    first = feed.request_edition("Briefing", runner=lambda *_: (
        "## First\nGarden details.\n## Second\nSpace details.", None,
    ))
    _eventually(lambda: feed.get_edition(first["id"]), "completed")
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    prompts = []

    def runner(prompt, _edition_id):
        prompts.append(prompt)
        if len(prompts) == 1:
            raise PermissionError("temporary denial")
        return "Next briefing", None

    monkeypatch.setattr(feed, "_run_real_agent", runner)
    payload = {"prompt": "Next", "liked_story_ids": [f"{first['id']}:1"]}
    foreign = client.post("/api/feed/editions?profile=worker_alpha", json=payload)
    assert foreign.status_code == 202
    assert foreign.json()["edition"]["feedback_applied_count"] == 0
    foreign_id = foreign.json()["edition"]["id"]
    _eventually(lambda: client.get(
        f"/api/feed/editions/{foreign_id}?profile=worker_alpha"
    ).json()["edition"], "denied")
    assert prompts[-1] == "Next"

    own = client.post("/api/feed/editions", json=payload)
    assert own.status_code == 202
    assert own.json()["edition"]["feedback_applied_count"] == 1
    own_id = own.json()["edition"]["id"]
    _eventually(lambda: feed.get_edition(own_id), "completed")
    assert "Space details" in prompts[-1]
    assert "Garden details" not in prompts[-1]

    invalid = client.post("/api/feed/editions", json={
        "prompt": "Next", "liked_story_ids": [f"{first['id']}:01"],
    })
    assert invalid.status_code == 400
    assert len(prompts) == 2


def test_existing_feed_database_migrates_without_losing_editions(tmp_path, monkeypatch):
    import sqlite3

    path = tmp_path / "feed" / "editions.sqlite3"
    path.parent.mkdir()
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE editions (
            id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, finished_at TEXT, content TEXT,
            error TEXT, owner TEXT NOT NULL, attempt INTEGER NOT NULL,
            execution TEXT NOT NULL, source_urls TEXT NOT NULL DEFAULT '[]',
            heartbeat_at REAL NOT NULL
        )""")
        db.execute(
            "INSERT INTO editions VALUES (?, ?, 'completed', ?, ?, ?, NULL, ?, 1, ?, '[]', ?)",
            ("old", "Older prompt", feed._now(), feed._now(), "Older output", "old-owner", "cron.run_job", time.time()),
        )
    monkeypatch.setattr(feed, "_db_path", lambda: path)
    assert feed.get_edition("old")["content"] == "Older output"
    assert feed.get_edition("old")["feedback_applied_count"] == 0
    assert feed.get_edition("old")["retrieved_source_urls"] == []
    assert feed.get_edition("old")["source_events"] == []
    newer = feed.request_edition(
        "New prompt", liked_edition_ids=["old"], runner=lambda *_: ("New output", None),
    )
    assert newer["feedback_applied_count"] == 1
    assert _eventually(lambda: feed.get_edition(newer["id"]), "completed")["content"] == "New output"
