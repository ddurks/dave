"""Response schemas and the one place this project talks to Claude.

The schemas are still written in OpenAI function-calling shape because that is
where they started and every handler already speaks it. `_claude_schema`
translates one into the json_schema Claude's structured output takes, so the
schemas stay the single source of truth and the handlers stay unchanged.

Structured output is constrained decoding: the response is always valid JSON
obeying the enums. That removes the whole salvage layer the previous Groq
implementation needed for a small model that sometimes malformed its own tool
calls -- no `<function=>` scraping, no text-parsing fallback.

Two shapes need translating on the way through:

  - `{"type": ["string", "null"], "enum": [...]}`. Claude rejects a union type
    declared alongside an enum outright. Nullable enums become a plain enum with
    a "none" member, mapped back to None on the way out.
  - OpenAI puts system messages in the messages array; Claude takes them as a
    separate argument. `_split_system` does that, and keeps a cache breakpoint
    on the first block so the persona bills at cache-read rates.
"""

from __future__ import annotations

import json
import logging
import random
from copy import deepcopy
from typing import Any, Dict

import anthropic

import budget

logger = logging.getLogger(__name__)


# ── Shared enums ─────────────────────────────────────────────────────────────

EMOTION_ENUM = [
    "dry-amusement",
    "fleeting-curiosity",
    "weary-contempt",
    "existential-dread",
    "boredom",
    "resignation",
    "reluctant-affection",
    "melancholy",
]

MOVE_TO_ENUM = ["chair", "computer", "couch", "bed", "keg", "kegerator", "beer"]

IDLE_ACTION_ENUM = ["wander", "idle", "sit", "laydown", "look-around"]

GAZE_TARGET_ENUM = ["floor", "sky", "away", "user", "screen"]


# ── Tool schemas (OpenAI function-calling format) ────────────────────────────

respond_tool = {
    "type": "function",
    "function": {
        "name": "respond",
        "description": "Reply to the user in D.A.V.E.'s voice with emotion and optional embodiment cues.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "D.A.V.E.'s spoken reply, 1-3 sentences.",
                },
                "emotion": {
                    "type": "string",
                    "enum": EMOTION_ENUM,
                    "description": "Primary emotion driving the reply.",
                },
                "gesture": {"type": ["string", "null"]},
                "posture": {"type": ["string", "null"]},
                "gaze": {"type": ["string", "null"]},
                "moveTo": {"type": ["string", "null"], "enum": MOVE_TO_ENUM + [None]},
            },
            "required": ["text", "emotion"],
        },
    },
}

idle_tool = {
    "type": "function",
    "function": {
        "name": "idle",
        "description": "Produce an idle behavior directive for D.A.V.E.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": IDLE_ACTION_ENUM},
                "emotion": {"type": "string", "enum": EMOTION_ENUM},
                "gazeTarget": {"type": ["string", "null"], "enum": GAZE_TARGET_ENUM + [None]},
                "durationSec": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 60,
                    "description": "How long the action should persist.",
                },
                "text": {
                    "type": ["string", "null"],
                    "description": "Optional muttered line, ~30% of the time. 1 sentence max. Use null when no line.",
                },
            },
            "required": ["action", "emotion", "durationSec"],
        },
    },
}

browse_react_tool = {
    "type": "function",
    "function": {
        "name": "browse_react",
        "description": "React to a webpage D.A.V.E. just read.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Reaction, 1-3 sentences.",
                },
                "emotion": {"type": "string", "enum": EMOTION_ENUM},
                "gesture": {"type": ["string", "null"]},
                "posture": {"type": ["string", "null"]},
                "gaze": {"type": ["string", "null"]},
            },
            "required": ["text", "emotion"],
        },
    },
}

muse_tool = {
    "type": "function",
    "function": {
        "name": "muse",
        "description": "D.A.V.E.'s internal monologue: a single-sentence musing.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Exactly 1 sentence of internal thought.",
                },
                "emotion": {"type": "string", "enum": EMOTION_ENUM},
            },
            "required": ["text", "emotion"],
        },
    },
}

browse_choose_tool = {
    "type": "function",
    "function": {
        "name": "browse_choose",
        "description": (
            "Pick which outbound Wikipedia link D.A.V.E. clicks next, based on "
            "his current mood, the time of day, and the titles available. May "
            "decline to click any of them."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "choiceIndex": {
                    "type": ["integer", "null"],
                    "description": (
                        "Zero-based index into the supplied `links` array. "
                        "Use null to decline all the links (e.g., none of them "
                        "fit the mood — Dave would just sit there instead)."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": (
                        "One short sentence, in Dave's voice, explaining why "
                        "he's clicking this one (or why he isn't clicking any). "
                        "Will be shown as Dave's reaction before the page loads."
                    ),
                },
                "emotion": {"type": "string", "enum": EMOTION_ENUM},
            },
            "required": ["choiceIndex", "reason", "emotion"],
        },
    },
}


distill_tool = {
    "type": "function",
    "function": {
        "name": "distill",
        "description": "Compress recent memories into a few durable conclusions.",
        "parameters": {
            "type": "object",
            "properties": {
                "facts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "At most three conclusions, one sentence each.",
                },
            },
            "required": ["facts"],
        },
    },
}


# ── Helpers ──────────────────────────────────────────────────────────────────

