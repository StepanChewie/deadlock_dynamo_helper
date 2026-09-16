#!/usr/bin/env bash
#
# Nightly logical backup of the deadlock_builds database.
#
# Why a FULL dump rather than the schema-only dump the roadmap originally
# proposed: that plan was written when adaptive_recommendation_decisions_v1 held
# 73 GB of TOAST. After the 2026-09-16 cleanup the entire database is ~125 MB
# across 32 tables (largest: statlocker_vs_hero_wpa_rows_v1 at 78 MB), so a
# complete compressed dump costs almost nothing and is strictly more useful than
# a schema-only one. Measured, not assumed:
#
#   select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class ...
#
# The dump is verified with `pg_restore --list` before it is kept. An unverified
# backup is indistinguishable from no backup: it can be a zero-byte file, or a
# partial one from a dump that died halfway.
#
# Install: see ops/backups/README.md.
#
# Exit codes: 0 = a verified dump exists, 1 = backup failed (alert sent).

set -uo pipefail

TAG="deadlock-db-backup"

# Source the config BEFORE resolving defaults: resolving first would freeze the
# values and silently ignore every threshold set in the file.
CONF="${DEADLOCK_BACKUP_CONF:-/etc/deadlock-db-backup.env}"
if [ -r "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

CONTAINER="${DEADLOCK_BACKUP_CONTAINER:-aboba-telegramovich-postgres-1}"
DB_NAME="${DEADLOCK_BACKUP_DB:-deadlock_builds}"
DB_USER="${DEADLOCK_BACKUP_USER:-postgres}"
BACKUP_DIR="${DEADLOCK_BACKUP_DIR:-/var/backups/deadlock}"
KEEP="${DEADLOCK_BACKUP_KEEP:-7}"

# The webhook is not duplicated in this file: reuse the one the health watcher
# already has, so rotating it stays a one-place change. Explicit override first.
if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  ALERT_ENV="${DEADLOCK_ALERT_ENV:-/etc/deadlock-health-watch.env}"
  if [ -r "$ALERT_ENV" ]; then
    # shellcheck disable=SC1090
    . "$ALERT_ENV"
  fi
fi

notify() {
  local message="$1"
  [ -n "${DISCORD_WEBHOOK_URL:-}" ] || return 0

  # --fail matters: without it a 401/404/429 exits 0 and the alert is silently
  # dropped, which is the failure mode that hid the previous outage.
  local escaped
  escaped="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  curl -sS --fail --retry 2 --retry-connrefused -m 10 -o /dev/null \
    -H 'Content-Type: application/json' \
    -d "{\"content\":\"${escaped}\"}" "$DISCORD_WEBHOOK_URL" \
    || logger -t "$TAG" "notify: discord post FAILED (alert was not delivered)"
}

fail() {
  logger -t "$TAG" "FAILED: $1"
  echo "$1" >&2
  notify "[$TAG] backup FAILED: $1"
  exit 1
}

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="${BACKUP_DIR}/${DB_NAME}-${timestamp}.dump"
partial="${target}.partial"

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  fail "database container ${CONTAINER} is not running"
fi

mkdir -p "$BACKUP_DIR" || fail "cannot create ${BACKUP_DIR}"
rm -f "$partial"

# -Fc is the custom format: compressed, and restorable selectively with
# pg_restore. Dumping inside the container avoids needing a client on the host.
if ! docker exec -i "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$partial" 2>"/tmp/${TAG}-pgdump.err"; then
  detail="$(tail -n 3 "/tmp/${TAG}-pgdump.err" 2>/dev/null | tr '\n' ' ')"
  rm -f "$partial"
  fail "pg_dump exited non-zero: ${detail:-no stderr}"
fi

if [ ! -s "$partial" ]; then
  rm -f "$partial"
  fail "pg_dump produced an empty file"
fi

# Verification: the archive must be readable and must actually contain tables.
# `--list` parses the archive, so a truncated dump fails here rather than at
# restore time.
if ! docker exec -i "$CONTAINER" pg_restore --list < "$partial" > "/tmp/${TAG}-toc.txt" 2>&1; then
  detail="$(tail -n 3 "/tmp/${TAG}-toc.txt" 2>/dev/null | tr '\n' ' ')"
  rm -f "$partial"
  fail "pg_restore could not read the archive: ${detail:-no output}"
fi

table_count="$(grep -c 'TABLE DATA' "/tmp/${TAG}-toc.txt" 2>/dev/null || echo 0)"
if [ "$table_count" -lt 1 ]; then
  rm -f "$partial"
  fail "archive verified but contains no table data"
fi

mv "$partial" "$target" || fail "cannot move the dump into place"
size="$(du -h "$target" | cut -f1)"

# Retention: keep the newest $KEEP dumps, delete the rest.
pruned=0
while [ "$(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.dump" | wc -l)" -gt "$KEEP" ]; do
  oldest="$(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.dump" -printf '%T@ %p\n' | sort -n | head -n 1 | cut -d' ' -f2-)"
  [ -n "$oldest" ] || break
  rm -f "$oldest"
  pruned=$((pruned + 1))
done

logger -t "$TAG" "OK: ${target} (${size}, ${table_count} tables, pruned ${pruned})"
echo "backup ok: ${target} (${size}, ${table_count} tables, pruned ${pruned})"
exit 0
