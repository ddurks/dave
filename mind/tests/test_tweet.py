"""Tests for the daily X post (no real Claude or X calls)."""

import app


def _posted(monkeypatch):
    sent = []

    def fake_post(text):
        sent.append(text)
        return "123"

    monkeypatch.setattr(app, "_post_tweet", fake_post)
    return sent


def test_posts_once_per_day(stub_llm, monkeypatch):
    sent = _posted(monkeypatch)
    stub_llm.set_json({"text": "The kegerator hummed a new note today.", "emotion": "boredom"})

    first = app.tweet_handler({}, None)
    second = app.tweet_handler({}, None)

    assert first == {"id": "123", "text": "The kegerator hummed a new note today."}
    assert second == {"skipped": "already posted today"}
    assert sent == ["The kegerator hummed a new note today."]
    assert app.memory.recent(kind="tweet")[0]["text"] == sent[0]


def test_dry_run_writes_without_posting(stub_llm, monkeypatch):
    sent = _posted(monkeypatch)
    stub_llm.set_json({"text": "Nothing happened.", "emotion": "resignation"})

    assert app.tweet_handler({"dryRun": True}, None) == {"dryRun": True, "text": "Nothing happened."}
    assert sent == []


def test_prompt_carries_the_last_day(stub_llm, monkeypatch):
    _posted(monkeypatch)
    app.memory.remember("reading", "Read about lighthouse keepers.")
    stub_llm.set_json({"text": "x", "emotion": "boredom"})

    app.tweet_handler({}, None)

    user = next(m for m in stub_llm.calls[0]["messages"] if m["role"] == "user")
    assert "lighthouse keepers" in str(user["content"])


def test_budget_fallback_is_not_posted(monkeypatch):
    sent = _posted(monkeypatch)
    monkeypatch.setattr(app, "call_with_schema", lambda *a: {
        "text": "Throttled.", "emotion": "resignation", "_rate_limited": True})

    assert app.tweet_handler({}, None) == {"skipped": "nothing written"}
    assert sent == []


def test_overlong_text_is_trimmed(stub_llm, monkeypatch):
    sent = _posted(monkeypatch)
    stub_llm.set_json({"text": "a" * 400, "emotion": "boredom"})

    app.tweet_handler({}, None)

    assert len(sent[0]) == app.TWEET_MAX_CHARS


def test_prompt_carries_recent_posts(stub_llm, monkeypatch):
    _posted(monkeypatch)
    app.state.get_store().put_item("TWEET", "2026-01-01", {"id": "1", "text": "Yesterday's post.", "ts": 0})
    stub_llm.set_json({"text": "x", "emotion": "boredom"})

    app.tweet_handler({}, None)

    user = next(m for m in stub_llm.calls[0]["messages"] if m["role"] == "user")
    assert "Yesterday's post." in str(user["content"])
