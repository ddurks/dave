"""Test fixtures for D.A.V.E. mind.

This module runs BEFORE any test imports `app`, because:
1. It sets GROQ_API_KEY/GROQ_MODEL in os.environ (app reads these at import time).
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

os.environ.setdefault("GROQ_API_KEY", "test")
os.environ.setdefault("GROQ_MODEL", "test-model")

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
    "browseReactPrompt": "test-browse-react-prompt",
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
def stub_groq(monkeypatch):
    """Stub app.get_groq_client. Returned object lets tests set response text
    or structured tool-call arguments.

    Usage:
        def test_x(stub_groq):
            stub_groq.set_response("hello world")  # plain-text fallback path
            stub_groq.set_tool_response({"text": "x", "emotion": "boredom"})  # tool-call path
    """

    class _Stub:
        def __init__(self):
            self.text = ""
            self.tool_args = None
            self.client = MagicMock()
            self.client.chat.completions.create = MagicMock(side_effect=self._create)

        def _create(self, *args, **kwargs):
            msg = MagicMock()
            msg.choices = [MagicMock()]
            if self.tool_args is not None:
                tool_call = MagicMock()
                tool_call.function = MagicMock()
                tool_call.function.arguments = json.dumps(self.tool_args)
                msg.choices[0].message.tool_calls = [tool_call]
                msg.choices[0].message.content = None
            else:
                msg.choices[0].message.tool_calls = None
                msg.choices[0].message.content = self.text
            return msg

        def set_response(self, text: str):
            """Stub returns plain text (fallback-path testing)."""
            self.text = text
            self.tool_args = None

        def set_tool_response(self, args: dict):
            """Stub returns a tool call with JSON-encoded arguments."""
            self.tool_args = args
            self.text = ""

    stub = _Stub()
    monkeypatch.setattr(app, "get_groq_client", lambda: stub.client)
    return stub


@pytest.fixture
def client():
    """Flask test client."""
    app.app.config["TESTING"] = True
    with app.app.test_client() as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Reset in-memory session store between tests."""
    app.sessions.clear()
    yield
    app.sessions.clear()
