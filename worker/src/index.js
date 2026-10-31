/*
 *  WarEra tools API proxy - Cloudflare Worker
 *
 *  The browser must never see the game API token, so every game-data
 *  request goes through here: the Worker holds the token(s) as a secret,
 *  injects one server-side, and adds the CORS headers the game API does
 *  not send. Routes:
 *
 *    /trpc/*             -> https://api2.warera.io/trpc/*   (+ x-api-key)
 *    /deal-config-submit -> GitHub repository_dispatch: deal-config-submit
 *    /notify-discord     -> Discord webhook
 */

const GAME_API        = 'https://api2.warera.io/trpc';

// The game API 403s on an empty User-Agent, and the client's own UA is
// not forwarded (it identifies the player's browser, not this service).
const UPSTREAM_UA = 'warera-tools-proxy (+https://github.com/hawtre/warera-tools-ireland)';

// Headers we never forward upstream: auth material the client has no
// business setting (we supply our own), and hop-by-hop / CF-managed ones.
const STRIPPED = new Set([
  'x-api-key', 'authorization', 'cookie', 'host', 'origin', 'referer',
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'user-agent',
]);

/*
 *  API key pool
 *
 *  The game API rate-limits per key, so several keys can be pooled to raise
 *  the ceiling. Keys are picked uniformly at random per request rather than
 *  drained one at a time, minimising state, keeping each key further from its
 *  limits, and leaving some headroom free for bursts of requests.
 *
 *  A key that does come back 429 is parked in `cooling` and skipped until it
 *  expires. That map is per-isolate, so each isolate relearns a bad key within
 *  a request or two.
 *
 *  Some procedures (work.getStatsByCompany, work.getStatsByUserId) only answer
 *  keys whose account has Premium, and 403 "Premium required" otherwise. The
 *  pool learns both sides from those errors: the procedure goes into
 *  `premiumProcedures`, and the key into `basicKeys` so requests for premium
 *  procedures skip it. Basic keys still serve everything else. The key mark
 *  expires, because an account can buy Premium again.
 */
const cooling = new Map(); // key -> epoch ms at which it may be used again
const basicKeys = new Map(); // key -> epoch ms until which it's treated as non-Premium
const premiumProcedures = new Set();

const COOL_DEFAULT_MS = 60_000;
const COOL_MAX_MS     = 300_000;
const BASIC_KEY_TTL_MS = 3_600_000;
const PREMIUM_REQUIRED = 'Premium required';

// Accepts either the multi-key secret or the original single-key one, so a
// deploy that has not had WARERA_API_KEYS set yet keeps working.
function apiKeys(env) {
  const raw = env.WARERA_API_KEYS || env.WARERA_API_KEY || '';
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}

function isCooling(key, now) {
  const until = cooling.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    cooling.delete(key);
    return false;
  }
  return true;
}

/*
 *  Prefers a key that is neither cooling nor already tried on this request.
 *  Falls back to any untried key, then to anything at all: a request against
 *  a rate-limited key still has a chance of succeeding (the window may have
 *  rolled over), which beats returning an error we invented ourselves.
 */
function isBasic(key, now) {
  const until = basicKeys.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    basicKeys.delete(key);
    return false;
  }
  return true;
}

/*
 *  For a request that needs Premium, keys known to lack it are dropped first,
 *  unless that leaves none: then the request goes out anyway and the client
 *  sees the game's own "Premium required" error.
 */
