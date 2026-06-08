"""Tests for the turn logger module."""

from unittest.mock import MagicMock

import app
import turnlog


def test_noop_logger_default(monkeypatch):
    """With no TURN_LOG_BUCKET set, build_turn_logger() returns NoOp."""
    monkeypatch.delenv("TURN_LOG_BUCKET", raising=False)
    tl = turnlog.build_turn_logger()
    assert isinstance(tl, turnlog.NoOpTurnLogger)
    # Should swallow any call without raising.
    tl.log("respond", {"sessionId": "s"}, {"response": {}}, 200)


def test_dispatch_calls_turn_logger(stub_groq, monkeypatch):
    """dispatch() invokes turn_logger.log() exactly once per call."""
    stub_groq.set_tool_response({"text": "hi", "emotion": "boredom"})
    mock_log = MagicMock()
    monkeypatch.setattr(app.turn_logger, "log", mock_log)

    body = {"type": "respond", "sessionId": "s1", "userInput": "hello"}
    result, status = app.dispatch(body)

    assert status == 200
    assert mock_log.call_count == 1
    args, _ = mock_log.call_args
    assert args[0] == "respond"
    assert args[1] is body
    assert args[2] is result
    assert args[3] == status


def test_record_truncation(monkeypatch):
    """Strings >4000 chars in request/response are truncated with a marker."""
    # Build an S3TurnLogger without hitting boto3 by patching __init__.
    def _init(self, *a, **kw):
        self._bucket = "test-bucket"
        self._key_prefix = "turns/"
        self._model = "test-model"
        self._s3 = MagicMock()

    monkeypatch.setattr(turnlog.S3TurnLogger, "__init__", _init)
    tl = turnlog.S3TurnLogger()

    captured = {}

    def _capture(key, body):
        captured["key"] = key
        captured["body"] = body

    monkeypatch.setattr(tl, "_put_object", _capture)

    big = "x" * 5000
    body = {"sessionId": "s1", "userInput": big}
    result = {"response": {"text": big}}
    tl.log("respond", body, result, 200)

    payload = captured["body"].decode("utf-8")
    assert turnlog.TRUNCATION_MARKER in payload
    # The 5000-char field should be cut down to MAX + marker.
    assert big not in payload
    # Key uses the expected day-partitioned shape.
    assert captured["key"].startswith("turns/")
    assert captured["key"].endswith("-s1-respond.json")
