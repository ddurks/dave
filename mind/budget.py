"""The monthly spend ceiling.

A hard cap rather than an alert: `allows()` is checked before every call and
`record()` meters every response, both through an atomic counter in state.py so
concurrent requests cannot race past the limit.

Lanes exist so that background chatter cannot eat the month and leave nobody
able to hold a conversation. The lane is inferred from the model: the good model
is only ever used for the thing a human is waiting on.

Running out is not an error path. Callers turn it into Dave saying he has had
all the thoughts he can afford, which is in character and is what a visitor sees
instead of a broken page.
"""

import logging
import time

import state
import state_config as config

logger = logging.getLogger(__name__)

_respond_model = "claude-opus-5"


def configure(respond_model: str) -> None:
    """Told by app.py which model counts as the conversation lane."""
    global _respond_model
    _respond_model = respond_model


def lane_for(model: str) -> str:
    return "respond" if model == _respond_model else "background"


def cost_micros(model: str, usage) -> int:
    """Micro-dollars for one response. Integral so the counter stays atomic."""
    price = config.PRICING.get(model)
    if not price or usage is None:
        return 0
    fresh_in = getattr(usage, "input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    dollars = (
        fresh_in * price["in"]
        + cache_write * price["in"] * config.CACHE_WRITE_MULT
        + cache_read * price["in"] * config.CACHE_READ_MULT
        + out * price["out"]
    ) / 1_000_000
    return int(round(dollars * 1_000_000))


def lane_status(lane: str):
    """Whether a lane may spend right now, and why not if it may not."""
    total_cap = config.MONTHLY_BUDGET_USD * 1_000_000
    if total_cap <= 0:
        return False, "budget is zero"
    spent = state.budget_spent_micros()
    if spent >= total_cap:
        return False, "monthly budget spent"
    if lane == "background" and spent >= total_cap * config.BACKGROUND_CUTOFF:
        return False, "background paused so conversation survives the month"
    if state.budget_lane_micros(lane) >= total_cap * config.BUDGET_SPLIT.get(lane, 1.0):
        return False, "this lane has spent its share"
    return True, ""


def lane_allows(lane: str) -> bool:
    return lane_status(lane)[0]


def allows(model: str):
    return lane_status(lane_for(model))


def record(model: str, usage) -> int:
    micros = cost_micros(model, usage)
    if micros:
        state.record_spend(lane_for(model), micros)
    return micros


def report() -> dict:
    return state.budget_report()


def month() -> str:
    return time.strftime("%Y-%m", time.gmtime())
