"""The Claude adapter in tools.py.

Replaces the tests for the old Groq tool-calling layer. Constrained decoding
means the response is always valid JSON obeying the enums, so the salvage
machinery those tests covered (scraping a malformed `<function=>` wrapper,
dropping an out-of-enum emotion, falling back to prose parsing) is gone.

What needs testing now is the translation either side of the call: schema shapes
Claude will not accept, the system/messages split, and the budget gate.
"""

import json
from unittest.mock import MagicMock

import budget
import tools


def _client(payload=None, *, text=None, stop_reason="end_turn"):
    block = MagicMock()
    block.type = "text"
    block.text = text if text is not None else json.dumps(payload or {})
    msg = MagicMock()
    msg.content = [block]
    msg.stop_reason = stop_reason
    msg.usage = MagicMock(input_tokens=5, output_tokens=5,
                          cache_creation_input_tokens=0, cache_read_input_tokens=0)
    client = MagicMock()
    client.messages.create = MagicMock(return_value=msg)
    return client


# ── Schema translation ───────────────────────────────────────────────────────

def test_nullable_enum_becomes_a_plain_enum_with_a_sentinel():
    """Claude rejects a union type declared alongside an enum outright:
    'Enum value X does not match declared type [string, null]'."""
    schema = tools._claude_schema(tools.respond_tool)
    move_to = schema["properties"]["moveTo"]
    assert move_to["type"] == "string"
    assert None not in move_to["enum"]
    assert tools.NONE_SENTINEL in move_to["enum"]
    assert "chair" in move_to["enum"]


def test_numeric_bounds_are_stripped():
    schema = tools._claude_schema(tools.idle_tool)
    assert "minimum" not in schema["properties"]["durationSec"]
    assert "maximum" not in schema["properties"]["durationSec"]


def test_strict_decoding_requires_every_property():
    schema = tools._claude_schema(tools.respond_tool)
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["additionalProperties"] is False


def test_translation_does_not_mutate_the_shared_tool_dict():
    before = json.dumps(tools.respond_tool, sort_keys=True, default=str)
    tools._claude_schema(tools.respond_tool)
    assert json.dumps(tools.respond_tool, sort_keys=True, default=str) == before


def test_sentinel_maps_back_to_none_on_the_way_out():
    client = _client({"text": "hi", "emotion": "boredom", "moveTo": tools.NONE_SENTINEL})
    out = tools.call_with_schema(
        client, "claude-haiku-4-5",
        [{"role": "user", "content": "hello"}], tools.respond_tool,
    )
    assert out["moveTo"] is None
    assert out["text"] == "hi"


# ── Message translation ──────────────────────────────────────────────────────

def test_system_messages_move_out_of_the_messages_array():
    system, rest = tools._split_system([
        {"role": "system", "content": "persona"},
        {"role": "system", "content": "mode"},
        {"role": "user", "content": "hello"},
    ])
    assert [b["text"] for b in system] == ["persona", "mode"]
    assert rest == [{"role": "user", "content": "hello"}]


def test_the_persona_block_carries_the_cache_breakpoint():
    """It is byte-stable across every request, so it should bill at cache-read
    rates. Anything volatile has to follow it."""
    system, _ = tools._split_system([
        {"role": "system", "content": "persona"},
        {"role": "system", "content": "volatile"},
        {"role": "user", "content": "hi"},
    ])
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in system[1]


def test_image_blocks_are_converted_to_claude_shape():
    _, rest = tools._split_system([{
        "role": "user",
        "content": [
            {"type": "text", "text": "what is this"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ],
    }])
    image = rest[0]["content"][1]
    assert image["type"] == "image"
    assert image["source"] == {
        "type": "base64", "media_type": "image/png", "data": "AAAA",
    }


# ── Failure and budget behaviour ─────────────────────────────────────────────

def test_a_refusal_degrades_in_character():
    client = _client({"text": "x", "emotion": "boredom"}, stop_reason="refusal")
    out = tools.call_with_schema(
        client, "claude-haiku-4-5",
        [{"role": "user", "content": "hi"}], tools.respond_tool,
    )
    assert out["_rate_limited"] is True
    assert out["text"] in tools._RATE_LIMITED_LINES


def test_non_json_despite_the_schema_is_reported_not_guessed():
    client = _client(text="this is not json")
    out = tools.call_with_schema(
        client, "claude-haiku-4-5",
        [{"role": "user", "content": "hi"}], tools.respond_tool,
    )
    assert out == {"_raw_text": "this is not json"}


def test_a_spent_budget_refuses_before_calling_the_model(monkeypatch):
    monkeypatch.setattr(budget, "allows", lambda model: (False, "monthly budget spent"))
    client = _client({"text": "x", "emotion": "boredom"})
    out = tools.call_with_schema(
        client, "claude-opus-5",
        [{"role": "user", "content": "hi"}], tools.respond_tool,
    )
    assert out["_rate_limited"] is True
    client.messages.create.assert_not_called()


def test_effort_is_only_sent_to_models_that_accept_it():
    """Haiku 4.5 rejects output_config.effort with a 400."""
    cheap = _client({"text": "x", "emotion": "boredom"})
    tools.call_with_schema(
        cheap, "claude-haiku-4-5",
        [{"role": "user", "content": "hi"}], tools.respond_tool,
    )
    assert "effort" not in cheap.messages.create.call_args.kwargs["output_config"]

    good = _client({"text": "x", "emotion": "boredom"})
    tools.call_with_schema(
        good, "claude-opus-5",
        [{"role": "user", "content": "hi"}], tools.respond_tool,
    )
    assert good.messages.create.call_args.kwargs["output_config"]["effort"] == "low"
