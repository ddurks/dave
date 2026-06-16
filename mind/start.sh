#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating virtualenv..."
  python3.13 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

# Kill anything already on port 3000
lsof -ti tcp:3000 | xargs kill -9 2>/dev/null || true

exec .venv/bin/python app.py
