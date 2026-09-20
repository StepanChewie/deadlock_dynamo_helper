#!/usr/bin/env bash
# Validate the Overwolf manifest against the official schema.
#
# The schema is the one Overwolf points at from
# https://dev.overwolf.com/ow-native/reference/manifest/validate-your-manifest-json
# and ajv-cli is the tool their own automated-validation example uses.
#
# Note: ajv-cli writes everything, errors included, to stderr - capturing only
# stdout yields an empty file and a check that silently reports nothing.
#
# Exit codes: 0 = valid, 1 = invalid or the check could not run.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="${OVERWOLF_SCHEMA:-/tmp/overwolf-manifest-schema.json}"
MANIFEST="${1:-$SCRIPT_DIR/../public/manifest.json}"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if [ ! -r "$SCHEMA" ]; then
  curl -sS -o "$SCHEMA" \
    "https://raw.githubusercontent.com/overwolf/community-gists/master/overwolf-manifest-schema.json" \
    || { echo "could not download the Overwolf schema"; exit 1; }
fi

if [ ! -r "$MANIFEST" ]; then
  echo "manifest not found: $MANIFEST"
  exit 1
fi

npx --yes ajv-cli@5 validate -s "$SCHEMA" -d "$MANIFEST" --spec=draft7 >"$OUT" 2>&1
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "manifest is valid against the official Overwolf schema"
  exit 0
fi

echo "manifest is INVALID against the official Overwolf schema:"
grep -E "instancePath|additionalProperty|message" "$OUT" | sed 's/^ *//'
exit 1
