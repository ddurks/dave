# D.A.V.E. — Body

D.A.V.E.'s digital interface and environment.

## Run

```bash
npm install
npm run dev
```

Opens at `http://localhost:8080` with HMR via Vite.

## Build

```bash
npm run build
```

Produces a static bundle in `dist/` ready to deploy (e.g. S3 static site).

## Features

- **3D Character** — Glb models with animations
- **Tap to Interact** — Click/tap avatar to start conversation
- **Speech** — Text-to-speech (Web Speech API)
- **Animations** — Idle behavior, expressions, gestures
- **Session State** — localStorage-based (stateless backend)

## Files

- `index.html` — Scene setup, Babylon.js initialization
- `dave-scene.js` — Character controller, animations, API calls
- `memory-client.js` — Session management (localStorage)
- `assets/` — 3D models (GLB format)

## Backend Integration

All requests to `http://127.0.0.1:3000/query` — see [../mind/README.md](../mind/README.md) for endpoint details.
