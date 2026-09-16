# nginx perimeter — versioned copy

## Why this directory exists

The API is not reachable directly. Everything public goes through nginx, and
the configuration that decides *what is public* lives at
`/etc/nginx/sites-available/aboba-telegramovich.duckdns.org` — **outside this
repository**. Until now that file was not in version control at all, so
"what is exposed to the internet" could only be answered by logging into the
host and reading it. That is not reviewable and not diffable.

This directory holds a byte-exact snapshot of that file plus a check that
notices when the two diverge.

## Files

| File | What it is |
|---|---|
| `aboba-telegramovich.duckdns.org.conf` | Byte-exact snapshot of the live vhost. Provenance below. |
| `statlocker-probe.location.conf` | The `STATLOCKER_PROBE_POC` block, verbatim from live. |
| `check-drift.sh` | Compares the live config against the snapshot; exits non-zero on drift. |

## This is a shared vhost — read this before deploying it

The file is **not** Deadlock-only. One `server { ... }` block serves four
unrelated things:

| Location | Proxies to | Owner |
|---|---|---|
| `/` | `127.0.0.1:4050` | aboba-telegramovich — **not ours, do not break it** |
| `/deadlock-random/` | static `alias /var/www/deadlock-street-brawl/` | separate static site |
| `/pgadmin/` | `127.0.0.1:5050` | shared Postgres admin UI |
| `/deadlock/` | `127.0.0.1:3000` | **this project** |
| `/deadlock/tools/statlocker` | `127.0.0.1:3000` | **this project** |
| `/debug/` | `127.0.0.1:3000` | **this project** (shell is public by design, data is guarded) |

Consequence: **do not copy this file onto the host as a deployment step.**
Copying it would silently revert whatever the neighbouring projects have
changed since the snapshot was taken. The snapshot is a reference for humans
and a baseline for `check-drift.sh`; it is not the source of truth.

## What is automated, and what is not

| Block | Managed by | Notes |
|---|---|---|
| `DEADLOCK_DYNAMO_HELPER` | `deploy.yml`, every deploy | Rewritten in place from a literal in the workflow. Idempotent. |
| `STATLOCKER_PROBE_POC` | **nothing — by hand** | Placed manually. Its committed copy had drifted to 30s timeouts while live ran 90s. |
| `DEADLOCK_BUILD_V2_DEBUG` | **nothing — by hand** | Not referenced by any workflow. |
| Everything else | the other projects | Certbot rewrites the `ssl_*` and `listen` lines on renewal. |

Because `deploy.yml` rewrites `DEADLOCK_DYNAMO_HELPER` from its own literal,
editing that block here has **no effect** — change the workflow instead.

## Provenance

| | |
|---|---|
| Source | `/etc/nginx/sites-available/aboba-telegramovich.duckdns.org` |
| Lines | 107 |
| sha256 | `d069e244f428a378f4a5288dda3bf22fb4d253044e7219b68c7e8c70950beaf3` |
| nginx | 1.24.0 (Ubuntu) |
| `client_max_body_size` | `20m` |

The `STATLOCKER_PROBE_POC` block, extracted from the same file, hashes to
`226d3788a481793d72b6b8034a63df26f78a2932b0563498c0e9758d82456840`.

## Checking for drift

Run on the host:

```bash
sudo /usr/local/bin/deadlock-nginx-drift-check.sh
```

Or from a checkout, against the host's copy:

```bash
NGINX_VHOST_PATH=/etc/nginx/sites-available/aboba-telegramovich.duckdns.org \
  ops/nginx/check-drift.sh
```

Exit codes: `0` in sync, `1` drift or a missing block, `2` the live file could
not be read. `--quiet` suppresses output and returns only the code.

Drift is not automatically an error. Certbot edits the same file on every
certificate renewal, and so do the neighbouring projects, so drift is
expected from time to time. The point is that it becomes **visible** instead
of silent.

## Refreshing the snapshot

Only after reading the diff and deciding the change is intended:

```bash
ssh <host> 'cat /etc/nginx/sites-available/aboba-telegramovich.duckdns.org' \
  > ops/nginx/aboba-telegramovich.duckdns.org.conf
```

Then update the hash in the provenance table above and commit. Use the
command exactly as written — shell redirection and `scp` both preserve bytes,
but copying the text by hand through an editor does not, and a snapshot that
differs by whitespace is worse than no snapshot because it trains people to
ignore the diff.

## Invariants the check asserts

These are checked against the **live** file, so a hand-edit that removes a
route is caught even if somebody also refreshed the snapshot:

- `BEGIN`/`END DEADLOCK_DYNAMO_HELPER` markers both present
- `BEGIN`/`END STATLOCKER_PROBE_POC` markers both present
- `location ^~ /deadlock/ {` present
- at least one location proxies to `http://127.0.0.1:3000`

The loopback assertion matters: if the API were ever proxied on `0.0.0.0` or
a non-loopback address, that is a perimeter change and should never land
unnoticed. See the roadmap for why the container binds loopback in the first
place.
