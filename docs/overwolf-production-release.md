# API deployment and Overwolf sideload rollout

Two paths deploy the same artifact: the GitHub Actions `deploy.yml` workflow (self-hosted runner on the VPS, triggered by a push to `main`) and the manual `deploy.sh` script (rsync + docker build over `ssh my-vps`). Use the manual path when a push is intentionally marked `[skip ci]`, or when Actions are unavailable. The steps are equivalent.

The Overwolf client is validated through Developer Mode. OPK packaging and Developer Console publishing are intentionally outside the current scope.

## Prerequisites

- The public API hostname resolves over HTTPS from the internet (`PUBLIC_API_BASE_URL`).
- The deployment host holds the compose file, `.env` and the `deadlock-storage` volume (`docker-compose.yml`, service `api`, container `deadlock_dynamo_helper-api-1`).
- Overwolf Developer Mode is enabled on the test machine.

## 1. Deploy the API

Automated (GitHub Actions): merge into `main`. `deploy.yml` rebuilds the image, runs migrations, recreates the container, waits for the Docker health check, verifies `/deadlock/adaptive/v1/status` locally and through the public HTTPS origin, and confirms that retired routes (`/deadlock/analysis/*`, `/deadlock/live/build-recommendations`) return 404.

Manual (no Actions) — commit with `[skip ci]`, push, then run from the repository root:

```bash
bash deploy.sh
```

`deploy.sh` rsyncs the tree to `my-vps:~/apps/deadlock_dynamo_helper/` (excluding `node_modules`, `dist`, `.git`, `.env`, `storage`, `.worktrees`, `graphify-out`, `.codex`, `.zcode`), builds `deadlock-adaptive-production:current` on the VPS, runs migrations (`node run-migrations.js`), and recreates the container with `docker compose up -d`.

Verify manually:

```bash
ssh my-vps "cd ~/apps/deadlock_dynamo_helper && docker compose ps"
curl -sS "$PUBLIC_API_BASE_URL/deadlock/adaptive/v1/status" | jq
```

Expected: the container reports `healthy` and the status payload reports fresh evidence. A deployment is not considered successful when the container is running but the status endpoint fails or reports stale or missing datasets.

## 2. Build the unpacked Overwolf client

Build the client against the deployed public API base URL:

```bash
OVERWOLF_API_BASE_URL=https://your-api.example.com \
OVERWOLF_PUBLIC_TARGET=/path/to/overwolf-sideload/public \
yarn workspace @dynamo-lab/overwolf-client build
```

The build compiles the shared package and the Overwolf bundle, embeds the supplied API base URL, updates `externally_connectable` to the matching origin, validates the manifest, windows, permissions, assets and compiled files, and copies the unpacked app to `OVERWOLF_PUBLIC_TARGET`.

## 3. Load through Overwolf Developer Mode

1. Open Overwolf.
2. Go to `Settings` > `Support` > `Development Options`.
3. Click `Load unpacked extension...`.
4. Select the built `public` directory containing `manifest.json`.
5. Reload the unpacked extension after every client build.

## 4. Live smoke test

1. Start Deadlock and verify the app launches automatically.
2. Verify GEP registration reaches `REGISTERED`.
3. Enter a Sandbox or test match and confirm the local player, hero, roster, game clock and inventory update.
4. Confirm the in-game build overlay opens and receives recommendations from `POST /deadlock/adaptive/v2/recommend`.
5. Buy, upgrade and sell items; verify the recommendation changes without restarting the app.
6. Toggle the overlay and open the desktop build window with the registered hotkeys.
7. End the match and verify the overlay clears the previous match state.
8. Confirm `/deadlock/adaptive/v1/status` stays healthy and its dataset freshness stays `FRESH`.

## Rollback

API — retag and recreate with the previous known-good image:

```bash
ssh my-vps "docker tag deadlock-adaptive-production:<known-good-tag> deadlock-adaptive-production:current"
ssh my-vps "cd ~/apps/deadlock_dynamo_helper && docker compose up -d --force-recreate --no-build api"
```

`deploy.yml` tags every verified image as `deadlock-adaptive-production:current` (the `Record verified adaptive Compose fallback` step); keep the previous tag aside before deploying.

Overwolf — load the previous known-good unpacked `public` directory, keep its API origin available, and investigate through `/deadlock/adaptive/v1/status`, Docker logs and the Overwolf log.
