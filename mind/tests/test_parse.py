"""Tests for parse_json_response() and validate_response()."""

import app
import mood


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
    raw = '{"text": "hi", "emotion": "boredom", "gesture": "shrug"}'
    result = app.validate_response(raw)
    assert result["text"] == "hi"
    assert result["emotion"] == "boredom"
    assert result["gesture"] == "shrug"
    assert result["posture"] is None
    assert result["gaze"] is None
    assert "subEmotion" not in result


def test_validate_missing_emotion_reads_current_mood():
    # The keyword table is gone: a missing emotion now reads his actual mood
    # rather than being guessed from the words in the text.
    raw = '{"text": "this is ridiculous"}'
    result = app.validate_response(raw)
    assert result["text"] == "this is ridiculous"
    assert result["emotion"] in mood.EMOTION_COORDS


def test_validate_broken_text_returns_fallback_dict():
    """Unparseable text still yields a usable response object; the emotion comes
    from his current mood rather than from scanning the text for keywords."""
    result = app.validate_response("not json at all, just prose")
    assert result["text"]
    assert result["emotion"] in mood.EMOTION_COORDS
    assert set(result) >= {"text", "emotion", "gesture", "posture", "gaze"}
