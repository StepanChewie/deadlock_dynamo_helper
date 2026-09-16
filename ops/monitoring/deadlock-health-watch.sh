#!/usr/bin/env bash
#
# Watch the Dynamo Lab API container for the two signals that actually failed on
# 2026-09-16, when the container was unusable for 30 hours and nothing noticed.
#
# Why the obvious monitor is not enough: this service answers HTTP 200 with normal
# latency even when it cannot fork, because Node serves requests without forking.
# A plain HTTP/uptime check stays green through the entire outage. The signals that
# do move are the container's own health status (its healthcheck forks `node -e`)
# and the cgroup task counter.
#
# Exit codes: 0 = OK, 1 = problem detected (so `systemctl --failed` shows it too).
#
# Configuration: /etc/deadlock-health-watch.env (optional), sourced if present.
#   DISCORD_WEBHOOK_URL=  post alerts to a Discord webhook
#   ALERT_CMD=            arbitrary command, receives <level> <message>
#   KUMA_PUSH_URL=        Uptime Kuma push URL; pushed up/down explicitly
# Thresholds (environment, with defaults):
#   DEADLOCK_CONTAINER, DEADLOCK_PIDS_WARN, DEADLOCK_REMIND_MIN
#
set -uo pipefail

CONTAINER="${DEADLOCK_CONTAINER:-deadlock_dynamo_helper-api-1}"
PIDS_WARN="${DEADLOCK_PIDS_WARN:-500}"
REMIND_MIN="${DEADLOCK_REMIND_MIN:-60}"
CONF="${DEADLOCK_CONF:-/etc/deadlock-health-watch.env}"
STATE_FILE="${DEADLOCK_STATE_FILE:-/var/lib/deadlock-health-watch/state}"
TAG="deadlock-health-watch"

if [ -r "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

problems=()

# --- 1. is it even running? -------------------------------------------------
state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
[ "$state" = "running" ] || problems+=("container state=${state}")

# --- 2. docker's own health verdict ----------------------------------------
# This is the signal that was red for 1843 consecutive checks while nothing watched it.
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo unknown)"
streak="$(docker inspect -f '{{if .State.Health}}{{.State.Health.FailingStreak}}{{else}}0{{end}}' "$CONTAINER" 2>/dev/null || echo 0)"
[ "$health" = "healthy" ] || problems+=("health=${health} failingStreak=${streak}")

# --- 3. cgroup task counter -------------------------------------------------
# Catches the accumulation BEFORE the ceiling is reached, which is the whole point:
# at pids.current == pids.max every fork() returns EAGAIN and the healthcheck can
# never recover on its own.
cid="$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || echo '')"
pids=""; pmax=""
if [ -n "$cid" ]; then
  scope="/sys/fs/cgroup/system.slice/docker-${cid}.scope"
  pids="$(cat "${scope}/pids.current" 2>/dev/null || echo '')"
  pmax="$(cat "${scope}/pids.max" 2>/dev/null || echo '')"
fi
if [ -z "$pids" ]; then
  problems+=("pids=unreadable (scope missing or unreadable)")
else
  if [ "$pids" -gt "$PIDS_WARN" ] 2>/dev/null; then
    problems+=("pids=${pids} above warn=${PIDS_WARN} (max=${pmax})")
  fi
fi

# --- decide state, and whether this run should speak up ---------------------
now="$(date +%s)"
prev_state=""; prev_notify=0
if [ -r "$STATE_FILE" ]; then
  read -r prev_state prev_notify < "$STATE_FILE" 2>/dev/null || true
fi
case "$prev_notify" in ''|*[!0-9]*) prev_notify=0 ;; esac

if [ "${#problems[@]}" -eq 0 ]; then
  cur="OK"
  detail="health=${health} pids=${pids}/${pmax}"
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
    curl -sS -m 10 -o /dev/null -H 'Content-Type: application/json' \
      -d "{\"content\":\"${esc}\"}" "$DISCORD_WEBHOOK_URL" \
      || logger -t "$TAG" "notify: discord post failed"
  fi

  if [ -n "${ALERT_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $ALERT_CMD "$lvl" "$msg" || logger -t "$TAG" "notify: ALERT_CMD failed"
  fi
}

if [ -n "$level" ]; then
  notify "$level" "[${CONTAINER}] ${detail}"
fi

# Uptime Kuma push: report explicitly both ways so the monitor reflects reality
# rather than relying on the absence of a ping.
if [ -n "${KUMA_PUSH_URL:-}" ]; then
  if [ "$cur" = "OK" ]; then
    curl -sS -m 10 -o /dev/null "${KUMA_PUSH_URL}?status=up&msg=OK&ping=" \
      || logger -t "$TAG" "notify: kuma push failed"
  else
    curl -sS -m 10 -o /dev/null "${KUMA_PUSH_URL}?status=down&msg=$(printf '%s' "$detail" | sed 's/ /%20/g')" \
      || logger -t "$TAG" "notify: kuma push failed"
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
