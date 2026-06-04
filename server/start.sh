#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Create venv if missing
if [ ! -d ".venv" ]; then
  echo "[earpiece] creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install deps if missing
if ! python -c "import mlx_whisper" 2>/dev/null; then
  echo "[earpiece] installing dependencies..."
  pip install --upgrade pip
  pip install -r requirements.txt
fi

# Load .env if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

python server.py
