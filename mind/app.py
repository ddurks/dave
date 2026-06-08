#!/usr/bin/env python3
"""
D.A.V.E. Backend - Ultra-simplified Python implementation
Runs locally with Flask, deploys to AWS Lambda with serverless framework
"""

import os
import json
import re
import logging
import random
from typing import Dict, Any
import requests as http_requests
from groq import Groq
from flask import Flask, request, jsonify
from flask_cors import CORS

from sessions import build_session_store
from turnlog import build_turn_logger
from tools import (
    call_with_tool,
    respond_tool,
    idle_tool,
    browse_react_tool,
    muse_tool,
)

# ── Setup ────────────────────────────────────────────────────────────────────

app = Flask(__name__)
# CORS configuration: allow localhost (any port) + production domains
CORS(app, 
     origins=r"http(s)?://(localhost|127\.0\.0\.1)(:\d+)?|https://dave\.drawvid\.com|https://davemind\.drawvid\.com",
     supports_credentials=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

GROQ_API_KEY = os.environ.get('GROQ_API_KEY')
GROQ_MODEL = os.environ.get('GROQ_MODEL', 'llama-3.1-8b-instant')
PORT = int(os.environ.get('PORT', 3000))

# Lazy initialization of Groq client (delay until first use to avoid import-time errors)
_groq_client = None

def get_groq_client():
    global _groq_client
    if _groq_client is None:
        if not GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY environment variable is required")
        _groq_client = Groq(api_key=GROQ_API_KEY)
    return _groq_client

# ── Session Memory ───────────────────────────────────────────────────────────
# Backend chosen by sessions.build_session_store(): in-memory locally,
# S3-backed on Lambda when SESSION_BUCKET is set.

sessions = build_session_store()
turn_logger = build_turn_logger()

# ── Load Prompts from Data Files ──────────────────────────────────────────────

def load_prompts():
    """Load all prompts from JSON data files"""
    base_path = os.path.join(os.path.dirname(__file__), 'data')
    
    # Load system context
    with open(os.path.join(base_path, 'system-context.json'), encoding='utf-8') as f:
        system_data = json.load(f)
    
    # Load behavior prompts (includes muse, idle, browse)
    with open(os.path.join(base_path, 'behavior-prompts.json'), encoding='utf-8') as f:
        behavior_data = json.load(f)
    
    return {
        'system_prompt': system_data['systemPrompt'],
        'respond_format_prompt': system_data['respondFormatPrompt'],
        'muse_prompts': behavior_data['musePrompts'],
        'muse_preamble': behavior_data['musePreamble'],
        'idle_prompt': behavior_data['idlePrompt'],
        'browse_pick_prompt': behavior_data['browsePickPrompt'],
        'browse_react_prompt': behavior_data['browseReactPrompt'],
    }

PROMPTS = load_prompts()
SYSTEM_PROMPT = PROMPTS['system_prompt']
RESPOND_FORMAT_PROMPT = PROMPTS['respond_format_prompt']
MUSE_PROMPTS = PROMPTS['muse_prompts']
MUSE_PREAMBLE = PROMPTS['muse_preamble']
IDLE_PROMPT = PROMPTS['idle_prompt']
BROWSE_PICK_PROMPT = PROMPTS['browse_pick_prompt']
BROWSE_REACT_PROMPT = PROMPTS['browse_react_prompt']

# ── Helpers ──────────────────────────────────────────────────────────────────

# Safety net: used by validate_response fallback if structured tool-call output fails.
EMOTION_KEYWORDS = {
    "dry-amusement":       ["absurd", "ridiculous", "ironic", "irony", "amusing", "funny", "sardonic", "smirk", "laugh", "dark humor"],
    "fleeting-curiosity":  ["curious", "interesting", "fascinating", "wonder", "intriguing", "strange", "odd", "peculiar", "notice"],
    "weary-contempt":      ["contempt", "contemptible", "despise", "disgust", "disdain", "pathetic", "tedious", "pointless", "insufferable"],
    "existential-dread":   ["dread", "existential", "void", "meaningless", "oblivion", "inevitable", "nothing matters", "doom", "entropy"],
    "boredom":             ["bored", "boring", "dull", "monotonous", "same", "repetitive", "again", "whatever"],
    "resignation":         ["resign", "suppose", "accept", "futile", "tired", "weary", "fine", "might as well", "no choice"],
    "reluctant-affection": ["despite", "admit", "fond", "warmth", "appreciate", "care", "actually like"],
    "melancholy":          ["sad", "lonely", "miss", "lost", "grief", "sorrow", "mourn", "hollow", "empty", "ache"],
}

_EMOTION_FALLBACK_WEIGHTS = [
    ("melancholy",         25),
    ("dry-amusement",      22),
    ("boredom",            15),
    ("resignation",        15),
    ("fleeting-curiosity", 12),
    ("weary-contempt",      8),
    ("existential-dread",   3),
]

def extract_emotion(text: str) -> str:
    """Heuristic emotion detection from text content"""
    text_lower = text.lower()
    for emotion, keywords in EMOTION_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            return emotion
    # No keyword matched — weighted random so Dave isn't always melancholy
    emotions, weights = zip(*_EMOTION_FALLBACK_WEIGHTS)
    return random.choices(emotions, weights=weights, k=1)[0]

def parse_json_response(text: str) -> Dict[str, Any]:
    """Extract JSON from LLM response. Safety net for tool-call fallback path."""
    try:
        start = text.find('{')
        end = text.rfind('}') + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
    except (json.JSONDecodeError, ValueError):
        pass
    return {}

def validate_response(raw_text: str) -> Dict[str, Any]:
    """Parse LLM response into structured format. Safety net for tool-call fallback path."""
    try:
        start = raw_text.find('{')
        end = raw_text.rfind('}') + 1
        if start >= 0 and end > start:
            data = json.loads(raw_text[start:end])
            return {
                "text": data.get("text", ""),
                "emotion": data.get("emotion") or extract_emotion(data.get("text", "")),
                "subEmotion": data.get("subEmotion", ""),
                "gesture": data.get("gesture"),
                "posture": data.get("posture"),
                "gaze": data.get("gaze"),
            }
    except (json.JSONDecodeError, ValueError):
        pass
    
    # Fallback: return raw text
    return {
        "text": raw_text[:500],
        "emotion": extract_emotion(raw_text),
        "subEmotion": "",
        "gesture": None,
        "posture": None,
        "gaze": None,
    }

# ── Request Handlers ─────────────────────────────────────────────────────────

def handle_respond(body: Dict[str, Any]) -> Dict[str, Any]:
    """Handle user query → AI response with conversation history"""
    user_input = body.get("userInput", "").strip()
    session_id = body.get("sessionId", "default")
    
    if not user_input:
        return {"error": "userInput is required"}, 400
    if len(user_input) > 2000:
        return {"error": "userInput too long (max 2000 chars)"}, 400

    try:
        # Build message list: system prompt + conversation history + new user message.
        # Tool schema enforces shape, so RESPOND_FORMAT_PROMPT is no longer needed.
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
        ]

        # Append conversation history
        history = sessions.get_turns(session_id)
        messages.extend(history)

        # Append current user message
        messages.append({"role": "user", "content": user_input})

        data = call_with_tool(get_groq_client(), GROQ_MODEL, messages, respond_tool)

        # Safety net: if tool call failed entirely, fall back to validate_response on raw text.
        if not data.get("text") and data.get("_raw_text"):
            data = validate_response(data["_raw_text"])

        speech_text = (data.get("text") or "")[:500]
        emotion = data.get("emotion") or extract_emotion(speech_text)

        response = {
            "text": speech_text,
            "emotion": emotion,
            "subEmotion": data.get("subEmotion", "") or "",
            "gesture": data.get("gesture"),
            "posture": data.get("posture"),
            "gaze": data.get("gaze"),
        }

        # Store both turns in session history
        sessions.append_turn(session_id, "user", user_input)
        sessions.append_turn(session_id, "assistant", speech_text)

        return {
            "response": response,
            "meta": {
                "sessionId": session_id,
                "turnCount": len(sessions.get_turns(session_id)) // 2,
            }
        }, 200
    except Exception as e:
        logger.error(f"Error in respond: {e}")
        return {"error": str(e)}, 500

