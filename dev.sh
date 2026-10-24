#!/bin/bash
# D.A.V.E. Development Server Launcher

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting D.A.V.E. (frontend :8080, backend :3000)..."

# Load environment variables
if [ -f "$PROJECT_ROOT/mind/.env" ]; then
  set -a
  source "$PROJECT_ROOT/mind/.env"
  set +a
fi

# Vite is started in the background, so it has to be torn down on every exit
# path -- not just a clean one. Without this, Ctrl-C leaves it holding :8080;
# the next run then finds the port taken, quietly moves to :8081, and the
# browser keeps talking to the stale orphan. strictPort in vite.config.js is
# the second half of that guard: it makes the collision loud instead of silent.
FRONTEND_PID=""
cleanup() {
  [ -n "$FRONTEND_PID" ] || return
  if command -v taskkill >/dev/null 2>&1; then
    # npm spawns vite as a child; //T takes the whole tree.
    taskkill //PID "$FRONTEND_PID" //T //F >/dev/null 2>&1
  else
    kill -- -"$FRONTEND_PID" 2>/dev/null || kill "$FRONTEND_PID" 2>/dev/null
  fi
  FRONTEND_PID=""
}
trap cleanup EXIT INT TERM

# Start frontend in background with Vite HMR
cd "$PROJECT_ROOT/body"
npm install --silent
npm run dev > /tmp/dave-frontend.log 2>&1 &
FRONTEND_PID=$!

# Give Vite long enough to bind or fail, then say which it did.
sleep 2
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  echo "Frontend failed to start. Last lines of /tmp/dave-frontend.log:"
  tail -5 /tmp/dave-frontend.log
  exit 1
fi

# Start backend in foreground (Python with venv)
cd "$PROJECT_ROOT/mind"

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
  echo "Creating Python virtual environment..."
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv .venv
  else
    python -m venv .venv
  fi
fi

# Activate virtual environment
source .venv/Scripts/activate 2>/dev/null || source .venv/bin/activate

# Install dependencies
pip install -q -r requirements.txt

# app.py loads mind/.env itself; only the port needs forcing here so the
# frontend's localhost:3000 fallback lines up.
export PORT=3000
python app.py
