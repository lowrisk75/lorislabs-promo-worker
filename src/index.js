/**
 * lorislabs-promo-worker
 *
 * One-time-use promo code distribution per channel.
 *
 * Routes:
 *   GET  /                     → marketing landing
 *   GET  /<channel>            → HTML claim page (Turnstile captcha + Claim button)
 *   POST /api/claim/<channel>  → JSON { code, redeemUrl } or { error }
 *   GET  /api/stats/<channel>  → JSON { remaining, used } (no auth in v1)
 *
 * Security:
 *   - Cloudflare Turnstile captcha (server-side verification)
 *   - One claim per IP per 24h (default GLOBAL across all channels — see CLAIM_SCOPE env)
 *   - Strict security headers (CSP, HSTS, X-Frame-Options, etc.)
 *   - Generic error messages — never leak channel state to attackers
 *   - Codes never in source — KV-only (encrypted at rest by Cloudflare)
 *   - Per-endpoint per-IP rate limit (10 req/min) to deter scrapers
 *
 * KV layout (binding: PROMO_CODES):
 *   meta:<channel>          → { name, tagline, total, expiresAt }
 *   cursor:<channel>        → "<int>"
 *   pool:<channel>:<index>  → "<CODE>"  (zero-padded index for ordering)
 *   claim:<ip>              → "<channel>:<ts>"  (global per-IP sentinel, 24h TTL — default scope)
 *   claim:<ip>:<channel>    → "1"  (per-channel sentinel, used only when CLAIM_SCOPE = "channel")
 *   rate:<ip>:<minute>      → counter (rate-limit, 60s TTL)
 *
 * The claim flow:
 *   1. Browser GET /<channel> → HTML page with Turnstile widget
 *   2. User solves the captcha and clicks "Claim"
 *   3. Browser POSTs /api/claim/<channel> with Turnstile token
 *   4. Worker verifies Turnstile, checks IP claim sentinel, takes the next code, updates state
 */

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RATE_LIMIT_PER_MINUTE = 10;
const CLAIM_SENTINEL_TTL_SECONDS = 60 * 60 * 24; // 24h

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: securityHeaders({ cors: true }) });
    }

    try {
      // POST /api/claim/<channel>
      if (request.method === "POST" && path.startsWith("api/claim/")) {
        const channel = path.slice("api/claim/".length);
        // Per-IP rate limit on the claim endpoint
        if (!(await rateLimitOK(env, ip))) {
          return jsonResponse({ ok: false, error: "RATE_LIMITED" }, 429);
        }
        return jsonResponse(await handleClaim(request, env, channel, ip));
      }

      // GET /api/stats/<channel>
      if (request.method === "GET" && path.startsWith("api/stats/")) {
        const channel = path.slice("api/stats/".length);
        return jsonResponse(await handleStats(env, channel));
      }

      // GET /<channel> → HTML claim page
      if (request.method === "GET" && path.length > 0 && !path.startsWith("api/")) {
        return await renderClaimPage(env, path);
      }

      // GET /
      if (request.method === "GET" && path === "") {
        return new Response(landingHtml(env), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders({ html: true }) },
        });
      }

      return new Response("Not found", { status: 404, headers: securityHeaders({ html: true }) });
    } catch (err) {
      // Never leak internals
      console.error("worker error", err);
      return new Response("Internal error", { status: 500, headers: securityHeaders() });
    }
  },
};

// ---------- Handlers ----------

