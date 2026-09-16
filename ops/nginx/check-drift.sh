#!/usr/bin/env bash
# Detect drift between the nginx perimeter committed in this repository and
# the configuration that is actually live on the host.
#
# Why this exists
# ---------------
# The real perimeter is /etc/nginx/sites-available/<host>. It is NOT deployed
# from this repository. `deploy.yml` rewrites only the DEADLOCK_DYNAMO_HELPER
# block in place, and the STATLOCKER_PROBE_POC block was applied by hand.
# Everything else in that file belongs to other projects on the same host.
#
# Consequence: "what is reachable from the internet" can change without a
# commit, without a failing test, and without anyone reviewing it. The
# snapshot in this directory is the only thing a reviewer can actually read,
# so this script is what keeps it honest.
#
# This is deliberately NOT fatal in the deploy pipeline. Certbot edits the
# same file, and so do the neighbouring projects. Blocking a deploy on drift
# would turn a reporting gap into an outage path.
#
# Usage
# -----
#   ops/nginx/check-drift.sh            # print a diff, exit 1 on drift
#   ops/nginx/check-drift.sh --quiet    # exit code only, no output
#
# Exit codes
# ----------
#   0  live config matches the committed snapshot, all expected blocks present
#   1  drift detected, or a required block is missing from the live config
#   2  the live config could not be read at all

set -euo pipefail

LIVE_PATH="${NGINX_VHOST_PATH:-/etc/nginx/sites-available/aboba-telegramovich.duckdns.org}"

# The snapshot is looked up in two layouts, because this script is used both
# from a checkout and from /usr/local/bin on the host:
#   1. next to the script            (running out of the repository)
#   2. /usr/local/share/deadlock/    (installed by the deploy pipeline)
if [ -n "${NGINX_SNAPSHOT_PATH:-}" ]; then
  SNAPSHOT_PATH="$NGINX_SNAPSHOT_PATH"
elif [ -r "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aboba-telegramovich.duckdns.org.conf" ]; then
  SNAPSHOT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aboba-telegramovich.duckdns.org.conf"
else
  SNAPSHOT_PATH="/usr/local/share/deadlock/nginx-snapshot.conf"
fi

QUIET=0
if [ "${1:-}" = "--quiet" ]; then
  QUIET=1
fi

log() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

if [ ! -r "$LIVE_PATH" ]; then
  log "ERROR: cannot read live nginx config at $LIVE_PATH"
  exit 2
fi

if [ ! -r "$SNAPSHOT_PATH" ]; then
  log "ERROR: cannot read committed snapshot at $SNAPSHOT_PATH"
  exit 2
fi

status=0

# 1. Invariants. These are the routes that must exist for the product to work.
#    Checked against the LIVE file, not the snapshot, so that a hand-edit which
#    removes a route is caught even if someone also refreshed the snapshot.
#
#    Ordering note: the more specific `^~ /deadlock/tools/statlocker` must be
#    considered before the broader `^~ /deadlock/`. nginx uses the longest
#    matching prefix, so both can coexist; we only assert presence.
required_blocks=(
  'BEGIN DEADLOCK_DYNAMO_HELPER'
  'END DEADLOCK_DYNAMO_HELPER'
  'BEGIN STATLOCKER_PROBE_POC'
  'END STATLOCKER_PROBE_POC'
  'location ^~ /deadlock/ {'
)

for needle in "${required_blocks[@]}"; do
  if ! grep -qF -- "$needle" "$LIVE_PATH"; then
    log "MISSING: live config has no '$needle'"
    status=1
  fi
done

# 2. The Deadlock route must actually proxy to the API container, and it must
#    do so on loopback. A change to 0.0.0.0 or another port is a perimeter
#    change and should never land silently.
if ! grep -qF -- 'proxy_pass http://127.0.0.1:3000;' "$LIVE_PATH"; then
  log "MISSING: no location proxies to http://127.0.0.1:3000"
  status=1
fi

# 3. Byte-level drift against the snapshot.
if ! diff -u "$SNAPSHOT_PATH" "$LIVE_PATH" >/tmp/nginx-drift.diff 2>&1; then
  log "DRIFT: live config differs from the committed snapshot."
  log "       Refresh the snapshot after reviewing the change:"
  log "         ssh <host> 'cat $LIVE_PATH' > $SNAPSHOT_PATH"
  if [ "$QUIET" -eq 0 ]; then
    log ""
    log "--- committed snapshot (-) vs live (+) ---"
    cat /tmp/nginx-drift.diff
  fi
  status=1
else
  log "OK: live nginx config matches the committed snapshot."
fi

exit "$status"
