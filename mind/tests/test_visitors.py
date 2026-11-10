"""Visitors he recognises, gossip about the day, greeting, starting a chat, the buzz."""

import json

import app
import visitors


def _prompt(stub_llm, i=-1):
    return json.dumps(stub_llm.calls[i], default=str)


def _respond(user_id, text, session="s1"):
    return app.dispatch({"type": "respond", "sessionId": session, "userId": user_id, "userInput": text})


def test_a_returning_visitor_is_recognised(stub_llm):
    stub_llm.set_json({"text": "Fine.", "emotion": "resignation", "moveTo": "none", "action": "dance"})
    _respond("user-a", "dance for me")
    _respond("user-a", "do it again", session="s2")
    prompt = _prompt(stub_llm)
    assert "You've met them before" in prompt
    assert "dance 1 time" in prompt  # what was known before this second chat
    assert "dance for me" in prompt
    ctx = visitors.visitor_context("user-a")
    assert "2 visits" in ctx and "dance 2 times" in ctx


def test_a_new_visitor_is_new(stub_llm):
    stub_llm.set_json({"text": "Hello.", "emotion": "boredom"})
    _respond("user-new", "hi")
    assert "never spoken with this visitor" in _prompt(stub_llm)


def test_gossip_counts_but_never_quotes(stub_llm):
    stub_llm.set_json({"text": "Fine.", "emotion": "resignation", "moveTo": "none", "action": "dance"})
    for _ in range(3):
        _respond("user-a", "my secret name is Bartholomew, dance")
    stub_llm.set_json({"text": "Fine.", "emotion": "resignation", "moveTo": "tv", "action": "none"})
    _respond("user-b", "go watch tv")
    g = visitors.gossip_context()
    assert "2 visitors" in g
    assert "dance 3 times" in g and "go watch TV 1 time" in g
    assert "One visitor alone had you dance 3 times" in g
    assert "Bartholomew" not in g
    assert "Today, across everyone" in _prompt(stub_llm)


def test_greet_only_someone_known_or_back_from_away(stub_llm):
    stub_llm.set_json({"text": "Oh. You.", "emotion": "dry-amusement"})
    result, _ = app.dispatch({"type": "greet", "sessionId": "g", "userId": "user-x"})
    assert result["response"] is None
    assert stub_llm.calls == []

    result, _ = app.dispatch({"type": "greet", "sessionId": "g", "userId": "user-x", "awayMinutes": 7})
    assert result["response"]["text"] == "Oh. You."
    assert "after 7 minutes away" in _prompt(stub_llm)


def test_what_he_starts_with_is_part_of_the_conversation(stub_llm):
    stub_llm.set_json({"text": "Do you ever watch the rain?", "emotion": "fleeting-curiosity"})
    result, _ = app.dispatch({"type": "initiate", "sessionId": "q", "userId": "user-q",
                              "context": "sitting on the couch watching rain on TV"})
    assert result["response"]["text"] == "Do you ever watch the rain?"
    assert "watching rain on TV" in _prompt(stub_llm)
    assert app.sessions.get_turns("q")[-1] == {"role": "assistant", "content": "Do you ever watch the rain?"}

    stub_llm.set_json({"text": "Same.", "emotion": "boredom"})
    _respond("user-q", "sometimes", session="q")
    assert "Do you ever watch the rain?" in _prompt(stub_llm)


def test_the_buzz_reaches_his_prompt(stub_llm):
    stub_llm.set_json({"text": "Hm.", "emotion": "melancholy"})
    app.dispatch({"type": "muse", "context": "x", "buzz": 2})
    assert "tipsy" in _prompt(stub_llm)
    app.dispatch({"type": "muse", "context": "x"})
    assert "tipsy" not in _prompt(stub_llm)
