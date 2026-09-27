#!/bin/bash
set -e

# Manual deploy, for when GitHub Actions is not available. The normal path is a
# push: `main` deploys production, `uat` deploys UAT.
#
# Usage: ./deploy.sh [prod|uat]
#
# The default is uat on purpose. Production is the environment the Overwolf
# submission points at, so reaching it should take a deliberate word rather than
# being whatever happens when someone runs this script without reading it. The
# old version deployed production unconditionally, which is exactly the footgun
# the UAT environment exists to remove.

ENVIRONMENT="${1:-uat}"

case "$ENVIRONMENT" in
  prod)
    REMOTE_DIR='/home/ubuntu/apps/deadlock_dynamo_helper'
    IMAGE='deadlock-adaptive-production:current'
    COMPOSE_FILE='docker-compose.yml'
    ;;
  uat)
    REMOTE_DIR='/home/ubuntu/apps/deadlock_dynamo_helper_uat'
    IMAGE='deadlock-adaptive-uat:current'
    COMPOSE_FILE='docker-compose.uat.yml'
    ;;
  *)
    echo "Unknown environment '$ENVIRONMENT'. Use 'prod' or 'uat'." >&2
    exit 1
    ;;
esac

# Always sync from the project root regardless of where the script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Syncing files to my-vps:$REMOTE_DIR ($ENVIRONMENT)... ==="
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
  "$SCRIPT_DIR/" "my-vps:$REMOTE_DIR/"

echo "=== Building Docker image on my-vps ($ENVIRONMENT)... ==="
ssh my-vps "cd $REMOTE_DIR && docker build -t $IMAGE ."

echo "=== Running DB migrations ($ENVIRONMENT)... ==="
ssh my-vps "cd $REMOTE_DIR && DEADLOCK_API_IMAGE=$IMAGE docker compose -f $COMPOSE_FILE run --rm --no-deps api node run-migrations.js"

echo "=== Starting Docker Compose ($ENVIRONMENT)... ==="
ssh my-vps "cd $REMOTE_DIR && DEADLOCK_API_IMAGE=$IMAGE DB_RUN_MIGRATIONS=false docker compose -f $COMPOSE_FILE up -d --force-recreate --no-build --no-deps api"

echo "=== Deploy finished successfully ($ENVIRONMENT)! ==="