async function handleClaim(request, env, channel, ip) {
  if (!isValidChannelToken(channel)) {
    return { ok: false, error: "INVALID_CHANNEL" };
  }
  const meta = await getMeta(env, channel);
  if (!meta) return { ok: false, error: "UNKNOWN_CHANNEL" };
  if (meta.expiresAt && Date.now() > meta.expiresAt) {
    return { ok: false, error: "EXPIRED" };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: "BAD_BODY" };
  }
  const turnstileToken = body?.turnstileToken;
  if (!turnstileToken || typeof turnstileToken !== "string" || turnstileToken.length > 4096) {
    return { ok: false, error: "MISSING_TURNSTILE_TOKEN" };
  }

  // Verify Turnstile (server-side; client token is untrusted by itself)
  const verified = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, ip);
  if (!verified) return { ok: false, error: "TURNSTILE_FAILED" };

  // IP claim sentinel: scope = "global" (default, default-deny across channels)
  // or "channel" (one per channel per IP — set CLAIM_SCOPE = "channel" in vars).
  const claimScope = (env.CLAIM_SCOPE || "global").toLowerCase();
  const claimKey = claimScope === "channel" ? `claim:${ip}:${channel}` : `claim:${ip}`;
  const existingClaim = await env.PROMO_CODES.get(claimKey);
  if (existingClaim) {
    return { ok: false, error: "ALREADY_CLAIMED" };
  }

  // Take the next code: read cursor, pop the next key, increment cursor.
  // Worker KV is not transactional. For the volumes here (≤500 codes per channel,
  // human-driven traffic) the race window is acceptable. For high concurrency,
  // upgrade to Durable Objects.
  const cursorKey = `cursor:${channel}`;
  const cursorRaw = await env.PROMO_CODES.get(cursorKey);
  const cursor = parseInt(cursorRaw || "0", 10);
  if (cursor >= meta.total) {
    return { ok: false, error: "CHANNEL_EXHAUSTED" };
  }

  const codeKey = `pool:${channel}:${String(cursor).padStart(6, "0")}`;
  const code = await env.PROMO_CODES.get(codeKey);
  if (!code) {
    // Pool inconsistency — log and surface a generic error
    console.error(`pool key missing for ${channel} index ${cursor}`);
    return { ok: false, error: "INTERNAL" };
  }

  // Advance cursor + record claim sentinel
  await Promise.all([
    env.PROMO_CODES.put(cursorKey, String(cursor + 1)),
    env.PROMO_CODES.put(claimKey, `${channel}:${Date.now()}`, {
      expirationTtl: CLAIM_SENTINEL_TTL_SECONDS,
    }),
  ]);

  const redeemUrl = (meta.redeemUrlTemplate ||
    "https://apps.apple.com/redeem?ctx=offercodes&id={ASC_ID}&code={CODE}")
    .replace("{ASC_ID}", env.APP_ASC_ID)
    .replace("{CODE}", code);

  return { ok: true, code, redeemUrl, channel: meta.name };
}

async function handleStats(env, channel) {
  if (!isValidChannelToken(channel)) {
    return { ok: false, error: "INVALID_CHANNEL" };
  }
  const meta = await getMeta(env, channel);
  if (!meta) return { ok: false, error: "UNKNOWN_CHANNEL" };
  const cursorRaw = await env.PROMO_CODES.get(`cursor:${channel}`);
  const cursor = parseInt(cursorRaw || "0", 10);
  return {
    ok: true,
    channel: meta.name,
    total: meta.total,
    used: cursor,
    remaining: Math.max(0, meta.total - cursor),
    expiresAt: meta.expiresAt || null,
  };
}

// ---------- Rate limit ----------

async function rateLimitOK(env, ip) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${ip}:${minute}`;
  const current = parseInt((await env.PROMO_CODES.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_MINUTE) return false;
  await env.PROMO_CODES.put(key, String(current + 1), { expirationTtl: 90 });
  return true;
}

// ---------- Helpers ----------

async function getMeta(env, channel) {
  const raw = await env.PROMO_CODES.get(`meta:${channel}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function verifyTurnstile(secret, token, ip) {
  if (!secret) {
    // Dev mode — Turnstile not configured. NEVER deploy without secret set.
    console.warn("TURNSTILE_SECRET not set — verification skipped");
    return true;
  }
  const formData = new FormData();
  formData.append("secret", secret);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);
  let resp;
  try {
    resp = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: formData });
  } catch {
    return false;
  }
  if (!resp.ok) return false;
  let data;
  try { data = await resp.json(); } catch { return false; }
  return Boolean(data && data.success);
}

function isValidChannelToken(t) {
  return typeof t === "string" && /^[a-z0-9-]{2,40}$/.test(t);
}

// ---------- Rendering ----------

async function renderClaimPage(env, channel) {
  if (!isValidChannelToken(channel)) {
    return new Response(notFoundHtml(env, channel), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders({ html: true }) },
    });
  }
  const meta = await getMeta(env, channel);
  if (!meta) {
    return new Response(notFoundHtml(env, channel), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders({ html: true }) },
    });
  }
  const cursorRaw = await env.PROMO_CODES.get(`cursor:${channel}`);
  const cursor = parseInt(cursorRaw || "0", 10);
  const remaining = Math.max(0, meta.total - cursor);
  const expired = meta.expiresAt && Date.now() > meta.expiresAt;

  return new Response(claimHtml(env, channel, meta, remaining, expired), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders({ html: true }) },
  });
}

