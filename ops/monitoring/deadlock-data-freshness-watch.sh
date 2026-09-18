#!/usr/bin/env bash
#
# Watch the freshness of the data a build is made from.
#
# Why this exists: on 2026-09-17 the app produced no build at all for hours and
# nothing anywhere said so. Two separate things had quietly stopped: the global
# collection was hanging (so no new evidence was written) and statlocker had
# rolled to a new patch the archetype snapshots were not built for. Both were
# invisible - the status endpoint still reported a recent `lastSuccessAt`,
# because that field is shared with the per-hero path, and the collection's
# errors were being swallowed.
#
# The lesson is not "refresh more often" - the refresh does run every 30 minutes.
# It is that a refresh which stops working looks exactly like a healthy one until
# someone compares the data's age against the cadence it is supposed to have.
# This script makes that comparison on a schedule.
#
# Exit codes: 0 = everything fresh, 1 = something stale (so `systemctl --failed`
# shows it too, and the timer's OnFailure path can act on it).
#
# Configuration: /etc/deadlock-data-freshness.env (optional), sourced if present.
#   DISCORD_WEBHOOK_URL=      post alerts to a Discord webhook
#   ALERT_CMD=                arbitrary command, receives <level> <message>
#   DEADLOCK_DB_CONTAINER, DEADLOCK_DB_NAME, DEADLOCK_DB_USER
#   DEADLOCK_GLOBAL_MAX_AGE_SEC   global datasets (default 7200 = 2h)
#   DEADLOCK_WPA_MAX_AGE_SEC      matchup rows (default 129600 = 36h)
#   DEADLOCK_ARCHETYPE_MAX_AGE_SEC archetype snapshots (default 129600 = 36h)
#   DEADLOCK_REMIND_MIN            re-alert interval while still bad (default 120)
#   DEADLOCK_STATE_FILE           (default /var/lib/deadlock-data-freshness/state)
#   DEADLOCK_FRESHNESS_TEST_ALERT=1  mark the alert as a deliberate test
#
# The file is sourced BEFORE the defaults are resolved, so a value in the file
# wins. Precedence is the same as the health watch: the file beats an exported
# variable, so for a one-off override point DEADLOCK_FRESHNESS_CONF at a scratch
# file rather than exporting.
#
set -uo pipefail

TAG="deadlock-data-freshness"
CONF="${DEADLOCK_FRESHNESS_CONF:-/etc/deadlock-data-freshness.env}"

if [ -r "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

# Reuse the webhook the other units already have, so rotating it stays a
# one-place change. An explicit export still wins.
if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  ALERT_ENV="${DEADLOCK_ALERT_ENV:-/etc/deadlock-health-watch.env}"
  if [ -r "$ALERT_ENV" ]; then
    # shellcheck disable=SC1090
    . "$ALERT_ENV"
  fi
fi

DB_CONTAINER="${DEADLOCK_DB_CONTAINER:-aboba-telegramovich-postgres-1}"
DB_NAME="${DEADLOCK_DB_NAME:-deadlock_builds}"
DB_USER="${DEADLOCK_DB_USER:-postgres}"

# Thresholds are a multiple of the cadence, not the app's own staleness limit.
# The app stops trusting evidence after 4 days; alerting at 4 days would mean
# finding out only once the recommendation had already degraded. These fire
# within a handful of missed cycles instead.
GLOBAL_MAX_AGE="${DEADLOCK_GLOBAL_MAX_AGE_SEC:-7200}"
WPA_MAX_AGE="${DEADLOCK_WPA_MAX_AGE_SEC:-129600}"
ARCHETYPE_MAX_AGE="${DEADLOCK_ARCHETYPE_MAX_AGE_SEC:-129600}"
REMIND_MIN="${DEADLOCK_REMIND_MIN:-120}"
STATE_FILE="${DEADLOCK_STATE_FILE:-/var/lib/deadlock-data-freshness/state}"
TEST_ALERT="${DEADLOCK_FRESHNESS_TEST_ALERT:-0}"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

problems=()

sql() {
  # One value per line, no headers, no pager. `docker exec -i` gives the
  # container the SQL on stdin; without -i psql reads the terminal instead.
  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAq -v ON_ERROR_STOP=1 2>/dev/null
}

db_reachable=1
probe="$(printf 'select 1;' | sql)"
[ "$probe" = "1" ] || db_reachable=0

if [ "$db_reachable" -eq 0 ]; then
  problems+=("database ${DB_NAME} in ${DB_CONTAINER} is unreachable")
else
  # --- 1. global evidence datasets -------------------------------------------
  # These refresh unconditionally every 30 minutes, whatever the player activity,
  # so any real age here means the collection stopped.
  while IFS='|' read -r dataset age; do
    [ -n "${dataset:-}" ] || continue
    case "$age" in ''|*[!0-9]*) continue ;; esac
    if [ "$age" -gt "$GLOBAL_MAX_AGE" ]; then
      problems+=("evidence ${dataset} is ${age}s old (max ${GLOBAL_MAX_AGE}s)")
    fi
  done <<EOF
