#!/usr/bin/env python3
"""One-shot migration: rewrite all `meta:<channel>` JSON in KV to include
`appName` + `appASCID`, so the worker no longer needs the APP_NAME /
APP_ASC_ID global env vars.

Uses the OAuth token stored at `~/.wrangler/config/default.toml` (set
by `wrangler login`) and talks to the Cloudflare API directly. Avoids
the wrangler CLI's stdout noise that breaks JSON parsing.

Idempotent — re-running with already-migrated values is a no-op."""

import json
import re
import sys
import urllib.request
from pathlib import Path

ACCOUNT_ID = "4c3e2b246dc1b838e47ed33cbbe3a39c"
NAMESPACE_ID = "25b9b4e8368d46989057e6052db3e120"  # PROMO_CODES (production)
WRANGLER_CFG = Path.home() / ".wrangler" / "config" / "default.toml"

LUMEN_NAME = "Lumen for Frigate"
LUMEN_ASCID = "6760238729"

CHANNELS = [
    "frigate-may",
    "frigate-discord-may",
    "ha-may",
    "ha-forum-may",
    "hacf-may",
    "homelab-may",
    "newsletter-may",
    "reserve-may",
]


def load_oauth_token() -> str:
    text = WRANGLER_CFG.read_text()
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', text)
    if not m:
        sys.exit(f"Could not find oauth_token in {WRANGLER_CFG}")
    return m.group(1)


def cf_request(method: str, path: str, token: str, body: str | None = None) -> dict:
    url = f"https://api.cloudflare.com/client/v4{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = body.encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}


def kv_get(channel: str, token: str) -> dict | None:
    path = f"/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}/values/meta:{channel}"
    url = f"https://api.cloudflare.com/client/v4{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    return json.loads(raw)


def kv_put(channel: str, value: dict, token: str) -> None:
    """Bulk endpoint accepts plain values; use the bulk endpoint for safety."""
    path = f"/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}/bulk"
    payload = json.dumps([{"key": f"meta:{channel}", "value": json.dumps(value, ensure_ascii=False)}])
    resp = cf_request("PUT", path, token, payload)
    if not resp.get("success", False):
        sys.exit(f"PUT failed for {channel}: {resp}")


def main() -> None:
    token = load_oauth_token()
    print(f"Loaded OAuth token (account {ACCOUNT_ID[:8]}...)")
    changed = 0
    skipped = 0
    missing = 0
    for ch in CHANNELS:
        meta = kv_get(ch, token)
        if meta is None:
            print(f"  ✗ meta:{ch} not found")
            missing += 1
            continue
        was_changed = False
        if meta.get("appName") != LUMEN_NAME:
            meta["appName"] = LUMEN_NAME
            was_changed = True
        if meta.get("appASCID") != LUMEN_ASCID:
            meta["appASCID"] = LUMEN_ASCID
            was_changed = True
        if was_changed:
            kv_put(ch, meta, token)
            changed += 1
            print(f"  ✓ migrated meta:{ch}")
        else:
            skipped += 1
            print(f"  · already up to date: meta:{ch}")
    print()
    print(f"Done. changed={changed}, skipped={skipped}, missing={missing}")


if __name__ == "__main__":
    main()
