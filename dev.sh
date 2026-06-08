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

# Start frontend in background with Vite HMR
cd "$PROJECT_ROOT/body"
npm install --silent
npm run dev > /tmp/dave-frontend.log 2>&1 &
FRONTEND_PID=$!

# Brief pause for frontend to start
sleep 1

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

# Run Python backend with environment variables from .env
export GROQ_API_KEY=${GROQ_API_KEY}
export GROQ_MODEL=${GROQ_MODEL:-llama-3.1-8b-instant}
export PORT=3000
python app.py

# Cleanup on exit
kill $FRONTEND_PID 2>/dev/null
