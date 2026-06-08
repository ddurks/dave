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


def test_two_sessions_isolated(stub_groq):
    stub_groq.set_tool_response({"text": "reply", "emotion": "boredom"})

    # session A gets one turn
    app.dispatch({"type": "respond", "sessionId": "A", "userInput": "first"})
    # session B gets two turns
    app.dispatch({"type": "respond", "sessionId": "B", "userInput": "one"})
    result_b, _ = app.dispatch(
        {"type": "respond", "sessionId": "B", "userInput": "two"}
    )

    # Session A: 1 user + 1 assistant = 2 messages → turnCount=1
    a_turns = app.sessions.get_turns("A")
    assert len(a_turns) == 2
    # Session B: 2 user + 2 assistant = 4 messages → turnCount=2
    b_turns = app.sessions.get_turns("B")
    assert len(b_turns) == 4
    assert result_b["meta"]["sessionId"] == "B"
    assert result_b["meta"]["turnCount"] == 2


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
