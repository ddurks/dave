"""Who he's talking to, and what everyone has had him do today.

A visitor is the anonymous id the page keeps in localStorage, so Dave can
recognise someone who comes back. The day's tallies are what he gossips
about: counts only, never anyone's words, so nothing one visitor typed
reaches another through this.
"""

import time

import state

NOTES_KEEP = 4  # exchanges remembered per visitor

# What a chat had him do, from respond's moveTo/action, as one tally key.
DID = {
    "couch": "couch", "tv": "couch",
    "chair": "computer", "computer": "computer",
    "keg": "beer", "kegerator": "beer", "beer": "beer",
    "bed": "bed",
    "dance": "dance", "wander": "wander",
}
DID_PHRASE = {
    "dance": "dance", "couch": "go watch TV", "computer": "go on the computer",
    "beer": "have a beer", "bed": "lie down", "wander": "walk around",
}


def _today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def did_from(response):
    if response.get("lookUp"):
        return "computer"
    return DID.get(response.get("action") or "") or DID.get(response.get("moveTo") or "")


def note_chat(user_id, session_id, said, replied, did=None):
    """Record one exchange with this visitor, and tally today's gossip."""
    if not user_id:
        return
    store = state.get_store()
    now, today = int(time.time()), _today()
    v = store.get_item("VISITOR", user_id) or {"firstSeen": now, "visits": 0, "chats": 0, "asked": {}}
    if v.get("day") != today:
        store.add_counter("GOSSIP", today, "visitors", 1)
        v["day"], v["askedToday"] = today, {}
    if v.get("lastSession") != session_id:
        v["visits"] = v.get("visits", 0) + 1
        v["lastSession"] = session_id
    v["chats"] = v.get("chats", 0) + 1
    v["lastSeen"] = now
    v["notes"] = (v.get("notes") or [])[-(NOTES_KEEP - 1):] + [
        "They said: %s / You said: %s" % (said[:160], replied[:160])
    ]
    if did:
        v["asked"][did] = v["asked"].get(did, 0) + 1
        v["askedToday"][did] = v["askedToday"].get(did, 0) + 1
        store.add_counter("GOSSIP", today, did, 1)
        # The day's record for one visitor, kept apart from the counters so a
        # put here can't overwrite a concurrent add on them.
        top = store.get_item("GOSSIPTOP", today) or {}
        if v["askedToday"][did] > top.get(did, 0):
            store.put_item("GOSSIPTOP", today, {**top, did: v["askedToday"][did]})
    store.put_item("VISITOR", user_id, v)


def _asked_phrase(counts):
    return ", ".join("%s %d time%s" % (DID_PHRASE[k], n, "" if n == 1 else "s")
                     for k, n in sorted(counts.items(), key=lambda kv: -kv[1]) if k in DID_PHRASE)


def visitor_context(user_id):
    """What he knows of this visitor, for the prompt. Empty without an id."""
    if not user_id:
        return ""
    v = state.get_store().get_item("VISITOR", user_id)
    if not v:
        return "## This visitor\nYou have never spoken with this visitor before."
    days = int((time.time() - v.get("firstSeen", time.time())) / 86400)
    first = "today" if days == 0 else "yesterday" if days == 1 else "%d days ago" % days
    lines = ["## This visitor",
             "You've met them before: first %s, %d visit%s, %d thing%s said to you." % (
                 first, v.get("visits", 1), "" if v.get("visits", 1) == 1 else "s",
                 v.get("chats", 0), "" if v.get("chats", 0) == 1 else "s")]
    if v.get("asked"):
        lines.append("They've had you " + _asked_phrase(v["asked"]) + ".")
    if v.get("notes"):
        lines += ["Your last exchanges with them:"] + ["- " + n for n in v["notes"]]
    lines.append("Recognise them if it fits; don't recite this.")
    return "\n".join(lines)


def gossip_context():
    """Today's tallies across every visitor, for the prompt."""
    today = _today()
    row = state.get_store().get_item("GOSSIP", today) or {}
    counts = {k: int(row[k]) for k in DID_PHRASE if row.get(k)}
    visitors = int(row.get("visitors", 0))
    if not counts and visitors < 2:
        return ""
    lines = ["## Today, across everyone",
             "%d visitor%s have talked to you today." % (visitors, "" if visitors == 1 else "s")]
    if counts:
        lines.append("Between them they've had you " + _asked_phrase(counts) + ".")
    top = state.get_store().get_item("GOSSIPTOP", today) or {}
    best = max(((k, int(n)) for k, n in top.items() if k in DID_PHRASE), key=lambda kv: kv[1], default=None)
    if best and best[1] >= 3:
        lines.append("One visitor alone had you %s %d times." % (DID_PHRASE[best[0]], best[1]))
    lines.append("You can gossip about this now and then, about 'someone' or 'people'. "
                 "Never repeat what another visitor said, and never describe anyone.")
    return "\n".join(lines)
