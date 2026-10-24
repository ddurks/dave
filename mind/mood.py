"""Persistent mood.

Mood is server-side state on two continuous axes, valence and arousal. It
decays exponentially toward a baseline set by the dials and is nudged by
events. The eight named emotions the face rig understands are a projection of
that plane, not the state itself -- which is what stops the mood flickering
the way keyword-matching plus a random fallback did.
"""

import math
import time

import state as store

# Where each named emotion sits on the (valence, arousal) plane.
EMOTION_COORDS = {
    "melancholy": (-0.6, -0.4),
    "boredom": (-0.2, -0.8),
    "resignation": (-0.4, -0.2),
    "existential-dread": (-0.8, 0.6),
    "weary-contempt": (-0.5, 0.3),
    "dry-amusement": (0.4, 0.1),
    "fleeting-curiosity": (0.3, 0.5),
    "reluctant-affection": (0.7, -0.1),
}

# Seconds for a displaced mood to fall to 1/e of its distance from baseline.
DECAY_TAU = 1200.0

# Nudges for things that happen without an LLM call to read an emotion from.
EVENTS = {
    "visitor_arrived": (0.15, 0.25),
    "left_alone": (-0.10, -0.15),
    "dials_changed": (0.0, 0.35),
    "out_of_thoughts": (-0.15, -0.25),
    "interrupted": (-0.05, 0.2),
}


def _clamp(v):
    return max(-1.0, min(1.0, v))


def baseline_for(dials):
    """Resting point. The chosen resting emotion sets the anchor; cynicism,
    warmth and energy pull it around."""
    bv, ba = EMOTION_COORDS.get(dials.get("baseline_mood"), EMOTION_COORDS["melancholy"])
    cyn = dials.get("cynicism", 70) / 100.0
    warm = dials.get("warmth", 25) / 100.0
    energy = dials.get("energy", 30) / 100.0
    valence = bv - (cyn - 0.5) * 0.5 + (warm - 0.5) * 0.5
    arousal = ba + (energy - 0.5) * 0.6
    return _clamp(valence), _clamp(arousal)


def from_item(dials, item):
    """Decay a stored mood item toward the baseline the dials imply.

    Split out from load() so a caller holding a STATE snapshot does not go back
    to the store for something it already has."""
    base_v, base_a = baseline_for(dials)
    item = item or {}
    v = item.get("valence", base_v)
    a = item.get("arousal", base_a)
    dt = max(0.0, time.time() - item.get("updated", time.time()))
    k = math.exp(-dt / DECAY_TAU)
    return {
        "valence": _clamp(base_v + (v - base_v) * k),
        "arousal": _clamp(base_a + (a - base_a) * k),
    }


def load(dials):
    """Read stored mood and apply decay lazily, so no background ticker is
    needed for the mood to keep moving while nothing is happening."""
    return from_item(dials, store.get_store().get_item("STATE", "MOOD"))


def save(state):
    store.get_store().put_item(
        "STATE",
        "MOOD",
        {
            "valence": round(state["valence"], 4),
            "arousal": round(state["arousal"], 4),
            "updated": int(time.time()),
        },
    )
    log_sample(state)


# -- History ----------------------------------------------------------------
# A rolling trace of where his mood has been, so /mind can draw a curve rather
# than a single point. One small item; samples are throttled because mood is
# written on every nudge.

HISTORY_MAX = 180
HISTORY_MIN_GAP = 45.0


def log_sample(state):
    now = time.time()
    item = store.get_store().get_item("STATE", "MOODLOG") or {}
    samples = item.get("samples", [])
    if samples and now - samples[-1][0] < HISTORY_MIN_GAP:
        return samples
    samples = samples[-(HISTORY_MAX - 1):] + [
        [int(now), round(state["valence"], 3), round(state["arousal"], 3)]
    ]
    store.get_store().put_item("STATE", "MOODLOG", {"samples": samples})
    return samples


def history():
    item = store.get_store().get_item("STATE", "MOODLOG") or {}
    return [
        {"t": int(s[0]), "valence": float(s[1]), "arousal": float(s[2])}
        for s in item.get("samples", [])
    ]


def nudge_toward_emotion(dials, emotion, strength=0.35):
    """Pull mood a fraction of the way toward a named emotion. Used with the
    emotion the model reports in its structured output, so reading Dave's mood
    costs nothing extra."""
    target = EMOTION_COORDS.get(emotion)
    state = load(dials)
    if target:
        state["valence"] = _clamp(state["valence"] + (target[0] - state["valence"]) * strength)
        state["arousal"] = _clamp(state["arousal"] + (target[1] - state["arousal"]) * strength)
        save(state)
    return state


def nudge_event(dials, event):
    dv, da = EVENTS.get(event, (0.0, 0.0))
    state = load(dials)
    state["valence"] = _clamp(state["valence"] + dv)
    state["arousal"] = _clamp(state["arousal"] + da)
    save(state)
    return state


def to_emotion(state):
    """Project the plane onto the nearest named emotion for the face rig."""
    v, a = state["valence"], state["arousal"]
    return min(
        EMOTION_COORDS,
        key=lambda e: (EMOTION_COORDS[e][0] - v) ** 2 + (EMOTION_COORDS[e][1] - a) ** 2,
    )


def describe(state):
    """One line of plain English for the prompt. The model is told the mood
    rather than asked to invent one."""
    v, a = state["valence"], state["arousal"]
    if v < -0.5:
        tone = "bleak"
    elif v < -0.15:
        tone = "flat"
    elif v < 0.25:
        tone = "level"
    else:
        tone = "unexpectedly warm"
    if a < -0.4:
        pitch = "barely engaged"
    elif a < 0.15:
        pitch = "still"
    elif a < 0.5:
        pitch = "alert"
    else:
        pitch = "wound tight"
    return "Your mood right now is %s and %s, reading closest to %s." % (
        tone,
        pitch,
        to_emotion(state).replace("-", " "),
    )


def public_state(state):
    """Shape the /controls page renders."""
    return {
        "valence": round(state["valence"], 3),
        "arousal": round(state["arousal"], 3),
        "emotion": to_emotion(state),
        "description": describe(state),
    }
