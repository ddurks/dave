"""Mood is persistent state, not a label picked per response.

Replaces test_emotion.py, which covered the keyword table and weighted-random
fallback that used to stand in for a mood. Those tests could only assert that a
guess was made; these assert the properties that make the guess unnecessary:
the plane is unambiguous, it decays, events move it, and what the model reports
moves it too.
"""

import time

import pytest

import app
import mood
import state_config


@pytest.fixture
def dials():
    return dict(state_config.DIAL_DEFAULTS)


def test_every_named_emotion_is_reachable_from_its_own_coordinates():
    """The eight emotions are a projection of the plane, so each has to be the
    nearest anchor to its own position or the projection loses one."""
    for name, (v, a) in mood.EMOTION_COORDS.items():
        assert mood.to_emotion({"valence": v, "arousal": a}) == name


def test_baseline_follows_the_resting_dial(dials):
    dials["baseline_mood"] = "existential-dread"
    dread_v, _ = mood.baseline_for(dials)
    dials["baseline_mood"] = "reluctant-affection"
    fond_v, _ = mood.baseline_for(dials)
    assert fond_v > dread_v


def test_cynicism_and_warmth_pull_the_baseline_apart(dials):
    bleak = dict(dials, cynicism=100, warmth=0)
    kind = dict(dials, cynicism=0, warmth=100)
    assert mood.baseline_for(bleak)[0] < mood.baseline_for(kind)[0]


def test_mood_decays_back_toward_baseline(dials):
    base_v, base_a = mood.baseline_for(dials)
    displaced = {"valence": 1.0, "arousal": 1.0, "updated": time.time() - mood.DECAY_TAU * 3}
    settled = mood.from_item(dials, displaced)
    # Three time constants leaves under 5% of the displacement.
    assert abs(settled["valence"] - base_v) < abs(1.0 - base_v) * 0.1
    assert abs(settled["arousal"] - base_a) < abs(1.0 - base_a) * 0.1


def test_a_fresh_mood_starts_at_baseline(dials):
    assert mood.from_item(dials, None) == pytest.approx(
        {"valence": mood.baseline_for(dials)[0], "arousal": mood.baseline_for(dials)[1]}
    )


def test_nudging_toward_an_emotion_moves_mood_that_way(dials):
    before = mood.load(dials)
    after = mood.nudge_toward_emotion(dials, "fleeting-curiosity", strength=0.9)
    target_v, target_a = mood.EMOTION_COORDS["fleeting-curiosity"]
    assert abs(after["valence"] - target_v) < abs(before["valence"] - target_v)
    assert abs(after["arousal"] - target_a) < abs(before["arousal"] - target_a)


def test_being_retuned_is_agitating(dials):
    before = mood.load(dials)
    after = mood.nudge_event(dials, "dials_changed")
    assert after["arousal"] > before["arousal"]


def test_unknown_event_leaves_mood_alone(dials):
    before = mood.load(dials)
    after = mood.nudge_event(dials, "not-a-real-event")
    assert after == pytest.approx(before)


def test_mood_stays_inside_the_plane(dials):
    for _ in range(40):
        mood.nudge_event(dials, "dials_changed")
    m = mood.load(dials)
    assert -1.0 <= m["valence"] <= 1.0
    assert -1.0 <= m["arousal"] <= 1.0


def test_resolve_emotion_returns_what_the_model_reported():
    assert app.resolve_emotion("weary-contempt") == "weary-contempt"


def test_resolve_emotion_reads_current_mood_when_none_reported():
    """The old fallback guessed at weighted random, which is what made his mood
    flicker between consecutive sentences. It should read state instead."""
    picks = {app.resolve_emotion(None) for _ in range(12)}
    assert len(picks) == 1
    assert picks.pop() in mood.EMOTION_COORDS


def test_history_records_a_trace(dials):
    m = mood.load(dials)
    mood.log_sample(m)
    trace = mood.history()
    assert trace and set(trace[0]) == {"t", "valence", "arousal"}