$(printf '%s' "select \"dataset\", extract(epoch from (now() - max(\"fetchedAt\")))::bigint from statlocker_evidence_snapshots_v1 where \"dataset\" in ('WPA_PATCH_DATA','T4_CHAINS') group by 1;" | sql)
EOF

  # --- 2. matchup rows --------------------------------------------------------
  # VS_HERO_WPA is relational-only: the evidence table cannot hold it, which is
  # why its own row there always reads as unavailable and is not a signal. The
  # published raw snapshot is the real source.
  wpa_age="$(printf '%s' "select coalesce(extract(epoch from (now() - max(\"fetchedAt\")))::bigint, -1) from statlocker_vs_hero_wpa_raw_snapshots_v1 where \"ingestStatus\" = 'PUBLISHED';" | sql)"
  case "$wpa_age" in
    ''|*[!0-9-]*) problems+=("matchup rows: could not read the published snapshot age") ;;
    -1) problems+=("matchup rows: no PUBLISHED snapshot at all") ;;
    *) [ "$wpa_age" -gt "$WPA_MAX_AGE" ] && problems+=("matchup rows are ${wpa_age}s old (max ${WPA_MAX_AGE}s)") ;;
  esac

  # --- 3. archetype snapshots -------------------------------------------------
  archetype_age="$(printf '%s' "select coalesce(extract(epoch from (now() - max(\"publishedAt\")))::bigint, -1) from build_archetype_snapshots_v2 where \"isActive\";" | sql)"
  case "$archetype_age" in
    ''|*[!0-9-]*) problems+=("archetype snapshots: could not read the newest age") ;;
    -1) problems+=("archetype snapshots: none active") ;;
    *) [ "$archetype_age" -gt "$ARCHETYPE_MAX_AGE" ] && problems+=("archetype snapshots are ${archetype_age}s old (max ${ARCHETYPE_MAX_AGE}s)") ;;
  esac

  # --- 4. can the app actually build for the patch it will resolve? -----------
  # This is the check that would have caught the 2026-09-17 outage outright.
  #
  # The app resolves ONE patch id for the whole identity, from the newest
  # evidence row, and then asks for the archetype snapshot and the matchup rows
  # under that patch. After a patch rollover the datasets straddle: on
  # 2026-09-17 the evidence sat on 698776157349216434 while all 145 snapshots
  # were on 676255623445218601, `getActive` found nothing, and every request
  # answered BUILD_ARCHETYPE_V2_UNAVAILABLE.
  #
  # Deliberately NOT a bare "do the newest patches differ" test. A straddle is
  # survivable on its own -- the app falls back to the newest snapshot that
  # exists -- and alerting on every one of them trains you to ignore the alert.
  # What matters is whether data EXISTS for the patch being resolved, which is
  # precisely the question the app is about to ask.
  resolved_patch="$(printf '%s' "select \"statlockerPatchId\" from statlocker_evidence_snapshots_v1 order by \"fetchedAt\" desc limit 1;" | sql)"
  if [ -n "${resolved_patch:-}" ]; then
    archetypes_for_patch="$(printf 'select count(*) from build_archetype_snapshots_v2 where \"isActive\" and \"statlockerPatchId\" = %s;' "'${resolved_patch}'" | sql)"
    case "$archetypes_for_patch" in
      ''|*[!0-9]*) problems+=("could not count archetypes for the resolved patch ${resolved_patch}") ;;
      0) problems+=("no active archetype snapshot for the resolved patch ${resolved_patch} (build may answer BUILD_ARCHETYPE_V2_UNAVAILABLE)") ;;
    esac

    rows_for_patch="$(printf 'select count(*) from statlocker_vs_hero_wpa_rows_v1 where \"statlockerPatchId\" = %s;' "'${resolved_patch}'" | sql)"
    case "$rows_for_patch" in
      ''|*[!0-9]*) problems+=("could not count matchup rows for the resolved patch ${resolved_patch}") ;;
      0) problems+=("no matchup rows for the resolved patch ${resolved_patch} (matchup evidence will be lost)") ;;
    esac
  fi
