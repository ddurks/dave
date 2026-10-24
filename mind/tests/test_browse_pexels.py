"""Tests for _fetch_pexels_video, handle_browse/watch_tv, and Flask /query route."""

from unittest.mock import MagicMock

import pytest

import app


# ── Pexels response builder ───────────────────────────────────────────────────

def _pexels_response(videos=None):
    """Build a minimal realistic Pexels API mock response."""
    if videos is None:
        videos = [
            {
                "url": "https://www.pexels.com/video/ocean-waves-12345/",
                "duration": 30,
                "user": {"name": "Test User"},
                "video_files": [
                    {
                        "file_type": "video/mp4",
                        "height": 720,
                        "link": "https://example.com/video.mp4",
                    }
                ],
            }
        ]
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"videos": videos}
    mock_resp.raise_for_status = MagicMock()
    return mock_resp


# ── _fetch_random_pexels_video ────────────────────────────────────────────────

def test_pexels_returns_none_when_no_api_key(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", None)
    result = app._fetch_pexels_video()
    assert result is None


def test_pexels_uses_popular_endpoint(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")
    monkeypatch.setattr(app.random, "random", lambda: 0.3)  # < 0.5 → popular

    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        return _pexels_response()

    monkeypatch.setattr(app.http_requests, "get", fake_get)
    app._fetch_pexels_video()  # no search_query → falls into 50/50 branch

    assert captured["url"] == "https://api.pexels.com/videos/popular"


def test_pexels_uses_search_endpoint(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")
    monkeypatch.setattr(app.random, "random", lambda: 0.7)  # >= 0.5 → search

    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["params"] = kwargs.get("params", {})
        return _pexels_response()

    monkeypatch.setattr(app.http_requests, "get", fake_get)
    app._fetch_pexels_video()

    assert captured["url"] == "https://api.pexels.com/videos/search"
    assert captured["params"].get("query") in app._PEXELS_SEARCH_QUERIES


def test_pexels_uses_explicit_search_query(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")

    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["params"] = kwargs.get("params", {})
        return _pexels_response()

    monkeypatch.setattr(app.http_requests, "get", fake_get)
    app._fetch_pexels_video(search_query="rainy night")

    assert captured["url"] == "https://api.pexels.com/videos/search"
    assert captured["params"].get("query") == "rainy night"


def test_pexels_returns_correct_shape(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")
    monkeypatch.setattr(app.random, "random", lambda: 0.3)
    monkeypatch.setattr(app.http_requests, "get", lambda *a, **kw: _pexels_response())

    result = app._fetch_pexels_video()

    assert result is not None
    assert "videoUrl" in result
    assert "title" in result
    assert "description" in result
    assert result["videoUrl"] == "https://example.com/video.mp4"
    assert result["title"] == "ocean waves"
    assert "Test User" in result["description"]


def test_pexels_returns_none_when_no_videos(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")
    monkeypatch.setattr(app.random, "random", lambda: 0.3)

    mock_resp = MagicMock()
    mock_resp.json.return_value = {"videos": []}
    mock_resp.raise_for_status = MagicMock()
    monkeypatch.setattr(app.http_requests, "get", lambda *a, **kw: mock_resp)

    result = app._fetch_pexels_video()
    assert result is None


def test_pexels_returns_none_when_no_valid_link(monkeypatch):
    monkeypatch.setattr(app, "PEXELS_API_KEY", "fake-key")
    monkeypatch.setattr(app.random, "random", lambda: 0.3)

    videos = [
        {
            "url": "https://www.pexels.com/video/waves-99/",
            "duration": 20,
            "user": {"name": "Someone"},
            "video_files": [
                {"file_type": "video/mp4", "height": 720, "link": ""}
            ],
        }
    ]
    monkeypatch.setattr(app.http_requests, "get", lambda *a, **kw: _pexels_response(videos))

    result = app._fetch_pexels_video()
    assert result is None


# ── handle_browse ─────────────────────────────────────────────────────────────

def _wiki_response(title="Test Article", extract="Some interesting facts."):
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "type": "standard",
        "title": title,
        "extract": extract,
        "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Test_Article"}},
    }
    return mock_resp


def test_watch_tv_calls_pexels_and_returns_video(stub_groq, monkeypatch):
    """When Archive and Wikimedia come up empty, handle_watch_tv falls back to Pexels."""
    # Stub _generate_search_query so the test doesn't need a real Groq call shape.
    monkeypatch.setattr(app, "_generate_search_query", lambda *a, **kw: "ocean waves")
    # Pexels is the last resort; stub the earlier sources so no network is hit.
    monkeypatch.setattr(app, "_fetch_archive_video", lambda: None)
    monkeypatch.setattr(app, "_fetch_wikimedia_video", lambda q: None)

    pexels_called = []

    def fake_pexels(search_query=None):
        pexels_called.append(search_query)
        return {
            "videoUrl": "https://example.com/vid.mp4",
            "title": "ocean waves",
            "description": "A 30-second video by Test User on Pexels.",
        }

    monkeypatch.setattr(app, "_fetch_pexels_video", fake_pexels)
    stub_groq.set_tool_response({"text": "Watching the waves.", "emotion": "melancholy"})

    result, status = app.handle_watch_tv({})
    assert status == 200
    assert pexels_called, "_fetch_pexels_video should have been called"
    assert result.get("videoUrl") == "https://example.com/vid.mp4"


def test_browse_falls_through_to_wikipedia_when_pexels_returns_none(stub_groq, monkeypatch):
    monkeypatch.setattr(app, "_fetch_pexels_video", lambda **kw: None)
    monkeypatch.setattr(app.http_requests, "get", lambda *a, **kw: _wiki_response())
    stub_groq.set_tool_response(
        {"text": "Fascinating.", "emotion": "fleeting-curiosity"}
    )

    result, status = app.handle_browse({})
    assert status == 200
    assert "pageTitle" in result
    assert result["pageTitle"].startswith("wikipedia:")


# ── Flask /query integration ──────────────────────────────────────────────────

def test_query_route_respond_returns_200(stub_groq, client):
    stub_groq.set_tool_response({"text": "Hello.", "emotion": "boredom"})
    resp = client.post(
        "/query",
        json={"type": "respond", "sessionId": "s", "userInput": "hi"},
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert "response" in data
    assert "text" in data["response"]


def test_query_route_no_type_returns_400(client):
    resp = client.post("/query", json={"userInput": "hi"})
    assert resp.status_code == 400
    data = resp.get_json()
    assert "error" in data
