#!/usr/bin/env bash
#
# Upload promo codes from local .txt files into Cloudflare KV.
#
# Usage:
#   bash scripts/upload-codes.sh <channel> <name> <tagline> <path-to-codes.txt> [expires-iso]
#
# Examples:
#   bash scripts/upload-codes.sh frigate-may "r/frigate_nvr May 2026" "3 months Pro Monthly free, courtesy of LorisLabs" \
#       "/Users/kevinnadjarian/GitHub/Lumen for Frigate/audit-output/promo-codes-may2026/01-reddit-frigate_nvr.txt"
#   bash scripts/upload-codes.sh hacf-may "HACF Mai 2026" "3 mois Pro Monthly gratuits" \
#       "/Users/kevinnadjarian/GitHub/Lumen for Frigate/audit-output/promo-codes-may2026/05-hacf-macgen-fr.txt"
#
# Requires: wrangler CLI authenticated against the lorislab CF account.
# Reads the KV namespace name from wrangler.toml (binding `PROMO_CODES`).

set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <channel-token> <name> <tagline> <path-to-codes.txt> [expires-iso]"
  exit 1
fi

CHANNEL="$1"
NAME="$2"
TAGLINE="$3"
CODES_FILE="$4"
EXPIRES_ISO="${5:-}"

if [[ ! -f "$CODES_FILE" ]]; then
  echo "Error: codes file not found: $CODES_FILE"
  exit 1
fi

if [[ ! "$CHANNEL" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: channel token must be lowercase alphanumeric + hyphens only"
  exit 1
fi

# Strip blank lines and trim whitespace
TOTAL=$(grep -cE "^[A-Z0-9]" "$CODES_FILE" || echo 0)
if [[ "$TOTAL" -lt 1 ]]; then
  echo "Error: no codes found in $CODES_FILE"
  exit 1
fi

echo "Uploading $TOTAL codes for channel '$CHANNEL'…"

# 1) Write meta
EXPIRES_MS=""
if [[ -n "$EXPIRES_ISO" ]]; then
  EXPIRES_MS=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$EXPIRES_ISO" +%s 2>/dev/null || echo "")
  if [[ -n "$EXPIRES_MS" ]]; then
    EXPIRES_MS=$((EXPIRES_MS * 1000))
  fi
fi

META_JSON=$(cat <<EOF
{"name":"$NAME","tagline":"$TAGLINE","total":$TOTAL${EXPIRES_MS:+,"expiresAt":$EXPIRES_MS}}
EOF
)

wrangler kv:key put --binding=PROMO_CODES "meta:$CHANNEL" "$META_JSON" --remote
wrangler kv:key put --binding=PROMO_CODES "cursor:$CHANNEL" "0" --remote

# 2) Write each code as a numbered key (zero-padded for lexicographic ordering)
INDEX=0
while IFS= read -r CODE; do
  CODE="$(echo "$CODE" | tr -d '[:space:]')"
  if [[ -z "$CODE" ]]; then continue; fi
  PADDED=$(printf "%06d" "$INDEX")
  wrangler kv:key put --binding=PROMO_CODES "pool:$CHANNEL:$PADDED" "$CODE" --remote
  INDEX=$((INDEX + 1))
done < "$CODES_FILE"

echo "✅ Uploaded $INDEX codes for channel '$CHANNEL'."
echo "   Test the claim page at: https://r.lorislab.fr/$CHANNEL  (or your worker URL)"
echo "   Stats: https://r.lorislab.fr/api/stats/$CHANNEL"
