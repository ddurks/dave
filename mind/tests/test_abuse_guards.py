"""The layers between a scripted /query loop and the API bill."""

import json

import pytest

import app
import budget
import ratelimit
import state


def _event(body, ip="203.0.113.7"):
    return {
        "httpMethod": "POST",
        "path": "/query",
        "headers": {"origin": "https://dave.drawvid.com"},
        "requestContext": {"identity": {"sourceIp": ip}},
        "body": json.dumps(body),
    }


# ── Rate limits ──────────────────────────────────────────────────────────────

def test_chat_limit_trips_per_ip(monkeypatch):
    monkeypatch.setitem(ratelimit.LIMITS, "chat", [(60, 3)])
    for _ in range(3):
        assert ratelimit.check("203.0.113.7", "respond") is None
    assert ratelimit.check("203.0.113.7", "respond") == "rate limited"
    # Another visitor is unaffected, and so is background traffic.
    assert ratelimit.check("198.51.100.1", "respond") is None
    assert ratelimit.check("203.0.113.7", "idle") is None


def test_overall_limit_covers_every_type(monkeypatch):
    monkeypatch.setitem(ratelimit.LIMITS, "all", [(60, 2)])
    assert ratelimit.check("203.0.113.7", "idle") is None
    assert ratelimit.check("203.0.113.7", "muse") is None
    assert ratelimit.check("203.0.113.7", "browse") == "rate limited"


def test_missing_ip_is_refused():
    assert ratelimit.check("", "respond") == "no client address"


def test_rate_limiter_fails_closed(monkeypatch):
    def broken(*a, **kw):
        raise RuntimeError("table gone")
    monkeypatch.setattr(state, "hit", broken)
    assert ratelimit.check("203.0.113.7", "idle") == "rate limiter unavailable"


def test_lambda_handler_returns_429_before_any_model_call(stub_llm, monkeypatch):
    monkeypatch.setitem(ratelimit.LIMITS, "chat", [(60, 1)])
    stub_llm.set_json({"text": "fine.", "emotion": "boredom"})
    body = {"type": "respond", "sessionId": "s", "userInput": "hi"}

    assert app.lambda_handler(_event(body), None)["statusCode"] == 200
    calls = stub_llm.client.messages.create.call_count
    resp = app.lambda_handler(_event(body), None)
    assert resp["statusCode"] == 429
    assert stub_llm.client.messages.create.call_count == calls


# ── Budget ───────────────────────────────────────────────────────────────────

def test_budget_fails_closed_when_ledger_unreadable(monkeypatch):
    def broken():
        raise RuntimeError("table gone")
    monkeypatch.setattr(state, "budget_spent_micros", broken)
    ok, why = budget.allows(app.MODEL_RESPOND)
    assert not ok
    assert why == "budget ledger unavailable"


def test_search_query_generation_respects_budget(stub_llm, monkeypatch):
    monkeypatch.setattr(budget, "allows", lambda model: (False, "monthly budget spent"))
    assert app._generate_search_query(stub_llm.client, app.MODEL_BACKGROUND, 12) is None
    stub_llm.client.messages.create.assert_not_called()


# ── Store ────────────────────────────────────────────────────────────────────

def test_store_refuses_local_fallback_on_lambda(monkeypatch):
    class NoDynamo:
        def __init__(self, *a, **kw):
            raise RuntimeError("AccessDenied")
    monkeypatch.setattr(state, "DynamoStore", NoDynamo)
    monkeypatch.setattr(state, "_store", None)
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "dave-mind-dev-query")
    with pytest.raises(RuntimeError):
        state.get_store()


def test_unpriced_model_is_refused():
    """A model missing from PRICING would meter as $0 and dodge the cap."""
    ok, why = budget.allows("claude-unpriced-9")
    assert not ok
    assert "no price" in why


def test_configured_models_are_priced():
    import state_config
    assert app.MODEL_RESPOND in state_config.PRICING
    assert app.MODEL_BACKGROUND in state_config.PRICING
    assert app.MODEL_VISION in state_config.PRICING

