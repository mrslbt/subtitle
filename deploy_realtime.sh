#!/usr/bin/env bash
# Deploys the realtime-translate changes to the Mac mini.
#
# Usage:
#   OPENAI_API_KEY="sk-..." ./deploy_realtime.sh
#
# What it does:
#   1. Adds OPENAI_API_KEY to the launchd plist for com.earpiece.server
#   2. rsyncs the changed server + JS files
#   3. Installs the new websockets python dep
#   4. Reloads the launchd job so the new env + code take effect
#   5. Curls /health to confirm realtime_available=true

set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "ERROR: export OPENAI_API_KEY first."
  exit 1
fi

HOST="minimac"
REMOTE_ROOT="/Users/agenthome/earpiece"
PLIST="\$HOME/Library/LaunchAgents/com.earpiece.server.plist"

echo "→ Checking SSH to $HOST..."
ssh -o ConnectTimeout=5 "$HOST" 'echo ok' >/dev/null

echo "→ Syncing files..."
rsync -av \
  --include='server/' \
  --include='server/server.py' \
  --include='server/requirements.txt' \
  --include='js/' \
  --include='js/realtime.js' \
  --include='js/pcm-worklet.js' \
  --include='js/app.js' \
  --exclude='*' \
  "$(dirname "$0")/" "$HOST:$REMOTE_ROOT/"

echo "→ Installing websockets dep on Mac mini..."
ssh "$HOST" "cd $REMOTE_ROOT/server && source .venv/bin/activate && pip install -q 'websockets>=12.0'"

echo "→ Patching launchd plist with OPENAI_API_KEY..."
# Use PlistBuddy to upsert OPENAI_API_KEY inside EnvironmentVariables.
ssh "$HOST" "
  P=\"\$HOME/Library/LaunchAgents/com.earpiece.server.plist\"
  if ! /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' \"\$P\" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' \"\$P\"
  fi
  /usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables:OPENAI_API_KEY' \"\$P\" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OPENAI_API_KEY string $OPENAI_API_KEY' \"\$P\"
  echo 'plist patched'
"

echo "→ Reloading launchd job..."
ssh "$HOST" '
  launchctl bootout gui/501/com.earpiece.server 2>/dev/null || true
  launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.earpiece.server.plist
  echo "reloaded"
'

echo "→ Waiting 5s for server to come up..."
sleep 5

echo "→ Health check..."
curl -s https://earpiece.marselbait.me/health | python3 -m json.tool

echo ""
echo "Done. Verify realtime_available=true above. If true, hit the app on iPhone and speak Japanese."
