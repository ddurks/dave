# D.A.V.E. — Mind

Flask server that powers D.A.V.E.'s mind

## Setup

```bash
cd mind
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Listens on `http://localhost:3000`.

## Configuration

Create `.env` file:

```bash
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.1-8b-instant
PORT=3000
```

## API

Single endpoint: `POST /query`

Request types:

- `"respond"` — User input → response
- `"idle"` — Generate idle behavior
- `"browse"` — Pick URL, fetch, react
- `"muse"` — Generate idle thought

Example:

```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"type": "respond", "userInput": "Hello"}'
```

## Tests

```bash
pip install -r requirements-dev.txt && python -m pytest tests/ -v
```

## Files

- `app.py` — Flask app + handlers + Lambda entry point
- `data/system-context.json` — Character definition
- `data/muse-prompts.json` — Idle questions
- `data/behavior-prompts.json` — Action directives
- `.venv/` — Python virtual environment (auto-created)
- `requirements.txt` — Python dependencies