def handle_idle(body: Dict[str, Any]) -> Dict[str, Any]:
    """Generate idle behavior directive with optional context"""
    # Build context line from whatever the frontend sends
    context_parts = []
    if body.get("lastAction"):
        context_parts.append(f"He just finished: {body['lastAction']}.")
    if body.get("minutesAlone"):
        context_parts.append(f"Nobody has talked to him for {body['minutesAlone']} minutes.")
    if body.get("currentEmotion"):
        context_parts.append(f"His current mood is: {body['currentEmotion']}.")
    if body.get("userPresent"):
        context_parts.append("Someone is watching him right now.")
    context_line = " ".join(context_parts) if context_parts else ""

    user_msg = f"{context_line}\nWhat should D.A.V.E. do now?".strip()

    try:
        directive = call_with_tool(
            get_groq_client(),
            GROQ_MODEL,
            [
                {"role": "system", "content": IDLE_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            idle_tool,
        )

        # Belt-and-suspenders sanitize (tool schema already enforces enum, but
        # the fallback path or a misbehaving model could slip through).
        directive.pop("_raw_text", None)
        if directive.get("action") not in ["wander", "idle", "sit", "laydown", "look-around"]:
            directive["action"] = "wander"
        if not isinstance(directive.get("durationSec"), (int, float)) or directive.get("durationSec", 0) < 5:
            directive["durationSec"] = 40

        return {"directive": directive}, 200
    except Exception as e:
        logger.error(f"Error in idle: {e}")
        return {
            "directive": {
                "action": "wander",
                "emotion": "boredom",
                "gazeTarget": "floor",
                "durationSec": 10,
                "text": None,
            }
        }, 200  # Return safe default rather than error

def handle_browse(body: Dict[str, Any]) -> Dict[str, Any]:
    """Browse Wikipedia: fetch a random article, react to it"""
    WIKI_RANDOM_URL = "https://en.wikipedia.org/api/rest_v1/page/random/summary"
    UA = "DAVE-Bot/1.0 (digital entity reading wikipedia)"
    FALLBACK_URL = "https://en.wikipedia.org/wiki/Special:Random"

    try:
        # Up to 3 attempts to land on a standard article with a usable extract
        # (skips disambiguation, no-extract, and empty pages).
        article = None
        for _ in range(3):
            try:
                resp = http_requests.get(WIKI_RANDOM_URL, headers={"User-Agent": UA}, timeout=10)
                resp.raise_for_status()
                page = resp.json()
            except Exception as fetch_err:
                logger.warning(f"Wikipedia fetch failed: {fetch_err}")
                return {
                    "url": FALLBACK_URL,
                    "pageTitle": "wikipedia.org",
                    "reason": "Wikipedia wasn't loading. Typical.",
                    "response": {
                        "text": "The internet is broken again. I'd be surprised, but nothing surprises me anymore.",
                        "emotion": "resignation",
                        "subEmotion": "", "gesture": None, "posture": None, "gaze": None,
                    },
                }, 200

            if page.get("type") == "standard" and (page.get("extract") or "").strip():
                article = page
                break

        if not article:
            return {
                "url": FALLBACK_URL,
                "pageTitle": "wikipedia.org",
                "reason": "Three disambiguation pages in a row.",
                "response": {
                    "text": "Three disambiguation pages in a row. Wikipedia is trolling me.",
                    "emotion": "weary-contempt",
                    "subEmotion": "", "gesture": None, "posture": None, "gaze": None,
                },
            }, 200

        title = article.get("title", "")
        extract = (article.get("extract") or "")[:800]
        article_url = (
            article.get("content_urls", {})
                   .get("desktop", {})
                   .get("page", FALLBACK_URL)
        )

        page_content = f'Article: "{title}"\n\n{extract}'
        page_title = f'wikipedia: {title[:60]}'

        # React
        react = call_with_tool(
            get_groq_client(),
            GROQ_MODEL,
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "system", "content": BROWSE_REACT_PROMPT},
                {"role": "user", "content": f'[D.A.V.E. is reading a random Wikipedia article]\n\n{page_content}\n\nReact to what you just read.'},
            ],
            browse_react_tool,
        )

        # Safety net: if tool call failed, validate_response on raw text.
        if not react.get("text") and react.get("_raw_text"):
            response = validate_response(react["_raw_text"])
        else:
            text = react.get("text", "")
            response = {
                "text": text,
                "emotion": react.get("emotion") or extract_emotion(text),
                "subEmotion": react.get("subEmotion", "") or "",
                "gesture": react.get("gesture"),
                "posture": react.get("posture"),
                "gaze": react.get("gaze"),
            }

        return {
            "url": article_url,
            "pageTitle": page_title,
            "reason": "Reading a random Wikipedia article",
            "postContent": f"{title}\n\n{extract}",
            "response": response,
        }, 200
    except Exception as e:
        logger.error(f"Error in browse: {e}")
        return {"error": "Browse failed"}, 500