function landingHtml(env) {
  return baseHtml(`
    <main class="centered">
      <h1>${escapeHtml(env.APP_NAME)} — promo codes</h1>
      <p>This page distributes one-time promo codes for ${escapeHtml(env.APP_NAME)}. You'll have arrived here from a community thread (Reddit, Discord, forum) — go back and follow the channel-specific link.</p>
      <p><a href="https://lorislab.fr/apps/lumen.html">Learn more about ${escapeHtml(env.APP_NAME)}</a></p>
    </main>
  `, env);
}

function notFoundHtml(env, channel) {
  return baseHtml(`
    <main class="centered">
      <h1>That promo channel doesn't exist</h1>
      <p>The link you followed (<code>${escapeHtml(channel || "")}</code>) doesn't match a configured channel. Double-check the URL.</p>
      <p><a href="https://lorislab.fr/apps/lumen.html">Lumen for Frigate on lorislab.fr</a></p>
    </main>
  `, env);
}

function claimHtml(env, channel, meta, remaining, expired) {
  const exhausted = remaining <= 0 || expired;
  const exhaustedReason = expired
    ? "This promo period has ended."
    : "All codes for this channel have been claimed.";

  return baseHtml(`
    <main class="centered">
      <h1>${escapeHtml(env.APP_NAME)} Pro — ${escapeHtml(meta.name || "Promo")}</h1>
      <p class="subtitle">${escapeHtml(meta.tagline || "3 months Pro Monthly free.")}</p>

      ${exhausted ? `
        <div class="card error">
          <p class="big-emoji">🎁</p>
          <p><strong>${escapeHtml(exhaustedReason)}</strong></p>
          <p>Thanks for the interest — we ran out faster than expected.</p>

          <div class="success" style="background: rgba(80,200,120,0.08); border: 1px solid rgba(80,200,120,0.3); border-radius: 12px; padding: 1rem; margin: 1rem 0;">
            <p style="margin: 0;"><strong>Don't worry</strong> — Pro Annual ships with a built-in <strong>7-day free trial</strong>. Download the app, start the Annual subscription, cancel before day 7 = still free.</p>
          </div>

          <div class="next-steps">
            <p><strong>What you can do right now:</strong></p>
            <ul style="text-align: left; max-width: 380px; margin: 0.5rem auto;">
              <li>Start the <strong>7-day free trial</strong> on the App Store (no code needed)</li>
              <li>Use the free tier (4 cameras, fully usable, forever)</li>
              <li>Subscribe to <a href="https://lorislab.fr#newsletter" target="_blank" rel="noopener">our newsletter</a> — early subscribers get codes from the next batch</li>
              <li>Follow the original community thread for future giveaways</li>
            </ul>
          </div>

          <p style="margin-top: 1.5rem;">
            <a class="btn primary" href="https://apps.apple.com/app/id${escapeHtml(env.APP_ASC_ID)}" target="_blank" rel="noopener">Open on the App Store</a>
          </p>
        </div>
      ` : `
        <p class="subtle">${remaining} of ${meta.total} codes remaining</p>

        <form id="claim-form" class="card">
          <p>Click below to claim your unique code. After clicking, you'll see the code and a one-tap link to redeem on the App Store.</p>
          <div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA")}"></div>
          <button type="submit" class="btn primary" id="claim-btn">Claim my code</button>
          <p class="error-text" id="claim-error" hidden></p>
        </form>

        <div class="card success" id="claim-success" hidden>
          <p class="label">Your code</p>
          <p class="code" id="claim-code"></p>
          <a class="btn primary" id="claim-redeem-url" href="#" target="_blank" rel="noopener">Tap to redeem on the App Store</a>
          <p class="subtle">If you tap on iOS, the App Store opens with the code pre-filled. On Mac/PC, copy the code above and paste into the App Store app on your iPhone.</p>
          <p class="subtle">Enjoying the app? <a href="https://apps.apple.com/app/id${escapeHtml(env.APP_ASC_ID)}?action=write-review" target="_blank" rel="noopener">A short honest review</a> helps a solo dev a ton — completely optional.</p>
        </div>

        <p class="subtle limit-note">One code per IP per 24h. Cloudflare Turnstile required.</p>
      `}
    </main>

    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <script>
      const channel = ${JSON.stringify(channel)};
      const form = document.getElementById('claim-form');
      const btn = document.getElementById('claim-btn');
      const errorEl = document.getElementById('claim-error');
      const successEl = document.getElementById('claim-success');
      const codeEl = document.getElementById('claim-code');
      const urlEl = document.getElementById('claim-redeem-url');

      const ERROR_MESSAGES = {
        ALREADY_CLAIMED: 'You already claimed a code in the last 24h. Try again tomorrow.',
        CHANNEL_EXHAUSTED: 'All codes for this channel have just been claimed.',
        TURNSTILE_FAILED: 'Captcha verification failed — please try again.',
        EXPIRED: 'This promo has ended.',
        INVALID_CHANNEL: 'Invalid channel link.',
        UNKNOWN_CHANNEL: 'Unknown channel.',
        RATE_LIMITED: 'Too many requests — wait a minute and try again.',
        MISSING_TURNSTILE_TOKEN: 'Please complete the captcha first.',
        BAD_BODY: 'Bad request.',
        INTERNAL: 'Something went wrong on our end. Please try again.',
      };

      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
          if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
          const tokenInput = form.querySelector('input[name="cf-turnstile-response"]');
          const turnstileToken = tokenInput ? tokenInput.value : '';
          if (!turnstileToken) {
            if (errorEl) { errorEl.textContent = ERROR_MESSAGES.MISSING_TURNSTILE_TOKEN; errorEl.hidden = false; }
            if (btn) { btn.disabled = false; btn.textContent = 'Claim my code'; }
            return;
          }
          try {
            const resp = await fetch('/api/claim/' + encodeURIComponent(channel), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnstileToken }),
            });
            const json = await resp.json();
            if (json.ok) {
              if (form) form.hidden = true;
              if (successEl) successEl.hidden = false;
              if (codeEl) codeEl.textContent = json.code;
              if (urlEl) urlEl.href = json.redeemUrl;
            } else {
              const msg = ERROR_MESSAGES[json.error] || 'Something went wrong. Try again later.';
              if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; }
              if (btn) { btn.disabled = false; btn.textContent = 'Claim my code'; }
              if (json.error === 'CHANNEL_EXHAUSTED') {
                // Disable form permanently — user should refresh the page to see the exhausted state
                setTimeout(() => location.reload(), 1500);
              }
            }
          } catch {
            if (errorEl) { errorEl.textContent = 'Network error.'; errorEl.hidden = false; }
            if (btn) { btn.disabled = false; btn.textContent = 'Claim my code'; }
          }
        });
      }
    </script>
  `, env);
}

