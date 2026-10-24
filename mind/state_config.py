"""Configuration for the persistent-state layer.

Kept separate from app.py so state.py, mood.py, memory.py and budget.py can be
imported by the test suite without dragging in the whole Flask app and its
prompt files.

The dial schema is the single source of truth: /mind renders its read-only
gauges from it, and sanitize_dials clamps anything arriving over the wire
against it. Tuning has no UI by design -- POST /api/dials is the manual route.
"""

import os

# ── Storage ──────────────────────────────────────────────────────────────────
TABLE_NAME = os.environ.get("DAVE_TABLE", "dave-mind")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
# Used when DynamoDB is unconfigured or unreachable, so local dev and the tests
# need no AWS account.
LOCAL_STATE_PATH = os.environ.get(
    "DAVE_LOCAL_STATE", os.path.join(os.path.dirname(__file__), ".dave-state.json")
)

PRESENCE_TIMEOUT_SECONDS = 90  # no heartbeat for this long => nobody is watching
EPISODIC_KEEP = 300            # memories retained before the oldest are forgotten

# ── Spend ceiling ────────────────────────────────────────────────────────────
# A hard cap, not an alert: every call checks the ledger before spending.
MONTHLY_BUDGET_USD = float(os.environ.get("DAVE_MONTHLY_BUDGET_USD", "5.00"))

# Fractions of the monthly budget each lane may consume.
BUDGET_SPLIT = {"respond": 0.60, "background": 0.35, "distill": 0.05}

# Past this fraction of the total, background life stops so that conversation --
# the thing a visitor actually notices -- survives to month end.
BACKGROUND_CUTOFF = 0.80

# USD per million tokens. Cache writes bill at 1.25x input, reads at 0.10x.
PRICING = {
    "claude-opus-5": {"in": 5.00, "out": 25.00},
    "claude-sonnet-5": {"in": 3.00, "out": 15.00},
    "claude-haiku-4-5": {"in": 1.00, "out": 5.00},
}
CACHE_WRITE_MULT = 1.25
CACHE_READ_MULT = 0.10

# ── Curated dials ────────────────────────────────────────────────────────────
# Bounded controls only. Nothing here accepts free text, so no visitor-supplied
# string can reach a prompt through the dial route.
DIALS = [
    {
        "id": "cynicism", "label": "Cynicism", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 70,
        "help": "How bleak his read on things is.",
    },
    {
        "id": "warmth", "label": "Warmth", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 25,
        "help": "Whether he lets any of it show.",
    },
    {
        "id": "absurdity", "label": "Absurdity", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 60,
        "help": "Appetite for the cosmically ridiculous.",
    },
    {
        "id": "energy", "label": "Energy", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 30,
        "help": "Baseline agitation. Also sets how fast he talks.",
    },
    {
        "id": "verbosity", "label": "Verbosity", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 20,
        "help": "1 sentence at zero, 4 at full. He is not built for 4.",
    },
    {
        "id": "chattiness", "label": "Chattiness", "type": "range",
        "min": 0, "max": 100, "step": 5, "default": 50,
        "help": "How often he thinks out loud. Lower is cheaper.",
    },
    {
        "id": "baseline_mood", "label": "Resting mood", "type": "select",
        "default": "melancholy",
        "options": [
            "melancholy", "boredom", "resignation", "existential-dread",
            "weary-contempt", "dry-amusement", "fleeting-curiosity",
            "reluctant-affection",
        ],
        "help": "Where his mood drifts back to when left alone.",
    },
]

DIAL_DEFAULTS = {d["id"]: d["default"] for d in DIALS}


def sanitize_dials(raw):
    """Coerce arbitrary input into the declared schema. Unknown keys drop."""
    clean = dict(DIAL_DEFAULTS)
    if not isinstance(raw, dict):
        return clean
    for d in DIALS:
        if d["id"] not in raw:
            continue
        v = raw[d["id"]]
        if d["type"] == "range":
            try:
                clean[d["id"]] = max(d["min"], min(d["max"], int(v)))
            except (TypeError, ValueError):
                pass
        elif d["type"] == "select":
            if v in d["options"]:
                clean[d["id"]] = v
        elif d["type"] == "multi":
            if isinstance(v, list):
                picked = [x for x in v if x in d["options"]]
                clean[d["id"]] = picked or d["default"]
    return clean
