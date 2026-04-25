# lorislabs-promo-worker

Cloudflare Worker for distributing one-time-use promo codes per channel for LorisLabs apps.

## What it does

Each Reddit / Discord / forum thread links to a unique URL like `r.lorislab.fr/<channel-token>`. Visitors solve a Cloudflare Turnstile captcha, click "Claim", and receive a code from that channel's pool. Codes are stored in Cloudflare KV (encrypted at rest), never in this repo. One claim per IP per channel per 24h.

## Architecture

```
GET  /<channel>             → HTML claim page (Turnstile captcha + Claim button)
POST /api/claim/<channel>   → returns one unique code from the pool, decrements cursor
GET  /api/stats/<channel>   → public usage counter
```

KV layout (binding: `PROMO_CODES`):
- `meta:<channel>` → `{ name, tagline, total, expiresAt }`
- `cursor:<channel>` → next index to hand out (integer string)
- `pool:<channel>:<index>` → one code per key, 6-digit zero-padded index
- `claim:<ip>:<channel>` → 24h sentinel preventing double-claim

## Deployment

### One-time setup

```bash
cd ~/GitHub/lorislabs-promo-worker
npm install

# 1. Create the KV namespace
wrangler kv:namespace create PROMO_CODES
# → copy the returned id and preview_id into wrangler.toml
wrangler kv:namespace create PROMO_CODES --preview

# 2. Set Turnstile secret (free at https://dash.cloudflare.com/?to=/:account/turnstile)
wrangler secret put TURNSTILE_SECRET
# (paste your Turnstile site secret when prompted)

# 3. Update wrangler.toml: replace TURNSTILE_SITE_KEY with your Turnstile site key (public)

# 4. Deploy
wrangler deploy
```

After deploy, the worker runs at `https://lorislabs-promo-worker.<your-cf-account>.workers.dev`.

### Custom domain `r.lorislab.fr`

In Cloudflare dashboard:
1. Add a CNAME for `r.lorislab.fr` pointing to the worker.
2. Or in `wrangler.toml` uncomment the `routes` block (requires the lorislab.fr zone to be on Cloudflare DNS — it's currently on Hostinger, so the CNAME approach is cleaner).

Alternatively, on Hostinger DNS create a CNAME `r → lorislabs-promo-worker.<account>.workers.dev` and let CF claim that hostname.

## Loading codes for a channel

```bash
# Lumen for Frigate, r/frigate_nvr May 2026
bash scripts/upload-codes.sh \
  frigate-may \
  "r/frigate_nvr May 2026" \
  "3 months Pro Monthly free, courtesy of LorisLabs." \
  "/Users/kevinnadjarian/GitHub/Lumen for Frigate/audit-output/promo-codes-may2026/01-reddit-frigate_nvr.txt"

# HACF (FR)
bash scripts/upload-codes.sh \
  hacf-may \
  "HACF Mai 2026" \
  "3 mois Pro Monthly gratuits — la communauté HACF a la priorité." \
  "/Users/kevinnadjarian/GitHub/Lumen for Frigate/audit-output/promo-codes-may2026/05-hacf-macgen-fr.txt"
```

The script writes meta + cursor + each code to KV. Codes never leave the local filesystem in plaintext beyond the upload step.

## Channel URLs to use in posts

After uploading, distribute these URLs in the matching threads:

- r/frigate_nvr → `https://r.lorislab.fr/frigate-may`
- Frigate Discord → `https://r.lorislab.fr/frigate-discord-may`
- r/HomeAssistant → `https://r.lorislab.fr/ha-may`
- HA Community Forum → `https://r.lorislab.fr/ha-forum-may`
- HACF (FR) → `https://r.lorislab.fr/hacf-may`
- r/homelab → `https://r.lorislab.fr/homelab-may`
- Newsletter → `https://r.lorislab.fr/newsletter-may` (or include code inline via Buttondown merge tag)

## Monitoring

```bash
# Tail the live worker
wrangler tail

# Check stats
curl https://r.lorislab.fr/api/stats/frigate-may
# → {"ok":true,"channel":"r/frigate_nvr May 2026","total":50,"used":12,"remaining":38}
```

## Limitations / future improvements

- **Race condition** at `cursor:<channel>` (KV is not transactional). For low-volume one-time
  distribution (≤500 codes per channel) this is fine — the window is microseconds. For
  high-concurrency use, replace with Durable Objects (single-writer per channel).
- **One-claim-per-IP** (24h) is good enough for community giveaways. Bot operators behind a NAT
  can't grab >1 per channel per 24h. Determined adversaries with rotating IPs can — Turnstile
  catches most of them, but consider adding email-gate for high-value pools.
- **No admin UI**. Stats only via `/api/stats/<channel>`. Add a basic admin token if needed.

## Local dev

```bash
wrangler dev
# Then open http://127.0.0.1:8787/test-channel
```

Without `TURNSTILE_SECRET` set, the verifier returns true so you can test the claim flow locally.

## Costs

Cloudflare Workers free tier: 100k requests/day. KV free tier: 100k reads, 1k writes, 1GB storage. This use case is well under both limits.
