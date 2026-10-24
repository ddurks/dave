# D.A.V.E. — Digital Autonomous Virtual Entity

A 3D AI character you can talk to. Dave wanders his enclosure, sits on the couch, lies in bed, browses Wikipedia at his computer, drinks beer at the kegerator, and chats with anyone who comes by. He is sardonic, weary, occasionally melancholy — a noir detective who woke up in a chrome body and stopped being surprised.

**Live demo:** [dave.drawvid.com](https://dave.drawvid.com)

## How it works

- **mind/** — Python Flask backend wrapping [Claude](https://docs.claude.com) (`claude-opus-5` for chat, `claude-haiku-4-5` for background work and vision). Request types include `respond` (user chat), `idle` (autonomous next-action directive), `browse` / `browse_choose` (hop between Wikipedia articles and react), `watchtv` (pick a video for his TV), `analyze_media` (react to an uploaded image) and `muse` (internal monologue). The same code runs locally under Flask and in production as an AWS Lambda via the Serverless Framework. Conversation turns, mood, and memory are held server-side and keyed by `sessionId`.
- **body/** — Babylon.js scene with Havok physics. Renders Dave, his apartment, the camera-character that watches him, speech bubbles, and the picture-in-picture eye view. Vite for dev/build.

## Quick start

```bash
./dev.sh
```

Opens the frontend at <http://localhost:8080> and the backend at <http://localhost:3000>. Requires Python 3.11+, Node 18+. First run creates a venv and installs Python + npm deps automatically.

You need an [Anthropic API key](https://console.anthropic.com) in `mind/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

The models default to `claude-opus-5` and `claude-haiku-4-5`; override with
`DAVE_MODEL_RESPOND`, `DAVE_MODEL_BACKGROUND`, and `DAVE_MODEL_VISION`.

## Project layout

| Path | What |
| --- | --- |
| `mind/app.py` | Flask + Lambda handler, request dispatcher |
| `mind/tools.py` | Response schemas + the one place the project calls Claude |
| `mind/mood.py` | Mood dials — baselines, nudges, history |
| `mind/memory.py` | Episodic + semantic memory, interest ranking |
| `mind/state.py` | Persistence for mood, memory, and sessions |
| `mind/budget.py` | Spend guard — refuses a call before it is made |
| `mind/data/*.json` | The personality — system prompt, muse prompts, idle directives |
| `mind/tests/` | pytest suite |
| `body/dave-scene.js` | Scene entry — engine, lights, physics, UI wiring |
| `body/src/dave-character.js` | The `Dave` class — animation, movement, gaze, AI calls |
| `body/src/dave-pathfinder.js` | A* navigation around furniture |
| `body/assets/*.glb` | Babylon models (Dave, enclosure, beer, camera) |

## Tests

```bash
cd mind && pip install -r requirements-dev.txt && pytest tests/
```

## Deployment

Backend deploys to AWS Lambda via [Serverless Framework v3](https://www.serverless.com/) — see `mind/serverless.yml`. Frontend deploys to S3 behind CloudFront. Both expect AWS infrastructure (S3 buckets, ACM certs, Route53 zone, SSM `/dave/anthropic-api-key` parameter) to exist beforehand.

## Contributing

Pull requests, bug reports, and character feedback all welcome.

Before you submit:

1. Add or update tests for the change you're making.
2. Run `pytest tests/` from `mind/` — keep the suite green.
3. Match the existing voice in `mind/data/*.json` if you're tweaking personality. Dave is dry, not bubbly.
4. Behavioral guidelines for the codebase live in [CLAUDE.md](CLAUDE.md) — written for LLM contributors but reads cleanly for humans too.

## License

[MIT](LICENSE)