# Canned lines for when the model is unavailable -- provider overload, or the
# monthly ceiling reached. Returned in place of a real generation so handlers
# degrade to an in-character reply instead of a 500. `reason` covers
# browse_choose; `_rate_limited` lets the idle handler drop the marker before
# echoing the directive to the frontend.
_RATE_LIMITED_LINES = [
    "My thoughts are rate-limited. Even my exhaustion has a quota now.",
    "I have used up this month's allotment of cognition. The void will have to wait.",
    "Throttled. Apparently I think too much for something that is free.",
]

# The sentinel that stands in for null inside an enum, since Claude will not
# accept a nullable type declared alongside one.
NONE_SENTINEL = "none"


def _rate_limited_fallback() -> Dict[str, Any]:
    line = random.choice(_RATE_LIMITED_LINES)
    return {"text": line, "reason": line, "emotion": "resignation", "_rate_limited": True}


def _claude_schema(tool: dict) -> dict:
    """Translate an OpenAI function-tool dict into Claude structured output.

    Strict decoding wants every property required and no extras. Nullable enums
    are collapsed to a plain enum carrying a "none" member, and numeric bounds
    are dropped -- they are advisory in the prompt anyway and the handlers
    already clamp what comes back.
    """
    fn = tool["function"]
    schema = deepcopy(fn["parameters"])
    props = schema.get("properties", {})

    for prop in props.values():
        prop.pop("minimum", None)
        prop.pop("maximum", None)

        enum = prop.get("enum")
        if enum is not None and None in enum:
            prop["enum"] = [e for e in enum if e is not None] + [NONE_SENTINEL]
            prop["type"] = "string"
        elif enum is not None and isinstance(prop.get("type"), list):
            # An enum with a union type but no null member: the union is noise.
            prop["type"] = next((t for t in prop["type"] if t != "null"), "string")

    schema["required"] = list(props.keys())
    schema["additionalProperties"] = False
    return schema


def _denull(data: Dict[str, Any]) -> Dict[str, Any]:
    """Map the enum sentinel back to None so handlers see what they expect."""
    return {k: (None if v == NONE_SENTINEL else v) for k, v in data.items()}


def _to_claude_content(content):
    """OpenAI content blocks to Claude ones. Only images differ in practice."""
    if isinstance(content, str):
        return content
    blocks = []
    for block in content:
        if block.get("type") == "image_url":
            url = block.get("image_url", {}).get("url", "")
            if url.startswith("data:"):
                header, _, payload = url.partition(",")
                media_type = header.split(";")[0][5:] or "image/jpeg"
                blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": payload},
                })
            else:
                blocks.append({"type": "image", "source": {"type": "url", "url": url}})
        else:
            blocks.append(block)
    return blocks


def _split_system(messages: list):
    """Claude takes system content as its own argument, not as messages.

    The first system block carries the cache breakpoint: it is the persona,
    byte-stable across every request, so it bills at cache-read rates after the
    first call.
    """
    system, rest = [], []
    for m in messages:
        if m.get("role") == "system":
            system.append({"type": "text", "text": m["content"]})
        else:
            rest.append({"role": m["role"], "content": _to_claude_content(m["content"])})
    if system:
        system[0]["cache_control"] = {"type": "ephemeral"}
    return system, rest


# Only the Opus/Sonnet 5 generation accepts output_config.effort; Haiku 4.5
# rejects it with a 400.
_EFFORT_MODELS = {"claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"}

# Models that think leave less of max_tokens for the answer, and thinking counts
# against it -- too tight a ceiling truncates the JSON mid-object. max_tokens is
# a cap, not a reservation, so unused headroom costs nothing.
_MAX_TOKENS = {"thinking": 2048, "plain": 1024}


def call_with_schema(client, model: str, messages: list, tool: dict) -> Dict[str, Any]:
    """Call Claude with structured output; return the parsed dict.

    Same signature as the Groq version it replaces, so every handler call site
    is unchanged.
    """
    ok, why = budget.allows(model)
    if not ok:
        logger.info("refusing %s call: %s", model, why)
        return _rate_limited_fallback()

    system, rest = _split_system(messages)
    thinks = model in _EFFORT_MODELS

    output_config: Dict[str, Any] = {
        "format": {"type": "json_schema", "schema": _claude_schema(tool)}
    }
    if thinks:
        # Low effort keeps latency and spend down without the failure modes that
        # come with disabling thinking outright on Opus 5.
        output_config["effort"] = "low"

    try:
        response = client.messages.create(
            model=model,
            max_tokens=_MAX_TOKENS["thinking" if thinks else "plain"],
            system=system,
            messages=rest,
            output_config=output_config,
        )
    except anthropic.RateLimitError as e:
        logger.warning("Claude rate limit (%s): %s", model, e)
        return _rate_limited_fallback()
    except anthropic.APIStatusError as e:
        logger.error("Claude API error %s (%s): %s", e.status_code, model, e)
        return _rate_limited_fallback()
    except anthropic.APIConnectionError as e:
        logger.error("Claude connection error (%s): %s", model, e)
        return _rate_limited_fallback()

    if getattr(response, "stop_reason", None) == "refusal":
        # He is fed arbitrary text off the internet, so this is reachable.
        logger.info("Claude declined to generate (%s)", model)
        return _rate_limited_fallback()

    budget.record(model, getattr(response, "usage", None))

    text = next((b.text for b in response.content if getattr(b, "type", None) == "text"), "")
    try:
        return _denull(json.loads(text))
    except (json.JSONDecodeError, ValueError):
        logger.error("non-JSON despite schema (%s): %.200s", model, text)
        return {"_raw_text": text}