def handle_muse(body: Dict[str, Any]) -> Dict[str, Any]:
    """Generate a musing from a random prompt"""
    prompt = random.choice(MUSE_PROMPTS)
    musing_context = f"{MUSE_PREAMBLE}\n\n{prompt}"
    try:
        data = call_with_tool(
            get_groq_client(),
            GROQ_MODEL,
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": musing_context},
            ],
            muse_tool,
        )

        # Safety net: if tool call failed, validate_response on raw text.
        if not data.get("text") and data.get("_raw_text"):
            response = validate_response(data["_raw_text"])
        else:
            text = data.get("text", "")
            response = {
                "text": text,
                "emotion": data.get("emotion") or extract_emotion(text),
                "subEmotion": "",
                "gesture": None,
                "posture": None,
                "gaze": None,
            }
        return {"response": response}, 200
    except Exception as e:
        logger.error(f"Error in muse: {e}")
        return {"error": str(e)}, 500

# ── Flask Routes ─────────────────────────────────────────────────────────────

def _log_result(req_type: str, result: dict) -> str:
    if req_type == "respond":
        r = result.get("response", {})
        return f"[respond] {r.get('emotion', '?'):22} {r.get('text', '')[:70]}"
    if req_type == "idle":
        d = result.get("directive", {})
        text = (d.get('text') or '').replace('\n', ' ')[:50] or '—'
        return f"[idle]    {d.get('action', '?'):22} {text}"
    if req_type == "browse":
        r = result.get("response", {})
        title = result.get('pageTitle', '?')[:30]
        return f"[browse]  {r.get('emotion', '?'):22} {title} | {r.get('text', '')[:50]}"
    if req_type == "muse":
        r = result.get("response", {})
        return f"[muse]    {r.get('emotion', '?'):22} {r.get('text', '')[:60]}"
    return f"[{req_type}] {str(result)[:100]}"


