#!/usr/bin/env bash
#
# Bulk-upload ALL channels for the May 2026 Lumen promo distribution.
# Builds one JSON bulk file per channel and uploads via wrangler kv:bulk put.
#
# Channels:
#   frigate-may          (50)   r/frigate_nvr
#   frigate-discord-may  (50)   Frigate Discord
#   ha-may               (100)  r/HomeAssistant
#   ha-forum-may         (50)   Home Assistant Forum
#   hacf-may             (80)   HACF (FR)
#   homelab-may          (50)   r/homelab
#   newsletter-may       (20)   Newsletter
#   reserve-may          (99)   Reserve / opportunistic

set -euo pipefail

unset CLOUDFLARE_API_TOKEN || true
unset CLOUDFLARE_ACCOUNT_ID || true

ROOT="/Users/kevinnadjarian/GitHub/lorislabs-promo-worker"
SRC="/Users/kevinnadjarian/GitHub/Lumen for Frigate/audit-output/promo-codes-may2026"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
TMP="$ROOT/.tmp-bulk"

mkdir -p "$TMP"

upload_channel() {
  local channel="$1"
  local name="$2"
  local tagline="$3"
  local file="$4"
  local app_name="${5:-$DEFAULT_APP_NAME}"
  local app_ascid="${6:-$DEFAULT_APP_ASCID}"

  if [[ -z "$app_name" || -z "$app_ascid" ]]; then
    echo "✗ Missing app context. Set DEFAULT_APP_NAME + DEFAULT_APP_ASCID at the top of the script, or pass arg 5+6 explicitly."
    return 1
  fi

  if [[ ! -f "$file" ]]; then
    echo "✗ Missing: $file"
    return 1
  fi

  local total
  total=$(grep -cE '^[A-Z0-9]' "$file")
  echo "→ $channel ($total codes): $name [app=$app_name]"

  local bulk="$TMP/$channel.json"
  python3 - "$channel" "$name" "$tagline" "$total" "$file" "$bulk" "$app_name" "$app_ascid" <<'PY'
import json, sys, re
channel, name, tagline, total, src, dst, app_name, app_ascid = sys.argv[1:9]
total = int(total)
codes = [c.strip() for c in open(src).read().splitlines() if re.match(r'^[A-Z0-9]', c.strip())]
assert len(codes) == total, f"count mismatch: {len(codes)} vs {total}"
meta = {
    "appName": app_name,
    "appASCID": app_ascid,
    "name": name,
    "tagline": tagline,
    "total": total,
}
out = [
    {"key": f"meta:{channel}",   "value": json.dumps(meta, ensure_ascii=False)},
    {"key": f"cursor:{channel}", "value": "0"},
]
for i, code in enumerate(codes):
    out.append({"key": f"pool:{channel}:{i:06d}", "value": code})
json.dump(out, open(dst, "w"))
print(f"  built bulk file: {dst} ({len(out)} entries)")
PY

  cd "$ROOT"
  "$WRANGLER" kv:bulk put "$bulk" --binding=PROMO_CODES --preview false 2>&1 | tail -5
  echo
}

# Default app context — set these once per run so subsequent
# upload_channel calls inherit. Override per-call via args 5+6.
DEFAULT_APP_NAME="Lumen for Frigate"
DEFAULT_APP_ASCID="6760238729"

upload_channel "frigate-may" \
  "r/frigate_nvr May 2026" \
  "3 months Pro Monthly free, courtesy of LorisLabs." \
  "$SRC/01-reddit-frigate_nvr.txt"

upload_channel "frigate-discord-may" \
  "Frigate Discord May 2026" \
  "3 months Pro Monthly free for the Frigate Discord community." \
  "$SRC/02-frigate-discord.txt"

upload_channel "ha-may" \
  "r/HomeAssistant May 2026" \
  "3 months Pro Monthly free — Home Assistant friends first." \
  "$SRC/03-reddit-homeassistant.txt"

upload_channel "ha-forum-may" \
  "Home Assistant Forum May 2026" \
  "3 months Pro Monthly free, courtesy of LorisLabs." \
  "$SRC/04-ha-community-forum.txt"

upload_channel "hacf-may" \
  "HACF Mai 2026" \
  "3 mois Pro Monthly gratuits — la communauté HACF a la priorité." \
  "$SRC/05-hacf-macgen-fr.txt"

upload_channel "homelab-may" \
  "r/homelab May 2026" \
  "3 months Pro Monthly free for r/homelab." \
  "$SRC/06-reddit-homelab.txt"

upload_channel "newsletter-may" \
  "Newsletter May 2026" \
  "Thanks for subscribing — 3 months Pro Monthly on us." \
  "$SRC/07-newsletter.txt"

upload_channel "reserve-may" \
  "Reserve May 2026" \
  "3 months Pro Monthly free." \
  "$SRC/08-reserve-opportunistic.txt"

echo "✅ All channels uploaded."
echo "   Verify: curl https://r.lorislab.fr/api/stats/frigate-may"
