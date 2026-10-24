"""Memory and preoccupations.

Two tiers. Episodic memory is the raw stream of things that happened to Dave:
conversations, musings, what he read. Semantic memory is the short list of
conclusions distilled out of that stream. Both are shared -- there is one Dave,
so everything he has ever noticed is public at /memories.

Preoccupations are the shared mind: topics he keeps circling back to, weighted
and decaying, injected into every prompt so his four modes stop behaving like
four unrelated random generators.
"""

import math
import time
import uuid

import state as store
import state_config as config

INTEREST_TAU = 6 * 3600.0  # a preoccupation halves in interest over a few hours


def new_key(prefix=""):
    """Zero-padded millisecond epoch keeps lexical order chronological."""
    return "%s%013d#%s" % (prefix, int(time.time() * 1000), uuid.uuid4().hex[:8])


# -- Episodic ---------------------------------------------------------------

def remember(kind, text, emotion=None, meta=None):
    """Record something that happened. Returns the stored item."""
    text = (text or "").strip()
    if not text:
        return None
    item = {
        "ts": int(time.time()),
        "kind": kind,
        "text": text[:600],
        "emotion": emotion or "",
        "meta": meta or {},
    }
    store.get_store().put_item("MEMORY", new_key(), item)
    store.get_store().add_counter("MEMORY", "STATS", "total", 1)
    _trim()
    return item


def _trim():
    """Forget the oldest once the stream outgrows its keep window."""
    rows = store.get_store().query("MEMORY", limit=config.EPISODIC_KEEP + 40, reverse=True)
    rows = [r for r in rows if r.get("sk") != "STATS"]
    for row in rows[config.EPISODIC_KEEP:]:
        store.get_store().delete_item("MEMORY", row["sk"])


def recent(limit=25, kind=None):
    rows = store.get_store().query("MEMORY", limit=limit + 30, reverse=True)
    rows = [r for r in rows if r.get("sk") != "STATS"]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    return rows[:limit]


def stats():
    row = store.get_store().get_item("MEMORY", "STATS") or {}
    total = int(row.get("total", 0))
    held = len([r for r in store.get_store().query("MEMORY", limit=config.EPISODIC_KEEP + 10)
                if r.get("sk") != "STATS"])
    return {"everRecorded": total, "stillHeld": held, "forgotten": max(0, total - held)}


def recall_for_prompt(limit=6):
    """A compact digest of recent life, cheap enough to send on every call."""
    rows = recent(limit=limit)
    if not rows:
        return ""
    lines = []
    for r in reversed(rows):
        ago = max(1, int((time.time() - r.get("ts", 0)) / 60))
        label = {"conversation": "someone said", "musing": "you thought",
                 "reading": "you read", "event": ""}.get(r.get("kind"), "")
        lines.append("- %dm ago, %s: %s" % (ago, label, r["text"][:160]))
    return "Recently:\n" + "\n".join(lines)


# -- Semantic ---------------------------------------------------------------

def add_semantic(text):
    text = (text or "").strip()
    if not text:
        return
    store.get_store().put_item("SEMANTIC", new_key(), {"ts": int(time.time()), "text": text[:300]})


def semantic_facts(limit=12):
    return store.get_store().query("SEMANTIC", limit=limit, reverse=True)


def facts_for_prompt(limit=6):
    rows = semantic_facts(limit=limit)
    if not rows:
        return ""
    return "Things you have concluded:\n" + "\n".join("- " + r["text"] for r in rows)


# -- Preoccupations ---------------------------------------------------------

def interests_from_item(item):
    """Decay-filtered preoccupations from an already-fetched STATE item."""
    topics = (item or {}).get("topics", {})
    now = time.time()
    live = {}
    for name, rec in topics.items():
        age = now - rec.get("at", now)
        w = rec.get("w", 0) * math.exp(-age / INTEREST_TAU)
        if w > 0.05:
            live[name] = {"w": w, "at": rec.get("at", now)}
    return live


def _load_interests_item():
    """The raw INTERESTS item, for callers that want to pass it to
    interests_line without a second read."""
    return store.get_store().get_item("STATE", "INTERESTS") or {}


def _load_interests():
    return interests_from_item(store.get_store().get_item("STATE", "INTERESTS"))


def rank_interests(item, n=5):
    """Ranked preoccupations from an already-fetched STATE item."""
    live = interests_from_item(item)
    ranked = sorted(live.items(), key=lambda kv: kv[1]["w"], reverse=True)[:n]
    return [{"topic": k, "weight": round(v["w"], 2)} for k, v in ranked]


def bump_interest(topic, amount=1.0):
    topic = (topic or "").strip().lower()[:40]
    if not topic:
        return
    live = _load_interests()
    rec = live.get(topic, {"w": 0.0})
    live[topic] = {"w": min(5.0, rec["w"] + amount), "at": time.time()}
    # Keep only what he could plausibly hold in mind at once.
    top = dict(sorted(live.items(), key=lambda kv: kv[1]["w"], reverse=True)[:12])
    store.get_store().put_item("STATE", "INTERESTS", {"topics": top})


def top_interests(n=5):
    return rank_interests(store.get_store().get_item("STATE", "INTERESTS"), n)


def interests_line(item, n=4):
    """The preoccupations line for a prompt, from an already-fetched STATE
    item so composing a prompt costs no extra read."""
    top = rank_interests(item, n)
    if not top:
        return ""
    return "Lately you keep circling back to: " + ", ".join(t["topic"] for t in top) + "."
