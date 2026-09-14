#!/bin/bash
set -e

# Always sync from the project root regardless of where the script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Syncing files to my-vps... ==="
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'storage' \
  --exclude '*.hprof' \
  --exclude 'apps/overwolf-client/dist' \
  --exclude '.worktrees' \
  --exclude 'graphify-out' \
  --exclude '.codex' \
  --exclude '.zcode' \
  "$SCRIPT_DIR/" my-vps:~/apps/deadlock_dynamo_helper/

echo "=== Building Docker image on my-vps... ==="
ssh my-vps "cd ~/apps/deadlock_dynamo_helper && docker build -t deadlock-adaptive-production:current ."

echo "=== Running DB migrations on my-vps... ==="
ssh my-vps "cd ~/apps/deadlock_dynamo_helper && docker compose run --rm api node run-migrations.js"

echo "=== Triggering Docker Compose build & start on my-vps... ==="
ssh my-vps "cd ~/apps/deadlock_dynamo_helper && docker compose up -d"

echo "=== Deploy finished successfully! ==="
