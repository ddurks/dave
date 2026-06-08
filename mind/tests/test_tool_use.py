"""Tests for the call_with_tool() helper and tool-use plumbing."""

import tools
import app


class _FakeBadRequest(Exception):
    """Mimics Groq's BadRequestError shape (has a `body` attribute)."""

    def __init__(self, body):
        super().__init__(str(body))
        self.body = body


def test_call_with_tool_uses_structured_args(stub_groq):
    """When the stubbed client returns a tool call, call_with_tool returns the parsed dict."""
    stub_groq.set_tool_response({"text": "x", "emotion": "boredom"})

    result = tools.call_with_tool(
        stub_groq.client,
        "test-model",
        [{"role": "user", "content": "hi"}],
        tools.respond_tool,
    )

    assert result == {"text": "x", "emotion": "boredom"}


def test_call_with_tool_falls_back_when_no_tool_call(stub_groq):
    """When the stubbed client returns plain text with a JSON blob, the fallback parses it."""
    stub_groq.set_response('preamble\n{"text": "y", "emotion": "melancholy"}')

    result = tools.call_with_tool(
        stub_groq.client,
        "test-model",
        [{"role": "user", "content": "hi"}],
        tools.respond_tool,
    )

    assert result == {"text": "y", "emotion": "melancholy"}


def test_salvage_strips_function_wrapper_and_parses_json():
    """A <function=name>{...}</function> failed-gen should be parsed back to a dict."""
    exc = _FakeBadRequest({
        "error": {
            "code": "tool_use_failed",
            "failed_generation": (
                '<function=idle> {"action": "sit", "emotion": "boredom", '
                '"durationSec": 30, "text": null} </function>'
            ),
        }
    })

    result = tools._salvage_failed_generation(exc)
    assert result["action"] == "sit"
    assert result["emotion"] == "boredom"
    assert result["durationSec"] == 30


def test_salvage_drops_emotion_outside_enum():
    """A failed-gen with an emotion outside EMOTION_ENUM should have it dropped."""
    exc = _FakeBadRequest({
        "error": {
            "failed_generation": '<function=idle>{"action":"sit","emotion":"neutral","durationSec":30}</function>'
        }
    })

    result = tools._salvage_failed_generation(exc)
    assert "emotion" not in result
    assert result["action"] == "sit"


def test_salvage_returns_raw_text_for_prose():
    """When the failed-gen is prose (no JSON), the salvage returns _raw_text for the safety net."""
    exc = _FakeBadRequest({
        "error": {
            "failed_generation": '<function=respond>"Not much, mortal." </function>',
        }
    })

    result = tools._salvage_failed_generation(exc)
    assert "_raw_text" in result
    assert "Not much" in result["_raw_text"]


def test_call_with_tool_salvages_bad_request(stub_groq, monkeypatch):
    """When the stubbed client raises a BadRequestError-shaped exception, call_with_tool salvages it."""
    exc = _FakeBadRequest({
        "error": {
            "failed_generation": '<function=respond>{"text":"hello","emotion":"melancholy"}</function>'
        }
    })

    def raise_bad(*args, **kwargs):
        raise exc

    monkeypatch.setattr(stub_groq.client.chat.completions, "create", raise_bad)

    result = tools.call_with_tool(
        stub_groq.client,
        "test-model",
        [{"role": "user", "content": "hi"}],
        tools.respond_tool,
    )
    assert result == {"text": "hello", "emotion": "melancholy"}
