"""Tool/function-call schemas for Groq structured output.

The Groq Python SDK is OpenAI-compatible, so we use OpenAI's function-calling
shape. Each schema corresponds to one of the four request handlers in app.py
(respond, idle, browse-react, muse). The schema enforces the response shape
at the API layer, eliminating fragile regex/JSON scraping from plain text.

`call_with_tool` is a thin helper: it makes a tool-forced API call, parses the
JSON arguments, and falls back to text parsing if the model declines to use
the tool (rare, but possible with smaller models).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict


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
                "subEmotion": {"type": ["string", "null"]},
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
                "subEmotion": {"type": ["string", "null"]},
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


# ── Helper ───────────────────────────────────────────────────────────────────


def call_with_tool(client, model: str, messages: list, tool: dict) -> Dict[str, Any]:
    """Call Groq with a forced tool choice; return the parsed argument dict.

    Falls back to text parsing if the model produced plain text instead of a
    tool call (rare under tool_choice="required", but possible). If even the
    text fallback yields nothing, returns {} and lets the caller decide what
    to do (handlers have their own safety nets).

    Small Llama models occasionally emit invalid tool args (values outside an
    enum, prose wrapped in <function=name>...</function>, etc.). Groq 400s
    these but includes the model's output in `failed_generation`; we salvage
    it so a flaky tool-call doesn't propagate as a 500.
    """
    from app import parse_json_response  # local import to avoid circular

    fn_name = tool["function"]["name"]
    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": fn_name}},
        )
    except Exception as e:
        salvaged = _salvage_failed_generation(e)
        if salvaged is not None:
            return salvaged
        raise

    message = response.choices[0].message

    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls:
        try:
            return json.loads(tool_calls[0].function.arguments)
        except (json.JSONDecodeError, ValueError, AttributeError):
            pass

    # Fallback: model returned text instead of tool call.
    content = getattr(message, "content", None)
    if content:
        parsed = parse_json_response(content)
        if parsed:
            return parsed
        # Last resort: surface raw text so handlers' validate_response can use it.
        return {"_raw_text": content}

    return {}


# Captures the body inside a Llama-style <function=name>...</function> wrapper.
_FN_TAG_RE = re.compile(r"<function=\w+>\s*(.*?)\s*(?:</function>)?\s*$", re.DOTALL)


def _salvage_failed_generation(exc) -> Dict[str, Any] | None:
    """Best-effort recovery from Groq's tool_use_failed 400.

    Returns a dict the handler can consume (possibly with `_raw_text` for the
    safety-net path), or None if nothing usable could be extracted.
    """
    from app import parse_json_response  # local import to avoid circular

    failed_gen = _extract_failed_generation(exc)
    if not failed_gen:
        return None

    # Strip the <function=name>...</function> wrapper if present.
    m = _FN_TAG_RE.search(failed_gen)
    payload = (m.group(1) if m else failed_gen).strip()

    parsed = parse_json_response(payload)
    if parsed:
        # Sanitize known-bad values so the handler doesn't have to.
        if parsed.get("emotion") not in EMOTION_ENUM:
            parsed.pop("emotion", None)
        if parsed.get("text") in ("null", "None"):
            parsed["text"] = ""
        return parsed

    # Plain prose — let the handler's validate_response safety net handle it.
    return {"_raw_text": payload}


def _extract_failed_generation(exc) -> str:
    """Pull `failed_generation` out of a Groq BadRequestError across SDK versions."""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            gen = err.get("failed_generation")
            if gen:
                return gen

    # Fallback: scrape the exception's string form. The SDK formats the body
    # with single quotes (Python repr), so match both quote styles.
    s = str(exc)
    m = re.search(r"['\"]failed_generation['\"]\s*:\s*['\"](.*?)['\"](?=\s*[},])", s, re.DOTALL)
    if m:
        return m.group(1)
    return ""
