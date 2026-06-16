"""Tests for handle_idle and handle_muse (no real Groq calls)."""

from unittest.mock import MagicMock, patch

import pytest

import app


# ── handle_idle ───────────────────────────────────────────────────────────────

def test_idle_returns_valid_directive(stub_groq):
    stub_groq.set_tool_response(
        {"action": "wander", "emotion": "boredom", "durationSec": 30}
    )
    result, status = app.handle_idle({})
    assert status == 200
    assert "directive" in result
    d = result["directive"]
    assert d["action"] == "wander"
    assert d["emotion"] == "boredom"
    assert d["durationSec"] == 30


def test_idle_context_includes_time_of_day(stub_groq, monkeypatch):
    captured = {}

    def fake_call_with_tool(client, model, messages, tool):
        captured["messages"] = messages
        return {"action": "idle", "emotion": "boredom", "durationSec": 20}

    monkeypatch.setattr(app, "call_with_tool", fake_call_with_tool)

    app.handle_idle({"hourOfDay": 9})

    user_content = captured["messages"][1]["content"]
    assert "morning" in user_content
    assert "9:00" in user_content


def test_idle_context_time_of_day_various_hours(monkeypatch):
    """Spot-check a few other hour bands."""
    cases = [
        (2, "middle of the night"),
        (14, "afternoon"),
        (18, "evening"),
        (22, "late night"),
    ]
    for hour, expected_label in cases:
        captured = {}

        def fake_call_with_tool(client, model, messages, tool, _captured=captured):
            _captured["messages"] = messages
            return {"action": "wander", "emotion": "boredom", "durationSec": 15}

        monkeypatch.setattr(app, "call_with_tool", fake_call_with_tool)
        app.handle_idle({"hourOfDay": hour})
        assert expected_label in captured["messages"][1]["content"], (
            f"hour={hour} expected label '{expected_label}'"
        )


def test_idle_neglect_phase_1(monkeypatch):
    captured = {}

    def fake_call(client, model, messages, tool):
        captured["messages"] = messages
        return {"action": "idle", "emotion": "melancholy", "durationSec": 20}

    monkeypatch.setattr(app, "call_with_tool", fake_call)
    app.handle_idle({"neglectPhase": 1})
    assert "growing melancholy" in captured["messages"][1]["content"]


def test_idle_neglect_phase_2(monkeypatch):
    captured = {}

    def fake_call(client, model, messages, tool):
        captured["messages"] = messages
        return {"action": "laydown", "emotion": "melancholy", "durationSec": 40}

    monkeypatch.setattr(app, "call_with_tool", fake_call)
    app.handle_idle({"neglectPhase": 2})
    assert "deeply lethargic" in captured["messages"][1]["content"]


def test_idle_mood_arc_in_context(monkeypatch):
    captured = {}

    def fake_call(client, model, messages, tool):
        captured["messages"] = messages
        return {"action": "wander", "emotion": "boredom", "durationSec": 20}

    monkeypatch.setattr(app, "call_with_tool", fake_call)
    app.handle_idle({"moodArc": "boredom"})
    assert "boredom" in captured["messages"][1]["content"]
    assert "emotional arc" in captured["messages"][1]["content"]


def test_idle_invalid_action_falls_back_to_wander(stub_groq):
    stub_groq.set_tool_response(
        {"action": "INVALID_ACTION", "emotion": "boredom", "durationSec": 20}
    )
    result, status = app.handle_idle({})
    assert status == 200
    assert result["directive"]["action"] == "wander"


def test_idle_returns_safe_default_on_groq_error(monkeypatch):
    def fake_call(client, model, messages, tool):
        raise RuntimeError("Groq exploded")

    monkeypatch.setattr(app, "call_with_tool", fake_call)
    result, status = app.handle_idle({})
    # No exception propagated; returns a safe directive
    assert status == 200
    assert "directive" in result
    assert result["directive"]["action"] == "wander"


# ── handle_muse ───────────────────────────────────────────────────────────────

def test_muse_uses_random_prompt_when_no_context(stub_groq, monkeypatch):
    stub_groq.set_tool_response({"text": "Thinking...", "emotion": "boredom"})

    random_choice_called = []

    real_choice = app.random.choice  # save reference

    def tracking_choice(seq):
        random_choice_called.append(seq)
        return real_choice(seq)

    monkeypatch.setattr(app.random, "choice", tracking_choice)
    app.handle_muse({})

    assert any(seq is app.MUSE_PROMPTS for seq in random_choice_called), (
        "random.choice should have been called with MUSE_PROMPTS"
    )


def test_muse_uses_context_override(stub_groq, monkeypatch):
    stub_groq.set_tool_response({"text": "Override thought.", "emotion": "melancholy"})

    captured = {}

    original_call = app.call_with_tool

    def capturing_call(client, model, messages, tool):
        captured["messages"] = messages
        return original_call(client, model, messages, tool)

    monkeypatch.setattr(app, "call_with_tool", capturing_call)

    app.handle_muse({"context": "Think about the void."})

    user_content = captured["messages"][1]["content"]
    assert "Think about the void." in user_content
    # Ensure no MUSE_PROMPTS item leaked in
    for prompt in app.MUSE_PROMPTS:
        assert prompt not in user_content


def test_muse_returns_valid_response(stub_groq):
    stub_groq.set_tool_response({"text": "Existence is tedious.", "emotion": "resignation"})
    result, status = app.handle_muse({})
    assert status == 200
    assert "response" in result
    r = result["response"]
    assert "text" in r
    assert "emotion" in r
    assert r["text"] == "Existence is tedious."
    assert r["emotion"] == "resignation"