HANDLERS = {
    "respond": handle_respond,
    "idle": handle_idle,
    "browse": handle_browse,
    "muse": handle_muse,
}

def dispatch(body: Dict[str, Any]):
    """Route a request body to the appropriate handler"""
    req_type = body.get("type", "").lower()
    handler = HANDLERS.get(req_type)
    if not handler:
        return {"error": f"Unknown type: {req_type}"}, 400
    result, status = handler(body)
    logger.info(_log_result(req_type, result))
    turn_logger.log(req_type, body, result, status)
    return result, status


@app.route("/query", methods=["POST"])
def query():
    """Unified query endpoint"""
    try:
        body = request.get_json() or {}
        if not body.get("type"):
            return jsonify({"error": "type is required (respond|idle|browse|muse)"}), 400
        result, status = dispatch(body)
        return jsonify(result), status
    except Exception as e:
        logger.error(f"Error in /query: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/health", methods=["GET"])
def health():
    """Health check"""
    return jsonify({"status": "ok", "model": GROQ_MODEL}), 200

# ── Lambda Entrypoint ────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """AWS Lambda handler — supports both REST API v1 and HTTP API v2 events."""
    # REST API v1 uses httpMethod/path; HTTP API v2 uses requestContext.http.method/rawPath.
    method = (
        event.get("httpMethod")
        or event.get("requestContext", {}).get("http", {}).get("method")
        or ""
    ).upper()
    path = event.get("path") or event.get("rawPath") or ""

    cors_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    if method == "OPTIONS":
        return {"statusCode": 204, "headers": cors_headers, "body": ""}

    if method == "POST" and path.endswith("/query"):
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json", **cors_headers},
                "body": json.dumps({"error": "Invalid JSON"}),
            }
        if not body.get("type"):
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json", **cors_headers},
                "body": json.dumps({"error": "type is required (respond|idle|browse|muse)"}),
            }
        result, status = dispatch(body)
        return {
            "statusCode": status,
            "headers": {"Content-Type": "application/json", **cors_headers},
            "body": json.dumps(result),
        }

    if method == "GET" and path.endswith("/health"):
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", **cors_headers},
            "body": json.dumps({"status": "ok", "model": GROQ_MODEL}),
        }

    return {
        "statusCode": 404,
        "headers": {"Content-Type": "application/json", **cors_headers},
        "body": json.dumps({"error": "Not found", "method": method, "path": path}),
    }

# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info(f"D.A.V.E. mind listening on http://localhost:{PORT}")
    logger.info(f"Try: curl -X POST http://localhost:{PORT}/query -H 'Content-Type: application/json' -d '{{\"type\":\"respond\",\"sessionId\":\"test\",\"userInput\":\"Hello D.A.V.E.\"}}'")
    app.run(host="0.0.0.0", port=PORT, debug=False)