function pickKey(keys, tried, needsPremium = false) {
  const now = Date.now();
  if (needsPremium) {
    const premium = keys.filter(k => !isBasic(k, now));
    if (premium.length) keys = premium;
  }
  const fresh = keys.filter(k => !tried.includes(k) && !isCooling(k, now));
  const untried = fresh.length ? fresh : keys.filter(k => !tried.includes(k));
  const pool = untried.length ? untried : keys;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Retry-After is either delta-seconds or an HTTP date; anything unparseable
// falls back to the default cooldown.
function coolFor(header) {
  if (!header) return COOL_DEFAULT_MS;
  const secs = Number(header);
  const ms = Number.isFinite(secs)
    ? secs * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return COOL_DEFAULT_MS;
  return Math.min(ms, COOL_MAX_MS);
}

function markCooling(key, retryAfter) {
  cooling.set(key, Date.now() + coolFor(retryAfter));
}

/*
 *  Seconds until the first key in the pool frees up, for the Retry-After we
 *  hand back on a pool-wide 429. Falls back to the default cooldown if
 *  nothing is parked (the limit was hit without us recording it).
 */
function soonestCooldownSecs(keys) {
  const now = Date.now();
  const waits = keys.map(k => cooling.get(k)).filter(u => u !== undefined && u > now);
  const ms = waits.length ? Math.min(...waits) - now : COOL_DEFAULT_MS;
  return Math.max(1, Math.ceil(ms / 1000));
}

function coolingCount(keys) {
  const now = Date.now();
  return keys.filter(k => isCooling(k, now)).length;
}

function basicCount(keys) {
  const now = Date.now();
  return keys.filter(k => isBasic(k, now)).length;
}

/*
 *  Account-scoped procedures answer for whoever owns the API key. Through
 *  this proxy that's a random key from the pool, so they'd hand the pool
 *  owners' employees, events and jobs to anyone who asked, and a different
 *  account each time. Mutations would act on those accounts. Neither is
 *  forwarded. Tools that need a player's own data call the game API from the
 *  browser with that player's key instead.
 *
 *  Matches getMe, getMine and getMy* in any namespace, every
 *  employeeEvent procedure (getHistory only answers for the key's own
 *  employees), and the inventory procedures that answer for the key
 *  owner only.
 */
const ACCOUNT_SCOPED = [
  /\.get(?:Me|Mine|My)(?![a-z])/, /^employeeEvent\./,
  // Owner-scoped without the naming: they take no input and answer for the key.
  /^inventory\.(?:getManageableInventories(?:EntitiesIds)?|equippedItems)(?![a-z])/,
];
const accountScoped = procs => procs.find(p => ACCOUNT_SCOPED.some(re => re.test(p)));

// tRPC batches name several procedures in one path: /a.b,c.d?batch=1.
function procedures(path) {
  let decoded = path.replace(/^\//, '');
  try { decoded = decodeURIComponent(decoded); } catch { /* keep it raw */ }
  return decoded.split(',').filter(Boolean);
}

/*
 *  Procedures a 403/207 body says need Premium. A whole-request failure is a
 *  single error envelope; a batch is an array with one envelope per item.
 */
function premiumFailures(text) {
  if (!text.includes(PREMIUM_REQUIRED)) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(item => item?.error?.message === PREMIUM_REQUIRED)
    .map(item => item.error.data?.path)
    .filter(Boolean);
}

/*
 *  ALLOWED_ORIGINS is a comma-separated list. A request with no Origin
 *  (curl, the GitHub Actions log scripts) is allowed through - CORS only
 *  constrains browsers, and blocking it would break the data logs.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : false;
}

function corsHeaders(origin) {
  const h = new Headers();
  if (origin) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
  } else {
    h.set('Access-Control-Allow-Origin', '*');
  }
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  // The upstream rate-limit headers pass through untouched, but a browser
  // hides response headers from fetch() unless they're listed here. shared.js
  // reads Retry-After to decide how long to wait after a 429 (the game API
  // allows 500 requests per minute per token), so without this the tools can
  // see the 429 but not how long the window has left, and back off blind.
  h.set('Access-Control-Expose-Headers',
    'retry-after, ratelimit-limit, ratelimit-remaining, ratelimit-reset, ratelimit-policy');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(body, status, origin) {
  const h = corsHeaders(origin);
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers: h });
}

/*
 *  Upstream proxy. `keys` is the API key pool for token-gated upstreams; pass
 *  null for the ones that need no auth.
 */
async function proxy(request, env, origin, base, prefix, keys = null) {
  const url = new URL(request.url);
  const path = url.pathname.slice(prefix.length); // keeps the leading '/'
  const target = `${base}${path}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('User-Agent', UPSTREAM_UA);

  // Buffer the body rather than streaming it through. These are small tRPC
  // JSON payloads, and a streamed ReadableStream body needs the `duplex`
  // option, which is not portable across the Workers and Node fetch stacks.
  // Buffering also makes the key-failover retry below possible at all.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  // One retry on 429 or "Premium required", on a different key. More than
  // that would just queue up behind a limit that is ours in aggregate, and
  // the client retries too.
  const maxAttempts = keys ? Math.min(2, keys.length) : 1;
  const procs = procedures(path);
  const tried = [];
  let upstream;
  let bufferedBody = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let key = null;
    if (keys) {
      const needsPremium = procs.some(p => premiumProcedures.has(p));
      key = pickKey(keys, tried, needsPremium);
      tried.push(key);
      headers.set('x-api-key', key);
    }

    try {
      upstream = await fetch(target, { method: request.method, headers, body });
    } catch (err) {
      // Network-level failure. 502 so shared.js isTransientError retries it.
      return json({ error: { message: `upstream unreachable: ${err.message}` } }, 502, origin);
    }

    bufferedBody = null;
    if (!key) break;

    if (upstream.status === 403 || upstream.status === 207) {
      bufferedBody = await upstream.text();
      const failed = premiumFailures(bufferedBody);
      if (!failed.length) break;
      failed.forEach(p => premiumProcedures.add(p));
      basicKeys.set(key, Date.now() + BASIC_KEY_TTL_MS);
      // Retry only if some untried key might have Premium.
      const now = Date.now();
      if (!keys.some(k => !tried.includes(k) && !isBasic(k, now))) break;
      continue;
    }

    if (upstream.status !== 429) break;

    markCooling(key, upstream.headers.get('Retry-After'));
    // Last attempt: pass the 429 through, so shared.js sees the real status.
    if (attempt === maxAttempts) break;
    upstream.body?.cancel();
  }

  // Pass the upstream status and body through untouched - the tools read
  // tRPC's own error envelope, and shared.js keys retry off the status.
  const out = new Headers(upstream.headers);
  for (const [name, value] of corsHeaders(origin)) out.set(name, value);
  out.delete('set-cookie');
  // A body read for inspection is already decoded, so its length and
  // encoding headers no longer describe it.
  if (bufferedBody !== null) {
    out.delete('content-length');
    out.delete('content-encoding');
  }

  // Pool-wide 429: tell the client how long the whole pool is parked for, so
  // it can say something better than "HTTP 429". Upstream's own Retry-After
  // wins if it sent one.
  if (upstream.status === 429 && keys && !out.has('Retry-After')) {
    out.set('Retry-After', String(soonestCooldownSecs(keys)));
  }
  return new Response(bufferedBody ?? upstream.body, { status: upstream.status, headers: out });
}

// GitHub repository_dispatch
async function dispatch(request, env, origin, eventType) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
  if (!env.GITHUB_DISPATCH_TOKEN) return json({ error: 'dispatch not configured' }, 503, origin);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin);
  }

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UPSTREAM_UA,
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    return json({ error: `github dispatch failed (${res.status}): ${detail}` }, 502, origin);
  }
  return json({ ok: true }, 202, origin);
}

// Discord dispatch
async function notifyDiscord(request, env, origin) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
  if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'discord not configured' }, 503, origin);

  const body = await request.text();
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UPSTREAM_UA },
    body,
  });
  if (!res.ok) return json({ error: `discord failed (${res.status})` }, 502, origin);
  return json({ ok: true }, 202, origin);
}

// Router
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (origin === false) {
      return json({ error: 'origin not allowed' }, 403, null);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/healthz') {
      const keys = apiKeys(env);
      return json({
        ok: true,
        token: keys.length > 0,
        keys: keys.length,
        cooling: coolingCount(keys),
        // Keys seen answering "Premium required" in this isolate.
        basic: basicCount(keys),
        premiumProcedures: [...premiumProcedures],
      }, 200, origin);
    }
    if (url.pathname.startsWith('/trpc/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: { message: 'Only queries (GET) are proxied; mutations would act on the pool keys\' accounts' } }, 405, origin);
      }
      const blocked = accountScoped(procedures(url.pathname.slice('/trpc'.length)));
      if (blocked) {
        return json({ error: { message: `${blocked} answers for the API key's owner, so it isn't proxied. Call it with your own key.` } }, 403, origin);
      }
      const keys = apiKeys(env);
      if (!keys.length) return json({ error: 'game API token not configured' }, 503, origin);
      return proxy(request, env, origin, GAME_API, '/trpc', keys);
    }
    if (url.pathname === '/deal-config-submit') {
      return dispatch(request, env, origin, 'deal-config-submit');
    }
    if (url.pathname === '/notify-discord') {
      return notifyDiscord(request, env, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
