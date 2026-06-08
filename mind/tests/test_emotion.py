"""Tests for extract_emotion()."""

import random

import pytest

import app


@pytest.mark.parametrize("emotion,keywords", list(app.EMOTION_KEYWORDS.items()))
def test_each_emotion_has_a_working_keyword(emotion, keywords):
    """At least one keyword for each emotion must map to that emotion.

    (Some keywords may collide with earlier-iterated emotions; that's OK —
    we only require that the emotion is reachable via *some* keyword.)
    """
    hits = [kw for kw in keywords if app.extract_emotion(kw) == emotion]
    assert hits, f"No keyword in {keywords} resolved to {emotion!r}"


def test_no_keyword_match_returns_fallback_emotion():
    """Text with no keyword falls back to one of the weighted-fallback emotions."""
    valid = {e for e, _ in app._EMOTION_FALLBACK_WEIGHTS}
    # Seed RNG for reproducibility across runs.
    random.seed(0)
    for _ in range(50):
        result = app.extract_emotion("xyzzy qwertyuiop nothing matches here")
        assert result in valid


def test_keyword_match_is_case_insensitive():
    assert app.extract_emotion("This is RIDICULOUS") == "dry-amusement"
    assert app.extract_emotion("So Bored Already") == "boredom"