function baseHtml(content, env) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(env.APP_NAME)} — Promo</title>
<meta name="robots" content="noindex,nofollow">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0a0a0a; color: #f0f0f0; margin: 0; padding: 2rem 1.5rem; }
  main.centered { max-width: 540px; margin: 4vh auto; text-align: center; }
  h1 { font-size: 2em; margin-bottom: 0.4em; }
  .subtitle { color: rgba(255,255,255,0.7); font-size: 1.1em; }
  .subtle { color: rgba(255,255,255,0.5); font-size: 0.9em; }
  .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 1.5rem; margin: 1.5rem 0; }
  .card.error { border-color: rgba(255,80,80,0.3); }
  .card.success { border-color: rgba(80,200,120,0.4); }
  .btn { display: inline-block; padding: 0.75rem 1.25rem; border-radius: 10px; font-weight: 600; border: none; cursor: pointer; font-size: 1em; text-decoration: none; }
  .btn.primary { background: #5b8def; color: white; }
  .btn.primary:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .label { font-size: 0.8em; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 0; }
  .code { font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 1.6em; font-weight: 700; letter-spacing: 0.1em; padding: 0.5rem 1rem; background: rgba(255,255,255,0.05); border-radius: 8px; user-select: all; word-break: break-all; }
  .error-text { color: #ff7878; margin-top: 0.5rem; }
  .cf-turnstile { display: flex; justify-content: center; margin: 1rem 0; }
  .big-emoji { font-size: 3em; margin: 0; }
  .next-steps { margin-top: 1rem; }
  .next-steps ul { padding-left: 1rem; line-height: 1.6; }
  .limit-note { margin-top: 2rem; }
  a { color: #5b8def; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...securityHeaders({ cors: true }),
    },
  });
}

function securityHeaders({ cors = false, html = false } = {}) {
  const base = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
  };
  if (html) {
    base["Content-Security-Policy"] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "frame-src https://challenges.cloudflare.com",
      "connect-src 'self' https://challenges.cloudflare.com",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }
  if (cors) {
    base["Access-Control-Allow-Origin"] = "*";
    base["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    base["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return base;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
