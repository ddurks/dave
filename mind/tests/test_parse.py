"""Tests for parse_json_response() and validate_response()."""

import app


# ── parse_json_response ──────────────────────────────────────────────────────


def test_parse_clean_json():
    result = app.parse_json_response('{"emotion": "boredom"}')
    assert result == {"emotion": "boredom"}


def test_parse_prose_then_json():
    raw = 'Some preamble text.\n{"emotion": "melancholy", "text": "hi"}'
    result = app.parse_json_response(raw)
    assert result == {"emotion": "melancholy", "text": "hi"}


def test_parse_malformed_returns_empty():
    result = app.parse_json_response("{not valid json at all")
    assert result == {}


def test_parse_empty_returns_empty():
    assert app.parse_json_response("") == {}


# ── validate_response ────────────────────────────────────────────────────────


def test_validate_standard_payload():
    raw = '{"text": "hi", "emotion": "boredom", "subEmotion": "sub", "gesture": "shrug"}'
    result = app.validate_response(raw)
    assert result["text"] == "hi"
    assert result["emotion"] == "boredom"
    assert result["subEmotion"] == "sub"
    assert result["gesture"] == "shrug"
    assert result["posture"] is None
    assert result["gaze"] is None


def test_validate_missing_emotion_falls_back_to_extract():
    # "ridiculous" → dry-amusement via EMOTION_KEYWORDS.
    raw = '{"text": "this is ridiculous"}'
    result = app.validate_response(raw)
    assert result["text"] == "this is ridiculous"
    assert result["emotion"] == "dry-amusement"


def test_validate_broken_text_returns_fallback_dict():
    raw = "completely unparseable nonsense with no json"
    result = app.validate_response(raw)
    valid_emotions = (
        set(app.EMOTION_KEYWORDS.keys())
        | {e for e, _ in app._EMOTION_FALLBACK_WEIGHTS}
    )
    assert result["emotion"] in valid_emotions
    assert result["text"] == raw[:500]
    assert result["subEmotion"] == ""
    assert result["gesture"] is None
