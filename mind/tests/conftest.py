"""Test fixtures for D.A.V.E. mind.

This module runs BEFORE any test imports `app`, because:
1. It sets ANTHROPIC_API_KEY in os.environ (app reads these at import time).
2. It ensures `mind/data/*.json` exists with required keys (app.load_prompts()
   runs at import time and will fail otherwise).

We only create stub data files if real ones are missing; we record what we
created and remove only those at session end. Real files committed by another
agent are left untouched.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# ── Environment setup (must happen before app import) ─────────────────────────

os.environ.setdefault("ANTHROPIC_API_KEY", "test")
os.environ.setdefault("DAVE_MODEL_RESPOND", "claude-opus-5-5")
os.environ.setdefault("DAVE_MODEL_BACKGROUND", "claude-haiku-5-5")

# ── Stub data files if missing (must happen before app import) ────────────────

MIND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = MIND_DIR / "data"

_STUB_SYSTEM_CONTEXT = {
    "systemPrompt": "test-system-prompt",
    "respondFormatPrompt": "test-respond-format-prompt",
}

_STUB_BEHAVIOR_PROMPTS = {
    "musePrompts": ["test-muse-prompt"],
    "musePreamble": "test-muse-preamble",
    "idlePrompt": "test-idle-prompt",
    "browsePickPrompt": "test-browse-pick-prompt",
    "distillPrompt": "distill", "browseReactPrompt": "test-browse-react-prompt",
}

# Track files (and dir) we create so we can remove only those at session end.
_CREATED_PATHS: list[Path] = []


def _ensure_stub_data():
    """Create stub data files if not present. Records what was created."""
    dir_was_created = False
    if not DATA_DIR.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        dir_was_created = True

    targets = [
        (DATA_DIR / "system-context.json", _STUB_SYSTEM_CONTEXT),
        (DATA_DIR / "behavior-prompts.json", _STUB_BEHAVIOR_PROMPTS),
    ]
    for path, payload in targets:
        if not path.exists():
            path.write_text(json.dumps(payload), encoding="utf-8")
            _CREATED_PATHS.append(path)

    if dir_was_created:
        _CREATED_PATHS.append(DATA_DIR)


_ensure_stub_data()

# Make mind/ importable so `import app` works regardless of cwd.
if str(MIND_DIR) not in sys.path:
    sys.path.insert(0, str(MIND_DIR))

# ── Now safe to import app ────────────────────────────────────────────────────

import pytest  # noqa: E402
import app  # noqa: E402


def pytest_sessionfinish(session, exitstatus):
    """Remove only files (and dir) we created."""
    for path in reversed(_CREATED_PATHS):
        try:
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        except OSError:
            pass


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def stub_llm(monkeypatch):
    """Stub app.get_client with a fake Claude client.

    Structured output means the response is always JSON in a text block, so a
    single setter covers every handler. `set_response` remains for the handful
    of tests that exercise the non-JSON path.

    Usage:
        def test_x(stub_llm):
            stub_llm.set_json({"text": "x", "emotion": "boredom"})
            stub_llm.set_response("not json at all")
    """

    class _Stub:
        def __init__(self):
            self.payload = None
            self.text = ""
            self.calls = []
            self.client = MagicMock()
            self.client.messages.create = MagicMock(side_effect=self._create)

        def _create(self, *args, **kwargs):
            self.calls.append(kwargs)
            block = MagicMock()
            block.type = "text"
            block.text = json.dumps(self.payload) if self.payload is not None else self.text
            msg = MagicMock()
            msg.content = [block]
            msg.stop_reason = "end_turn"
            msg.usage = MagicMock(
                input_tokens=10, output_tokens=10,
                cache_creation_input_tokens=0, cache_read_input_tokens=0,
            )
            return msg

        def set_json(self, payload: dict):
            """Stub returns a valid structured-output object."""
            self.payload = payload
            self.text = ""

        def set_response(self, text: str):
            """Stub returns plain text (the non-JSON path)."""
            self.text = text
            self.payload = None

    stub = _Stub()
    monkeypatch.setattr(app, "get_client", lambda: stub.client)
    return stub


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Point the persistent-state layer at a scratch file per test.

    Mood, memory and the spend ledger are all persistent now, so without this a
    test could read another test's leftovers -- or worse, a developer's real
    DynamoDB table.
    """
    import state
    import state_config

    monkeypatch.setattr(state_config, "LOCAL_STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setattr(state, "_store", state.LocalStore(str(tmp_path / "state.json")))
    monkeypatch.setattr(state, "_backend_name", "local")
    state._budget_cache.update(month=None, item={}, read_at=0.0, deltas={})
    yield


@pytest.fixture
def client():
    """Flask test client."""
    app.app.config["TESTING"] = True
    with app.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Reset the in-memory session store between tests, if one is wired up.

    app.py stopped holding a session store when handle_respond moved to
    client-supplied history, so this guards rather than assuming. Persistent
    state is handled separately by isolated_state.
    """
    store = getattr(app, "sessions", None)
    if store is not None:
        store.clear()
    yield
    if store is not None:
        store.clear()
