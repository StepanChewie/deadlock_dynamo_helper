# Environments: production and UAT

Two environments run on `my-vps`, from two branches, into two directories.

**Production is the one the Overwolf submission points at.** It is deployed from
`main` and nothing should be tried out there. Testing happens in UAT.

| | Production | UAT |
|---|---|---|
| Branch | `main` | `uat` |
| Workflow | `Deploy API` | `Deploy UAT` |
| Directory | `~/apps/deadlock_dynamo_helper` | `~/apps/deadlock_dynamo_helper_uat` |
| Compose file | `docker-compose.yml` | `docker-compose.uat.yml` |
| Compose project | `deadlock_dynamo_helper` | `deadlock_dynamo_helper_uat` |
| Container | `deadlock_dynamo_helper-api-1` | `deadlock_dynamo_helper_uat-api-1` |
| Image | `deadlock-adaptive-production:*` | `deadlock-adaptive-uat:*` |
| Host port | `127.0.0.1:3000` | `127.0.0.1:3003` |
| Database | `deadlock_builds` | `deadlock_builds_uat` |
| Base URL | `https://aboba-telegramovich.duckdns.org` | `https://aboba-telegramovich.duckdns.org/deadlock-uat` |
| Ops units | health, freshness, backup | none |

## Deploying

Push to the branch. Nothing else.

```
git push dynamo main     # production
git push dynamo uat      # UAT
```

`./deploy.sh` is the manual escape hatch for when Actions is down. It takes the
environment as its only argument and **defaults to `uat`** — production needs a
deliberate `./deploy.sh prod`, because the old version deployed production
unconditionally and that is the mistake this split exists to prevent.

To try a change before it goes anywhere near `main`: push it to `uat`, let
`Deploy UAT` run, and check it at the UAT base URL. When it is good, merge to
`main`.

## Pointing the Overwolf client at UAT

The client bakes its API origin in at build time and there is no default, so a
test build has to be told explicitly:

```
cd apps/overwolf-client
yarn build:bundle
OVERWOLF_API_BASE_URL=https://aboba-telegramovich.duckdns.org/deadlock-uat yarn configure:api
yarn build      # this runs the store-ready validator, which rejects localhost
```

`yarn build:bundle` then `configure:api` rather than a plain `yarn build`,
because the store-ready validator that `build` runs rejects anything that is not
the real origin — which is the point: a release build cannot silently point
somewhere else. The shipped client keeps the production origin.

## Why UAT is a path prefix

`/deadlock-uat/` on the existing hostname, rather than `deadlock-uat.duckdns.org`.
A second name is tidier but needs a DNS record and its own certificate; the
prefix needs neither, and the same file already routes `/pgadmin/` that way. The
trailing slash on `proxy_pass http://127.0.0.1:3003/` strips the prefix, so the
API sees its normal `/deadlock/...` routes.

The nginx block is applied once by hand and is not rewritten by either workflow —
the production one only rewrites the `DEADLOCK_DYNAMO_HELPER` markers. It is
asserted to exist by `ops/nginx/check-drift.sh`, which also compares the live
config byte-for-byte against `ops/nginx/aboba-telegramovich.duckdns.org.conf`, so
if the block is ever removed the drift check says so.

## What UAT deliberately does not have

- **The ops systemd units.** `deadlock-health-watch`, `deadlock-data-freshness-watch`
  and `deadlock-db-backup` reference the production container and database by
  name. Installing them from the UAT deploy would silently repoint production's
  monitoring and its nightly backup at the test environment. UAT's own health is
  its compose healthcheck plus the deploy's wait-for-healthy step.
- **A database backup.** It is disposable; recreate it instead.

## What UAT costs

UAT runs its own collection against statlocker, because it has its own database
and therefore needs its own evidence. That doubles the upstream traffic —
`WPA_PATCH_DATA` alone is ~258 MB per fetch, once a day per environment. If that
ever becomes a problem, the cheapest lever is to stop UAT collecting and copy a
snapshot of the production evidence tables into `deadlock_builds_uat` instead.

## Adding the environment to a fresh host

Three things live outside this repository and are not created by any workflow:

1. The database: `create database deadlock_builds_uat` on the shared postgres
   instance.
2. `~/apps/deadlock_dynamo_helper_uat/.env`, copied from production's with any
   `DB_NAME` line removed. `DB_NAME` is hardcoded in the UAT compose file on
   purpose, so a stale value there cannot point UAT at production's data.
3. The nginx block, copied verbatim out of
   `ops/nginx/aboba-telegramovich.duckdns.org.conf`.
