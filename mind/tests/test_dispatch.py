"""Tests for dispatch() and the respond handler (no real Groq calls)."""

import app


def test_unknown_type_returns_400():
    result, status = app.dispatch({"type": "bogus"})
    assert status == 400
    assert "error" in result


def test_respond_with_stubbed_groq(stub_groq):
    stub_groq.set_tool_response(
        {"text": "It is ridiculous.", "emotion": "dry-amusement"}
    )
    body = {"type": "respond", "sessionId": "s1", "userInput": "hi"}
    result, status = app.dispatch(body)
    assert status == 200
    assert "response" in result
    assert "text" in result["response"]
    assert "emotion" in result["response"]
    assert result["response"]["emotion"] == "dry-amusement"


def test_respond_forwards_client_history(stub_groq):
    stub_groq.set_tool_response({"text": "reply", "emotion": "boredom"})

    history = [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "reply"},
        {"role": "system", "content": "ignored: not user/assistant"},
        {"role": "user", "content": "   "},
    ]
    app.dispatch({"type": "respond", "userInput": "two", "history": history})

    messages = stub_groq.client.chat.completions.create.call_args.kwargs["messages"]
    # system prompt, then valid history turns in order, then the new input
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert [m["content"] for m in messages[1:]] == ["one", "reply", "two"]


def test_respond_rejects_oversized_input(stub_groq):
    body = {
        "type": "respond",
        "sessionId": "s",
        "userInput": "x" * 2001,
    }
    result, status = app.dispatch(body)
    assert status == 400
    assert "error" in result


def test_respond_rejects_empty_input(stub_groq):
    body = {"type": "respond", "sessionId": "s", "userInput": "   "}
    result, status = app.dispatch(body)
    assert status == 400
    assert "error" in result