fi

# --- decide state, and whether this run should speak up ----------------------
now="$(date +%s)"
prev_state=""; prev_notify=0
if [ -r "$STATE_FILE" ]; then
  read -r prev_state prev_notify < "$STATE_FILE" 2>/dev/null || true
fi
case "$prev_notify" in ''|*[!0-9]*) prev_notify=0 ;; esac

if [ "${#problems[@]}" -eq 0 ]; then
  cur="OK"
  detail="all datasets within their cadence"
else
  cur="BAD"
  detail="$(IFS='; '; echo "${problems[*]}")"
fi

level=""
if [ "$cur" = "BAD" ]; then
  if [ "$prev_state" != "BAD" ]; then
    level="ALERT"
  elif [ $(( now - prev_notify )) -ge $(( REMIND_MIN * 60 )) ]; then
    level="STILL-BAD"
  fi
elif [ "$prev_state" = "BAD" ]; then
  level="RECOVERED"
fi

notify() {
  local lvl="$1" msg="$2"
  logger -t "$TAG" "${lvl}: ${msg}"

  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    local esc
    esc="$(printf '%s' "**[${lvl}]** ${msg}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')"
    # --fail matters: without it a 401/404/429 from Discord exits 0 and the
    # alert is silently dropped - the exact failure mode this script exists to stop.
    curl -sS --fail --retry 2 --retry-connrefused -m 10 -o /dev/null \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"${esc}\"}" "$DISCORD_WEBHOOK_URL" \
      || logger -t "$TAG" "notify: discord post FAILED (alert was not delivered)"
  fi

  if [ -n "${ALERT_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $ALERT_CMD "$lvl" "$msg" || logger -t "$TAG" "notify: ALERT_CMD failed"
  fi
}

if [ -n "$level" ]; then
  if [ "$TEST_ALERT" = "1" ]; then
    notify "$level" "TEST ALERT - not an incident: [${TAG}] ${detail}"
    logger -t "$TAG" "TEST ALERT (not an incident): ${detail}"
  else
    notify "$level" "[${TAG}] ${detail}"
  fi
fi

# Persist: keep last_notify only when we actually notified, so the reminder
# interval is measured from the last message, not from the last run.
if [ -n "$level" ]; then
  printf '%s %s\n' "$cur" "$now" > "$STATE_FILE"
else
  printf '%s %s\n' "$cur" "$prev_notify" > "$STATE_FILE"
fi

[ "$cur" = "OK" ] && exit 0
exit 1
