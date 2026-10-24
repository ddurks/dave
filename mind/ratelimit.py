"""Per-visitor request limits, keyed on client IP.

One layer of several against someone scripting /query to burn the API budget:
the monthly budget (budget.py) caps total spend, Lambda reserved concurrency
caps how fast it can burn, and this caps how much of either one visitor gets.

The IP comes from API Gateway's requestContext.identity.sourceIp, which the
client cannot set (unlike X-Forwarded-For). Fixed windows in DynamoDB; a
store error refuses the request rather than waving it through.
"""

import logging
import os

import state

logger = logging.getLogger(__name__)

# A normal open tab makes ~3-5 background calls a minute (browse every 25-40s,
# plus idle and muse), and a person types a few lines a minute at most.
LIMITS = {
    "all": [(60, int(os.environ.get("DAVE_RATE_PER_MIN", "20"))),
            (3600, int(os.environ.get("DAVE_RATE_PER_HOUR", "300")))],
    # The conversation lane runs the expensive model, so it gets its own cap.
    "chat": [(60, int(os.environ.get("DAVE_CHAT_PER_MIN", "6"))),
             (3600, int(os.environ.get("DAVE_CHAT_PER_HOUR", "60")))],
}
CHAT_TYPES = {"respond", "analyze_media"}


def check(ip: str, req_type: str):
    """Return None if the request may proceed, else a short reason."""
    if not ip:
        return "no client address"
    lanes = ["all"] + (["chat"] if req_type in CHAT_TYPES else [])
    try:
        for lane in lanes:
            for window_s, limit in LIMITS[lane]:
                if state.hit(f"{lane}#{ip}", window_s) > limit:
                    logger.warning("rate limited %s on %s/%ss", ip, lane, window_s)
                    return "rate limited"
    except Exception as e:
        logger.error("rate limit store unavailable: %s", e)
        return "rate limiter unavailable"
    return None
