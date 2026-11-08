/* ═══════════════════════════════════════════════════════════════════
 *  SHARED UTILITIES
 *  Loaded before every tool. Defines the data layer (trpc proxy),
 *  formatting helpers, and the step/status panel constructors used by
 *  MU and the Advisor.
 * ═══════════════════════════════════════════════════════════════════ */
/*
 *  Every external API the site touches goes through one Cloudflare Worker,
 *  and WORKER_BASE is the only place its origin is configured — the route
 *  constants below and each tool's own Worker URLs all derive from it.
 *
 *  On localhost it points at `wrangler dev` (worker/README.md) so local work
 *  runs on a development API key instead of production's quota. Aim a page
 *  at a different Worker with ?proxy=<origin>, before or inside the hash:
 *  #advisor?proxy=https://warera-proxy.0x5ca1ab1e.workers.dev
 *  Nothing is stored: router.js moves a hash ?proxy= in front of the '#',
 *  where every hash rewrite keeps it, so the override lasts exactly as long
 *  as it is in the address bar. Deleting it reloads the page without it.
 *
 *  The param is `proxy`, not `worker`: a "worker" in this game is a player
 *  (see worker.getWorkers, clock-in wages), so ?worker=<username> is an easy
 *  thing to type by mistake. Anything that isn't an http(s) URL is ignored
 *  with a console warning.
 */
const WORKER_PROD = 'https://warera-proxy.0x5ca1ab1e.workers.dev';
const WORKER_BASE = (() => {
  const isProxyUrl = v => {
    try {
      const { protocol } = new URL(v);
      return protocol === 'http:' || protocol === 'https:';
    } catch { return false; }
  };

  const hashQuery = location.hash.split('?')[1] || '';
  const raw = new URLSearchParams(hashQuery).get('proxy')
           || new URLSearchParams(location.search).get('proxy');
  if (raw && isProxyUrl(raw)) return raw.replace(/\/+$/, '');
  if (raw) console.warn(`ignoring ?proxy=${raw} — not an http(s) URL`);
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://localhost:8787'
    : WORKER_PROD;
})();

const API_BASE         = `${WORKER_BASE}/trpc`;
const GAME_BASE        = 'https://app.warera.io';

// The game colours a company by its product's rarity (gameConfig
// items[code].rarity): gray, green, blue, purple, yellow, red. The
// --tr-<rarity> colours live in styles.css.
const RARITY_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const rarityColour = rarity => RARITY_TIERS.includes(rarity) ? `var(--tr-${rarity})` : 'var(--muted)';

// Canonical Ireland country ID. Shared by the MU tool's citizenship
// filter and the Irish-only gate on personal tools (clockin, advisor).
const IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe';

/*
 *  v0.27 pause. War Era v0.27 replaced the player job market with NPC
 *  employees, which broke every tool below. Their
 *  views show a notice instead of activating, and links to them are greyed
 *  out. The notice's "Continue anyway" button runs the tool regardless, for
 *  this page load only. Delete a route from this set once it's rebuilt.
 */
const V027_PAUSED = new Set([
  'profit', 'profit-dev', 'sp-advisor', 'factory-tax',
  'buddy', 'tax', 'tax-dev',
]);
const isPaused = view => V027_PAUSED.has(view);
const V027_CONTINUED = new Set();
// Whether the router/shell should hold the tool back from activating.
const isHeld = view => isPaused(view) && !V027_CONTINUED.has(view);

// Grey out tool cards and shell tabs that lead to a paused route.
function markPausedLinks(root = document) {
  root.querySelectorAll('.tool-card, .stg-tab').forEach(el => {
    const route = el.dataset.stgTab || el.dataset.prev || (el.getAttribute('href') || '').slice(1).split('?')[0];
    if (!isPaused(route) || el.classList.contains('is-paused')) return;
    el.classList.add('is-paused');
    el.title = 'Paused while it is updated for War Era v0.27';
    const h3 = el.querySelector('h3');
    if (h3) h3.insertAdjacentHTML('beforeend', ' <span class="v027-pill">Updating for v0.27</span>');
  });
}

// Swap each paused view's content for a notice. The notice lives inside the
// view, so it moves with it when the home shell hosts the view.
function pauseViews() {
  V027_PAUSED.forEach(view => {
    const el = document.querySelector(`.view[data-view="${view}"]`);
    if (!el || el.classList.contains('is-paused')) return;
    el.classList.add('is-paused');
    el.insertAdjacentHTML('afterbegin', `<div class="v027-paused">
      <h2>🔧 Updating for War Era v0.27</h2>
      <p>This tool is paused. It was built on the old player job market (workers, wages and fidelity), which v0.27 replaced with NPC employees. It'll be back once it's rebuilt for the new system.</p>
      <p>You can still open it, but expect wrong numbers or parts that fail to load.</p>
      <button class="btn-primary" type="button" data-v027-continue="${view}">Continue anyway</button>
    </div>`);
  });
  markPausedLinks();
}

// Unhide the view and re-run the current route, so the router (or the home
// shell, for tools hosted inside it) activates the tool as normal.
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-v027-continue]');
  if (!btn) return;
  const view = btn.dataset.v027Continue;
  V027_CONTINUED.add(view);
  const el = document.querySelector(`.view[data-view="${view}"]`);
  if (el) { el.classList.remove('is-paused'); el.querySelector('.v027-paused')?.remove(); }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
/*
 *  Recently loaded players, shared by every tool with a username box.
 *  One unbounded list in localStorage, most recent first, deduped
 *  case-insensitively. Tools call remember() only with a verified, canonical
 *  username, so typos never land here. Each chip row shows the first SHOWN
 *  names behind a "+N more" toggle; Clear all appears once the whole list is
 *  showing and asks for a second click. Every mounted row re-renders when the
 *  list changes, in this tab or another. Storage failures degrade to no chips.
 *
 *  The list is the only record of players: its first name is the active
 *  player, which the router loads into a tool opened without ?u=. Removing
 *  the active player (or Clear all) marks nobody active until the next load,
 *  drops ?u= from the URL and reloads, so every tool comes back empty.
 */
const RecentPlayers = (() => {
  const KEY = 'warera:recent-players';
  // Set when the active player is removed; the next remember() clears it.
  const NONE_KEY = 'warera:recent-players:none-active';
  const SHOWN = 5;
  // Per-tool lists from before the list was shared; merged once, then dropped.
  const LEGACY = ['stg', 'dash', 'wm', 'dp', 'dpd', 'tr'].map(p => `${p}:recent-usernames`);
  const mounts = new Map();   // chip row element → { expanded }

  const parse = raw => {
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()) : []; }
    catch { return []; }
  };
  const dedupe = list => {
    const seen = new Set();
    return list.filter(u => { const k = u.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage off */ }
  }
  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw != null) return parse(raw);
      const merged = dedupe(LEGACY.flatMap(k => parse(localStorage.getItem(k))));
      write(merged);
      LEGACY.forEach(k => localStorage.removeItem(k));
      localStorage.removeItem('warera:last-loaded-account');   // replaced by active()
      return merged;
    } catch { return []; }
  }
  function render(el) {
    const list = read();
    const state = mounts.get(el);
    el.classList.toggle('hidden', !list.length);
    if (!list.length) { el.innerHTML = ''; return; }
    const hidden = state.expanded ? 0 : Math.max(0, list.length - SHOWN);
    const chips = list.slice(0, list.length - hidden).map(u => {
      const s = escapeHtml(u);
      return `<span class="stg-recent-chip"><button type="button" class="stg-recent-pick" data-recent-pick="${s}">${s}</button><button type="button" class="stg-recent-del" data-recent-del="${s}" aria-label="Remove ${s} from recent players" title="Remove">×</button></span>`;
    }).join('');
    const toggle = list.length > SHOWN
      ? `<button type="button" class="stg-recent-more" data-recent-toggle aria-expanded="${state.expanded}">${hidden ? `+${hidden} more` : 'Show less'}</button>`
      : '';
    const clear = hidden ? '' : '<button type="button" class="stg-recent-clear" data-recent-clear>Clear all</button>';
    el.innerHTML = '<span class="stg-recent-label">Recent:</span>' + chips + toggle + clear;
  }
  const refresh = () => mounts.forEach((_, el) => render(el));
  function remember(name) {
    const u = (name || '').trim();
    if (!u) return;
    write([u, ...read().filter(x => x.toLowerCase() !== u.toLowerCase())]);
    try { localStorage.removeItem(NONE_KEY); } catch { /* storage off */ }
    refresh();
  }
  /** The active player: the most recent one, unless it was removed since. */
  function active() {
    try { if (localStorage.getItem(NONE_KEY)) return ''; } catch { /* storage off */ }
    return read()[0] || '';
  }
  const urlPlayer = () => hashParams().get('u') || new URLSearchParams(location.search).get('u') || '';
  // Mark nobody active, take ?u= out of the URL and reload: every tool then
  // starts empty, without each needing its own way to unload a player.
  function unload() {
    try { localStorage.setItem(NONE_KEY, '1'); } catch { /* storage off */ }
    const [view, hq = ''] = location.hash.split('?');
    const hp = new URLSearchParams(hq);
    const sp = new URLSearchParams(location.search);
    hp.delete('u');
    sp.delete('u');
    const search = sp.toString() ? `?${sp}` : '';
    const hash = view + (hp.toString() ? `?${hp}` : '');
    history.replaceState(history.state, '', location.pathname + search + hash);
    location.reload();
  }
  function forget(name) {
    const match = u => u.toLowerCase() === name.toLowerCase();
    // Showing in this page means loaded: the active one, or the one in the URL.
    const loaded = match(active()) || match(urlPlayer());
    write(read().filter(x => !match(x)));
    if (loaded) unload(); else refresh();
  }
  function clear() {
    const loaded = active() || urlPlayer();
    write([]);
    if (loaded) { unload(); return; }
    mounts.forEach(state => { state.expanded = false; });
    refresh();
  }
  /** Render the chips into el and keep them current; onPick(username) loads one. */
  function mount(el, onPick) {
    if (!el || mounts.has(el)) return;
    const state = { expanded: false };
    mounts.set(el, state);
    el.addEventListener('click', e => {
      const del = e.target.closest('[data-recent-del]');
      if (del) { forget(del.dataset.recentDel); return; }
      if (e.target.closest('[data-recent-toggle]')) { state.expanded = !state.expanded; render(el); return; }
      const clr = e.target.closest('[data-recent-clear]');
      if (clr) {
        // First click arms it; the second clears.
        if (clr.dataset.armed) { clear(); return; }
        clr.dataset.armed = '1';
        clr.textContent = 'Clear all?';
        return;
      }
      const pick = e.target.closest('[data-recent-pick]');
      if (pick) onPick(pick.dataset.recentPick);
    });
    // Moving away disarms Clear all.
    const disarm = e => {
      const clr = e.target.closest?.('[data-recent-clear][data-armed]');
      if (clr) { delete clr.dataset.armed; clr.textContent = 'Clear all'; }
    };
    el.addEventListener('mouseout', disarm);
    el.addEventListener('focusout', disarm);
    render(el);
  }
  window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) refresh(); });
  return { remember, forget, clear, mount, refresh, active };
})();

/*
 *  Browser crypto (crypto.subtle, crypto.randomUUID) exists only on a secure
 *  page: https://, or http:// on localhost. Plain http:// on any other
 *  address (a LAN or tailnet IP, say) withholds it, and the tool would fail
 *  with a bare TypeError. Returns what to tell the user, or null when the
 *  page is secure. `what` starts the sentence: 'Unlocking this tool'.
 */
function insecurePageMessage(what) {
  if (window.isSecureContext) return null;
  return `${what} needs a secure page: open it over https:// or on localhost. Plain http:// on any other address turns off the browser encryption it relies on.`;
}

// One formatter, reused: toLocaleString with options builds a new one each
// call, which is tens of times slower over a big table.
const FMT_NUM = new Intl.NumberFormat(undefined, {maximumFractionDigits: 0});
function fmtNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return FMT_NUM.format(v);
  return String(v);
}
function fmt(v, dp = 2) {
  if (!isFinite(v)) return '0';
  // Trim trailing zeros after the point only: fmt(180, 0) is "180", not "18".
  return v.toFixed(dp).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
function flag(code) {
  if (!code || code.length !== 2) return '🌐';
  return code.toUpperCase().split('').map(c =>
    String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1F1E6)
  ).join('');
}
function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/*
 *  Hash routing. A route lives in the fragment as #view?params (see
 *  router.js). The page's real query string (?bypass=1, ?proxy=…) sits
 *  before the fragment and has to stay there, so writes rebuild the whole
 *  URL rather than appending location.search after the hash.
 *  replaceState doesn't fire hashchange, so a tool can call writeHash from
 *  inside activate() without looping.
 */
function hashParams() {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}

function writeHash(view, params) {
  const qs = params ? params.toString() : '';
  const hash = qs ? `#${view}?${qs}` : `#${view}`;
  if (location.hash !== hash) {
    history.replaceState(null, '', location.pathname + location.search + hash);
  }
}

/**
 * Read the bypass flag from the URL. Lifts Irish-only restrictions
 * for admin/debugging. Works whether the param sits inside the hash
 * (e.g. #clockin?u=foo&bypass=1) or before it (?bypass=1#clockin).
 */
function hasBypassFlag() {
  return hashParams().get('bypass') === '1'
      || new URLSearchParams(location.search).get('bypass') === '1';
}

/**
 * Enforces the Irish-citizens-only restriction. Throws a friendly
 * error if the user is non-Irish and the bypass flag isn't set.
 * Pass null/undefined country (e.g. unresolved user) to let it
 * through — the failure mode of the resolution path is its own
 * error and we don't want to double up.
 */
function enforceIrishOnly(country, username) {
  if (hasBypassFlag()) return;
  if (country == null) return;
  if (country === IRELAND_COUNTRY_ID) return;
  throw new Error(`This tool is for Irish citizens only. "${username}" is not an Irish citizen.`);
}

/*
 *  Transient errors are worth retrying. Covers raw HTTP 5xx plus proxy
 *  responses that embed an upstream 5xx in the message body, and 429.
 *
 *  429 belongs here because the game API rate-limits per API token, not per
 *  caller: `ratelimit-policy: 500;w=60`, i.e. 500 requests per rolling
 *  minute, shared by everyone the Worker proxies for. Exceeding it is a
 *  "come back shortly", not a failure of the request - so retrying is right,
 *  but ONLY paired with the Retry-After honouring in _retryDelayMs(). A 429
 *  retried on the plain 400ms backoff just burns the remaining attempts
 *  inside a window that has ~18s left to run.
 */
function isTransientError(err) {
  if (err?.network || err?.timeout) return true;
  if (err && (err.status === 429 || (err.status >= 500 && err.status < 600))) return true;
  // dataError()s keep the technical text in .detail; their message is for players.
  const msg = `${err?.message || ''} ${err?.detail || ''}`.toLowerCase();
  return /http (429|50[234])|no available server|timed? ?out|fetch failed|network ?error/.test(msg);
}

/*
 *  How long to wait before retrying, in ms, or null to stop trying.
 *
 *  A rate-limited response tells us exactly how long to wait, so prefer that
 *  over guessing.
 *
 *  The ceiling has to clear a whole rate-limit window. The policy is 500
 *  requests per 60s, so Retry-After is as large as the window is wide - burn
 *  the quota at the START of a window and the API asks for 59s. A tighter cap
 *  looks reasonable and then quietly defeats the entire retry: measured
 *  against the live API, a 30s cap turned a rate-limited 100-user fetch into
 *  100 nulls without a single retry. Waiting is the lesser evil, because the
 *  alternative is silently wrong data - but the wait is announced via
 *  onRateLimit so a tool can say so rather than appear hung.
 *
 *  Note the browser can only read Retry-After if the Worker exposes it via
 *  Access-Control-Expose-Headers (it does). Against a proxy that doesn't,
 *  err.retryAfterMs is simply absent and a 429 falls back to a fixed wait -
 *  still far better than 400ms, which is guaranteed to be too early.
 */
const TRPC_RETRY_MAX_WAIT_MS      = 65_000;  // one full 60s window, plus slack
const TRPC_RATE_LIMIT_WAIT_MS     = 5_000;   // fallback when Retry-After is unreadable

function _retryDelayMs(err, attempt) {
  const advised = err?.retryAfterMs
    ?? (err?.status === 429 ? TRPC_RATE_LIMIT_WAIT_MS : null);
  const delay = advised ?? 400 * attempt;
  return delay > TRPC_RETRY_MAX_WAIT_MS ? null : delay;
}

/*
 *  Read the server's own advice on when to come back. Retry-After is either
 *  seconds or an HTTP date; ratelimit-reset (seconds until the window rolls)
 *  is the fallback the game API also sends.
 */
/*
 *  Announce a rate-limit wait. The tools' step panels are the right place to
 *  surface this, so trpcMany takes an onRateLimit callback; this is the
 *  fallback so a wait is never completely silent.
 */
let _onRateLimit = null;

/** @param {?function(number, number):void} fn Called with (waitMs, itemCount). */
function setRateLimitHandler(fn) { _onRateLimit = typeof fn === 'function' ? fn : null; }

/** @returns {?function} The handler currently installed, if any. */
function getRateLimitHandler() { return _onRateLimit; }

function _trpcRateLimited(waitMs, itemCount, label) {
  if (_onRateLimit) { _onRateLimit(waitMs, itemCount); return; }
  console.warn(`[trpc] rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s`);
}

function _retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw != null && raw !== '') {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const reset = Number(headers?.get?.('ratelimit-reset'));
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000);
  return null;
}

// async function trpc(endpoint, input = {}, { retry = false, timeoutMs = null } = {}, attempt = 1) {
//   const MAX_ATTEMPTS = retry ? 3 : 1;
//   const url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(input))}`;
//   const ctrl = timeoutMs ? new AbortController() : null;
//   const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
//   try {
//     const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
//     if (!res.ok) {
//       const err = new Error(`${endpoint} → HTTP ${res.status}`);
//       err.status = res.status;
//       throw err;
//     }
//     const json = await res.json();
//     if (json && !Array.isArray(json) && json.error) {
//       const msg = json.error.message || json.error.data?.message || 'unknown error';
//       throw new Error(`${endpoint} → ${String(msg).slice(0, 120)}`);
//     }
//     const item = Array.isArray(json) ? json[0] : json;
//     return Object.prototype.hasOwnProperty.call(item?.result ?? {}, 'data')
//       ? item.result.data
//       : item;
//   } catch (e) {
//     if (e.name === 'AbortError') throw new Error(`${endpoint} → timed out`);
//     if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
//       await new Promise(r => setTimeout(r, 400 * attempt));
//       return trpc(endpoint, input, { retry, timeoutMs }, attempt + 1);
//     }
//     throw e;
//   } finally {
//     if (t) clearTimeout(t);
//   }
// }

/* ── Session request cache ──────────────────────────────────────────
 *  In-flight dedup is always on: concurrent identical requests share one
 *  promise (pure win, no staleness). The resolved cache, serving a past
 *  value for idempotent endpoints with a TTL, is OFF by default so the
 *  live tools behave exactly as before (Refresh stays fresh). The toolkit
 *  shell switches it on via setTrpcCache(true) to harmonise calls across
 *  tools and let its background prefetch warm data before a username is
 *  typed, then switches it off (clearing it) on leave. Volatile endpoints
 *  are never resolved-cached.
 */
const TRPC_CACHE_TTL_MS = 90_000;
const TRPC_VOLATILE = new Set([
  'transaction.getPaginatedTransactions',
  'worker.getWorkers',
  'manager.getByCompanyId',
]);
let _trpcCacheOn = false;
let _trpcCacheOwner = null;
const _trpcInflight = new Map();
const _trpcResolved = new Map();

/*
 *  Cap on resolved entries. Per-item caching turns one entry per batch into
 *  one per input, so a few citizen sweeps can hold thousands. The payload is
 *  the same either way - these are the same value objects the coarse entry
 *  held - but the map itself needs a bound, because nothing else evicts:
 *  the TTL is enforced on read, so an entry nobody asks for again would sit
 *  there until setTrpcCache(false) cleared the lot.
 */
const TRPC_CACHE_MAX_ENTRIES = 5_000;

/** Distinguishes "not cached" from a cached null/undefined value. */
const TRPC_CACHE_MISS = Symbol('trpc cache miss');

/*
 *  One key scheme for both modes. A batch item is stored under the key it
 *  would have had as a scalar call, which is what lets the two share: a
 *  batched user.getUserLite fills the cache for a later single lookup of the
 *  same user, and vice versa.
 */
function _trpcKey(endpoint, input, batch = false) {
  return `${batch ? 'batch' : 'single'}|${endpoint}|${JSON.stringify(input ?? {})}`;
}

function _cacheSet(key, value) {
  // Delete first so insertion order tracks most-recent write, making the
  // overflow eviction below drop genuinely old entries rather than
  // frequently-refreshed ones that merely got there early.
  _trpcResolved.delete(key);
  _trpcResolved.set(key, { value, ts: Date.now() });
  if (_trpcResolved.size <= TRPC_CACHE_MAX_ENTRIES) return;

  const now = Date.now();
  for (const [k, entry] of _trpcResolved) {
    if (now - entry.ts >= TRPC_CACHE_TTL_MS) _trpcResolved.delete(k);
  }
  while (_trpcResolved.size > TRPC_CACHE_MAX_ENTRIES) {
    const oldest = _trpcResolved.keys().next().value;
    if (oldest === undefined) break;
    _trpcResolved.delete(oldest);
  }
}

/**
 * Look up one input's cached value.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object} input The single input, in scalar form.
 * @param {boolean} [fresh=false] Skip the read (but keep the entry).
 * @returns {*|symbol} The cached value, or TRPC_CACHE_MISS.
 */
function _trpcCachedItem(endpoint, input, fresh = false) {
  if (fresh || !_trpcResolvable(endpoint)) return TRPC_CACHE_MISS;
  const key = _trpcKey(endpoint, input);
  const entry = _trpcResolved.get(key);
  if (!entry) return TRPC_CACHE_MISS;
  if (Date.now() - entry.ts >= TRPC_CACHE_TTL_MS) {
    _trpcResolved.delete(key);        // evict on read; nothing else sweeps
    return TRPC_CACHE_MISS;
  }
  return entry.value;
}

/*
 *  Store each fulfilled item of a batch under its own key. Rejections are
 *  never cached: a 404 is usually permanent, but a 404 that was really a
 *  blip would otherwise stick for the whole TTL, and the saving isn't worth
 *  serving a wrong absence.
 */
function _cacheBatchItems(endpoint, inputs, settled) {
  if (!_trpcResolvable(endpoint)) return;
  for (let i = 0; i < settled.length; i++) {
    if (settled[i]?.status === 'fulfilled') {
      _cacheSet(_trpcKey(endpoint, inputs[i]), settled[i].value);
    }
  }
}

/**
 * Enable or disable the optional 90-second resolved-value cache.
 *
 * In-flight deduplication is independent of this switch and remains active.
 * Disabling the cache immediately clears all resolved values; it does not
 * cancel requests that are already running. Volatile endpoints listed in
 * TRPC_VOLATILE are never resolved-cached, even while caching is enabled.
 *
 * The cache is a single global owned by one view at a time, and every owner
 * releases it on the way out. Pass an `owner` token so a release only lands
 * if that view still holds it: several views tear down on the same
 * hashchange as the next one mounts, and without this the correctness of the
 * whole scheme rests on the order the listeners happen to be registered in,
 * i.e. on script order in index.html. Reorder two <script> tags and the
 * incoming view's freshly warmed cache gets wiped by the outgoing view's
 * teardown, silently and with no error. An owner-less release is
 * unconditional, preserving the original behaviour for any caller that
 * doesn't care.
 *
 * @param {boolean} on Whether resolved responses may be reused.
 * @param {?string} [owner=null] Token identifying the view; required to make a release conditional.
 * @returns {void}
 */
function setTrpcCache(on, owner = null) {
  if (on) {
    _trpcCacheOwner = owner;
    _trpcCacheOn = true;
    return;
  }
  // A release from a view that no longer holds the cache is stale - ignore it
  // rather than clearing out whoever took over.
  if (owner != null && _trpcCacheOwner !== owner) return;
  _trpcCacheOwner = null;
  _trpcCacheOn = false;
  _trpcResolved.clear();
}

/** @returns {?string} The owner token currently holding the cache, if any. */
function getTrpcCacheOwner() { return _trpcCacheOwner; }

/** @returns {boolean} Whether this endpoint may use the resolved cache. */
function _trpcResolvable(endpoint) {
  return _trpcCacheOn && !TRPC_VOLATILE.has(endpoint);
}

/**
 * Call a game API tRPC query through the shared proxy.
 *
 * Scalar mode (the default):
 *   trpc('user.getUserLite', { userId }, { retry: true })
 *
 * `inputOrInputs` must be one non-array, JSON-serialisable tRPC input. The
 * promise resolves to the unwrapped `result.data` value. Transport, HTTP, and
 * tRPC procedure errors reject the promise.
 *
 * Batch mode:
 *   trpc('user.getUserLite', [{ userId: a }, { userId: b }], { batch: true })
 *
 * `inputOrInputs` must be an array of inputs for the SAME endpoint. One HTTP
 * batch request is sent and the promise resolves to an array in the same order
 * using Promise.allSettled's shape:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 * An item-level error therefore does not reject the whole batch. Keep batches
 * modest because all encoded inputs are placed in the request URL.
 *
 * Exact concurrent calls share one in-flight promise. When setTrpcCache(true)
 * is active, successful results are resolved-cached PER INPUT, under the key
 * that input would have had as a scalar call - so a batch fills the cache for
 * later single lookups and for any overlapping list, and one failed item no
 * longer stops its neighbours being cached. Failed items are never cached.
 * `fresh: true` skips the resolved-cache read but still shares an identical
 * in-flight request and stores the new response.
 *
 * `retry: true` allows up to three attempts for transient failures. For batch
 * mode, a transient item error retries the complete batch; after the final
 * attempt, any remaining item errors are returned as rejected results.
 *
 * @param {string} endpoint tRPC procedure name, e.g. `user.getUserLite`.
 * @param {Object|Object[]|null} [inputOrInputs={}] One input, or an input array when batching.
 *   Pass null for a procedure that takes no input at all: those reject even {}.
 * @param {Object} [options]
 * @param {boolean} [options.batch=false] Send all array entries in one HTTP batch.
 * @param {boolean} [options.retry=false] Retry transient failures, up to three attempts.
 * @param {number|null} [options.timeoutMs=null] Abort each HTTP attempt after this many milliseconds.
 * @param {boolean} [options.fresh=false] Bypass a resolved cached value for this call.
 * @returns {Promise<*>} Unwrapped data in scalar mode; settled results in batch mode.
 * @throws {TypeError} If `batch` is not boolean or the input shape does not match it.
 */
function trpc(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
  fresh = false,
} = {}) {
  if (typeof batch !== 'boolean') throw new TypeError('tRPC batch option must be a boolean');
  if (batch && !Array.isArray(inputOrInputs)) {
    throw new TypeError('Batch tRPC input must be an array');
  }
  if (!batch && Array.isArray(inputOrInputs)) {
    throw new TypeError('Scalar tRPC input must not be an array');
  }
  if (batch && !inputOrInputs.length) return Promise.resolve([]);

  const key = _trpcKey(endpoint, inputOrInputs, batch);

  // Serve a fresh-enough resolved value when caching is on for this endpoint.
  if (_trpcResolvable(endpoint) && !fresh) {
    const hit = _trpcResolved.get(key);
    if (hit && Date.now() - hit.ts < TRPC_CACHE_TTL_MS) return Promise.resolve(hit.value);
  }
  // Share an identical request already in flight.
  if (_trpcInflight.has(key)) return _trpcInflight.get(key);

  const p = _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, 1)
    .then(value => {
      // A batch caches per item rather than as one all-or-nothing blob, so a
      // single bad item no longer discards the other 99, and the successes
      // are reusable by any overlapping list or scalar lookup later.
      if (batch) _cacheBatchItems(endpoint, inputOrInputs, value);
      else if (_trpcResolvable(endpoint)) _cacheSet(key, value);
      return value;
    })
    .finally(() => { _trpcInflight.delete(key); });
  _trpcInflight.set(key, p);
  return p;
}

/*
 *  What players are told when War Era data can't be loaded: plain words, with
 *  no endpoints or status codes. Every tool shows err.message from trpc(), so
 *  this is the one place the wording lives. The technical text (procedure,
 *  status and the server's own reason) goes on err.detail and to the console
 *  for whoever is debugging; isTransientError() reads both.
 */
const DATA_MESSAGES = {
  rateLimited: (secs) => `We've used up our requests to War Era for the moment. ${secs
    ? `They refresh in about ${secs} seconds; try again then.` : 'They refresh within a minute; try again then.'}`,
  originNotAllowed: () => `This copy of the tools isn't allowed to load War Era data. Use the tools at https://we.hawtre.net instead.${
    location.hostname === 'we.hawtre.net' ? '' : ' (Previewing a copy? Add ?proxy=<your Worker URL> to the address.)'}`,
  serverError: () => "War Era's servers aren't answering properly right now. Try again in a minute.",
  refused: () => "War Era didn't provide some of the data this needs. Try again later, and let us know if it keeps happening.",
  unreadable: () => "War Era sent back something we couldn't read. Try again in a minute.",
  timedOut: () => 'War Era took too long to answer. Try again in a minute.',
  unreachable: () => "Couldn't reach our data service. Check your internet connection; if you use an ad or privacy blocker, allow this site.",
};

function dataError(message, detail, props = {}) {
  console.warn(`[trpc] ${detail}`);
  return Object.assign(new Error(message), { detail }, props);
}

function _messageForStatus(status, retryAfterSecs = null) {
  if (status === 429) {
    return DATA_MESSAGES.rateLimited(Number.isFinite(retryAfterSecs) && retryAfterSecs > 0 ? Math.ceil(retryAfterSecs) : null);
  }
  return status >= 500 ? DATA_MESSAGES.serverError() : DATA_MESSAGES.refused();
}

/*
 *  The server's own reason from an error response, for err.detail: the proxy
 *  answers { error: 'text' } or { error: { message } }, and the game's tRPC
 *  errors carry { error: { message } } or { error: { json: { message } } }.
 */
function _apiErrorText(body) {
  const item = Array.isArray(body) ? body[0] : body;
  const e = item?.error;
  const text = typeof e === 'string' ? e : e?.message ?? e?.json?.message ?? e?.data?.message;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : null;
}

function _trpcResponseError(item, label) {
  if (!item?.error) return null;
  const msg = item.error.message || item.error.data?.message || 'unknown error';
  const status = item.error.data?.httpStatus ?? item.error.data?.status ?? item.error.status;
  return dataError(_messageForStatus(status), `${label} → ${String(msg).slice(0, 120)}`,
    Number.isInteger(status) ? { status } : {});
}

function _trpcResponseValue(item) {
  return Object.prototype.hasOwnProperty.call(item?.result ?? {}, 'data')
    ? item.result.data
    : item;
}

/**
 * Build the URL for one same-endpoint batch request.
 *
 * Procedure names are comma-separated and inputs are encoded as a numerically
 * indexed object, as required by the proxy's tRPC batch protocol. Everything
 * rides in the URL, which is why trpcMany() measures this to size its chunks.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object[]} inputs Batch inputs.
 * @returns {string} The absolute request URL.
 */
function _trpcBatchUrl(endpoint, inputs) {
  const endpoints = inputs.map(() => endpoint).join(',');
  const indexedInputs = Object.fromEntries(
    inputs.map((input, index) => [index, input ?? {}])
  );
  return `${API_BASE}/${endpoints}?batch=1&input=${encodeURIComponent(JSON.stringify(indexedInputs))}`;
}

/**
 * Execute one scalar or same-endpoint batch HTTP request.
 *
 * This is the wire-format and retry layer behind trpc(); callers should use
 * trpc() so validation, in-flight deduplication, and resolved caching apply.
 * Inputs have already been validated by trpc(). In batch mode, procedure names
 * are comma-separated and inputs are encoded as a numerically indexed object,
 * as required by the proxy's tRPC batch protocol.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object|Object[]} inputOrInputs Validated scalar or batch input.
 * @param {Object} options Normalised execution options.
 * @param {boolean} [options.batch=false] Select batch URL and response semantics.
 * @param {boolean} [options.retry=false] Permit up to three transient attempts.
 * @param {number|null} [options.timeoutMs=null] Per-attempt abort timeout.
 * @param {number} [attempt=1] Current attempt number; used internally for retries.
 * @returns {Promise<*>} Unwrapped scalar data or ordered settled batch results.
 */
async function _trpcExec(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
} = {}, attempt = 1) {
  const MAX_ATTEMPTS = retry ? 3 : 1;
  const label = batch ? `${endpoint} batch` : endpoint;
  let url;
  if (batch) {
    url = _trpcBatchUrl(endpoint, inputOrInputs);
  } else if (inputOrInputs === null) {
    url = `${API_BASE}/${endpoint}`;
  } else {
    url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(inputOrInputs))}`;
  }
  const ctrl = timeoutMs ? new AbortController() : null;
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // No response at all: offline, DNS, CORS, a blocker, or the server is down.
      throw dataError(DATA_MESSAGES.unreachable(), `${label} → no response (${e.message})`, { network: true });
    }
    if (!res.ok) {
      // A 429 here means every key in the proxy's pool is rate-limited, not
      // just one - the proxy already retries a limited key on another. The
      // seconds left in the window ride on the error so
      // isTransientError()/_retryDelayMs() can wait out the window rather
      // than burning attempts on the ~400ms backoff.
      const body = await res.json().catch(() => null);
      const text = _apiErrorText(body);
      // The Worker only serves the site's own address (and local
      // development). Anywhere else a player needs the real site; a
      // developer previewing elsewhere needs ?proxy=.
      const message = res.status === 403 && text === 'origin not allowed'
        ? DATA_MESSAGES.originNotAllowed()
        : _messageForStatus(res.status, Number(res.headers.get('Retry-After')));
      const err = dataError(message, `${label} → HTTP ${res.status}${text ? `: ${text}` : ''}`, { status: res.status });
      const retryAfterMs = _retryAfterMs(res.headers);
      if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    const json = await res.json().catch(() => {
      throw dataError(DATA_MESSAGES.unreadable(), `${label} → response isn't JSON`);
    });
    if (batch) {
      if (!Array.isArray(json) || json.length !== inputOrInputs.length) {
        throw dataError(DATA_MESSAGES.unreadable(), `${label} → malformed response`);
      }
      const settled = json.map((item, index) => {
        const reason = _trpcResponseError(item, `${endpoint}[${index}]`);
        return reason
          ? { status: 'rejected', reason }
          : { status: 'fulfilled', value: _trpcResponseValue(item) };
      });
      const transient = settled.find(result =>
        result.status === 'rejected' && isTransientError(result.reason)
      );
      if (transient && attempt < MAX_ATTEMPTS) throw transient.reason;
      return settled;
    }

    const item = Array.isArray(json) ? json[0] : json;
    const responseError = _trpcResponseError(item, endpoint);
    if (responseError) throw responseError;
    return _trpcResponseValue(item);
  } catch (e) {
    if (e.name === 'AbortError') e = dataError(DATA_MESSAGES.timedOut(), `${label} → timed out after ${timeoutMs} ms`, { timeout: true });
    if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
      const delay = _retryDelayMs(e, attempt);
      if (delay != null) {
        if (e.status === 429) {
          _trpcRateLimited(delay, batch ? inputOrInputs.length : 1, label);
        }
        await new Promise(r => setTimeout(r, delay));
        return _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, attempt + 1);
      }
    }
    throw e;
  } finally {
    if (t) clearTimeout(t);
  }
}

/*
 *  Chunk limits for trpcMany.
 *
 *  A batch carries everything in the URL, so URL SIZE is what actually
 *  constrains a batch and it's what we pack against. The Worker runtime
 *  rejects a request whose URL exceeds 16 KB with a bare 500 - measured
 *  against the live proxy, 15,726 chars still answers 200 and 16,058 already
 *  500. TRPC_MANY_URL_BUDGET keeps ~25% clear of that cliff.
 *
 *  Packing by bytes rather than by count is what lets small inputs ride in
 *  big batches: the budget buys ~290 user.getUserLite inputs (~41 chars each)
 *  but only ~75 transaction.getPaginatedTransactions inputs (~160 chars
 *  each). A fixed count would have to be sized for the worst shape and would
 *  waste most of the URL on the best one.
 *
 *  TRPC_MANY_MAX_CHUNK is then a backstop, not the sizing rule. Two things
 *  scale with batch size besides the URL: the response (50 transaction
 *  inputs already return ~1.1 MB) and the blast radius, since a batch that
 *  fails outright takes every input in it down. 100 keeps both bounded on
 *  the cheap endpoints where the byte budget alone would allow far more.
 *
 *  Several chunks then go out at a bounded concurrency, so a 600-citizen
 *  sweep doesn't open a dozen sockets at once against the request budget.
 */
const TRPC_MANY_URL_BUDGET  = 12_000;
const TRPC_MANY_MAX_CHUNK   = 100;
const TRPC_MANY_CONCURRENCY = 4;

/*
 *  Repair passes for a chunk that came back with retryable failures. Total
 *  attempts per input is 1 + this, matching the 3 of scalar retry.
 */
const TRPC_MANY_REPAIR_PASSES = 2;

/**
 * Fetch one endpoint for many inputs using tRPC HTTP batching.
 *
 * This is the bulk counterpart to trpc(): instead of one request per input,
 * inputs are packed into batches by URL size and the batches are issued
 * `concurrency` at a time. A list of 200 users costs 2 requests rather than
 * 200, which is the difference between a sweep that finishes and one that
 * trips the API rate limit.
 *
 * The result is flat, in the same order and of the same length as `inputs`,
 * using Promise.allSettled's shape:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 * Failure is per item: a chunk whose whole request fails yields rejected
 * results for just that chunk's inputs, and the other chunks still resolve.
 * With `retry` (the default), retryable failures are then re-sent as a batch
 * of just the failures - so one bad item in a chunk of 100 costs one small
 * repair request, not a re-pull of all 100. Rate-limited retries wait as
 * long as the server's Retry-After asks.
 * Callers therefore never need a try/catch around trpcMany itself.
 *
 * @param {string} endpoint tRPC procedure name, e.g. `user.getUserLite`.
 * @param {Object[]} inputs One input per desired result; `[]` resolves to `[]`.
 * @param {Object} [options]
 * @param {number} [options.urlBudget=12000] Max URL length per batch; the primary sizing rule.
 * @param {number} [options.maxChunk=100] Backstop cap on inputs per batch.
 * @param {number} [options.concurrency=4] Batches in flight at once.
 * @param {boolean} [options.retry=true] Re-send retryable failures as a repair batch.
 * @param {number|null} [options.timeoutMs=30000] Abort each HTTP attempt after this long.
 * @param {boolean} [options.fresh=false] Bypass cached values; still caches what it fetches.
 * @param {function(number, number):void} [options.onProgress] Called with (done, total) after each batch.
 * @param {function(number, number):void} [options.onRateLimit] Called with (waitMs, itemCount) before a rate-limit wait.
 * @returns {Promise<Array<{status: string, value?: *, reason?: *}>>} Settled results, input order.
 * @throws {TypeError} If `inputs` is not an array.
 */
async function trpcMany(endpoint, inputs, {
  urlBudget   = TRPC_MANY_URL_BUDGET,
  maxChunk    = TRPC_MANY_MAX_CHUNK,
  concurrency = TRPC_MANY_CONCURRENCY,
  retry       = true,
  timeoutMs   = 30_000,
  fresh       = false,
  onProgress  = null,
  onRateLimit = null,
} = {}) {
  if (!Array.isArray(inputs)) throw new TypeError('trpcMany inputs must be an array');
  const total = inputs.length;
  if (!total) return [];

  const results = new Array(total);

  // Serve whatever is already cached, and only fetch the rest. The cache is
  // per item, so this hits on overlapping lists and on anything a scalar call
  // or an earlier, differently-chunked sweep already fetched.
  const pending = [];
  for (let i = 0; i < total; i++) {
    const cached = _trpcCachedItem(endpoint, inputs[i], fresh);
    if (cached === TRPC_CACHE_MISS) pending.push(i);
    else results[i] = { status: 'fulfilled', value: cached };
  }

  let done = total - pending.length;
  if (done) onProgress?.(done, total);
  if (!pending.length) return results;

  // Pack each chunk up to the URL budget, with maxChunk as a backstop. The
  // budget is measured against the URL actually built for the request, so the
  // guard can't drift from the wire format. A single input that blows the
  // budget on its own still goes out alone - splitting it further isn't
  // possible, and letting the server reject it beats dropping it silently.
  // Chunks carry original indices, since cache hits leave gaps in the list.
  const chunks = [];
  let current = [];
  for (const index of pending) {
    current.push(index);
    const overBudget = current.length > 1
      && _trpcBatchUrl(endpoint, current.map(i => inputs[i])).length > urlBudget;
    if (overBudget) {
      current.pop();
      chunks.push(current);
      current = [index];
    } else if (current.length >= maxChunk) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  let next = 0;

  /*
   *  Issue one batch, flattening a whole-batch failure (transport, HTTP,
   *  malformed response) into a rejected result per input so callers of
   *  runBatch only ever deal with one shape.
   *
   *  retry is false here on purpose: the inner retry re-sends the WHOLE
   *  batch, which at 100 inputs means re-pulling every good result to repair
   *  one bad one. repairChunk below re-sends only what failed instead.
   */
  async function runBatch(batchInputs) {
    try {
      return await trpc(endpoint, batchInputs, { batch: true, retry: false, timeoutMs, fresh });
    } catch (e) {
      return batchInputs.map(() => ({ status: 'rejected', reason: e }));
    }
  }

  /*
   *  Run a chunk, then re-send just the retryable failures.
   *
   *  Whole-batch and item-level failures repair through the same path: a
   *  dead batch is simply the case where every input needs repairing. Each
   *  pass waits as long as the failure itself advises - which for a 429 is
   *  the seconds left in the rate-limit window, read from Retry-After.
   *
   *  Permanent failures (404, 400) are never repaired; they'd fail
   *  identically and cost another request to learn nothing.
   */
  async function repairChunk(chunkInputs) {
    const settled = await runBatch(chunkInputs);
    if (!retry) return settled;

    for (let pass = 1; pass <= TRPC_MANY_REPAIR_PASSES; pass++) {
      const broken = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'rejected' && isTransientError(result.reason)) broken.push(i);
      }
      if (!broken.length) break;

      const reason = settled[broken[0]].reason;
      const delay = _retryDelayMs(reason, pass);
      if (delay == null) break;   // advised wait too long to sit through
      if (reason?.status === 429) {
        if (onRateLimit) onRateLimit(delay, broken.length);
        else _trpcRateLimited(delay, broken.length, `${endpoint} (${broken.length} inputs)`);
      }
      await new Promise(r => setTimeout(r, delay));

      const repaired = await runBatch(broken.map(i => chunkInputs[i]));
      broken.forEach((target, k) => { settled[target] = repaired[k]; });
    }
    return settled;
  }

  async function pump() {
    while (next < chunks.length) {
      const indices = chunks[next++];
      const settled = await repairChunk(indices.map(i => inputs[i]));
      indices.forEach((target, k) => { results[target] = settled[k]; });
      done += indices.length;
      onProgress?.(done, total);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, chunks.length) }, pump
  ));
  return results;
}

/**
 * trpcMany, unwrapped: resolves to plain values with `fallback` in place of
 * any rejected entry. Use it for the common case where a failed item should
 * simply drop out of the results rather than be reported.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object[]} inputs One input per desired result.
 * @param {Object} [options] As trpcMany, plus:
 * @param {*} [options.fallback=null] Value to substitute for a rejected item.
 * @returns {Promise<Array<*>>} Values in input order, `fallback` where an item failed.
 */
async function trpcManyValues(endpoint, inputs, { fallback = null, ...options } = {}) {
  const settled = await trpcMany(endpoint, inputs, options);
  return settled.map(result => result.status === 'fulfilled' ? result.value : fallback);
}

/**
 * Enrich full country records with the ruling parties' live Industrialism
 * tiers. country.getCountryById exposes only a rulingParty ID, so resolve the
 * distinct parties in batches and copy ethics.industrialism onto each country
 * where the production-bonus model expects it.
 *
 * A country with no ruling party remains neutral. Any attempted party lookup
 * failure rejects the whole enrichment so callers cannot present incomplete
 * production recommendations as authoritative. Clear any old value first
 * because country objects may have come from the shared cache.
 *
 * @param {Object<string, Object>} countryById Full country records keyed by ID.
 * @returns {Promise<Object<string, Object>>} The same enriched mapping.
 */
async function enrichCountriesWithIndustrialism(countryById) {
  const countries = Object.values(countryById || {}).filter(Boolean);
  const partyIdFor = country => {
    const party = country?.rulingParty;
    if (typeof party === 'string') return party;
    return typeof party?._id === 'string' ? party._id : null;
  };

  countries.forEach(country => { delete country.industrialism; });
  const partyIds = [...new Set(countries.map(partyIdFor).filter(Boolean))];
  const settled = await trpcMany('party.getById',
    partyIds.map(partyId => ({ partyId })));
  const failures = settled.filter(result => result.status === 'rejected');
  if (failures.length) {
    const detail = failures[0].reason?.message;
    throw new Error(`Couldn't load ruling-party ethics for ${failures.length} of ${partyIds.length} parties${detail ? `: ${detail}` : ''}`);
  }
  const parties = settled.map(result => result.value);
  const tierByPartyId = new Map();
  parties.forEach((party, index) => {
    const tier = party?.ethics?.industrialism;
    if ([-2, -1, 0, 1, 2].includes(tier)) tierByPartyId.set(partyIds[index], tier);
  });
  countries.forEach(country => {
    const tier = tierByPartyId.get(partyIdFor(country));
    if (tier !== undefined) country.industrialism = tier;
  });
  return countryById;
}

/*
 *  A rate-limit wait can be most of a minute (the window is 60s wide), which
 *  is long enough that a silent pause reads as a hung tool. So the panel
 *  grows a step for it: injected when the wait starts, counting down, removed
 *  when it ends. It's transient rather than markup because it belongs to no
 *  particular pipeline - any step can be the one that gets rate limited.
 *
 *  The panel registers itself as the rate-limit handler while it's visible
 *  (reset() on, hide()/fadeOut() off), so the wait surfaces in whichever tool
 *  is actually running without any of its call sites passing a callback.
 *
 *  Its state is `waiting`, deliberately not `active`: markActiveAsError()
 *  targets the active step, and a rate-limit pause must not swallow the error
 *  marker for the real step underneath.
 */
function makeRateLimitStep(rootEl) {
  let row = null, timer = null, expiry = null, endsAt = 0;

  function clear() {
    if (timer) { clearInterval(timer); timer = null; }
    if (expiry) { clearTimeout(expiry); expiry = null; }
    if (row) { row.remove(); row = null; }
    endsAt = 0;
  }

  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    if (left <= 0) { clear(); return; }
    row.querySelector('.step-count').textContent = `${left}s`;
  }

  function show(waitMs, itemCount) {
    // Concurrent batches can each get rate limited; one row, latest deadline.
    endsAt = Math.max(endsAt, Date.now() + waitMs);
    if (!row) {
      row = document.createElement('div');
      row.className = 'step';
      row.dataset.state = 'waiting';
      row.dataset.step = 'ratelimit';
      row.innerHTML =
        '<div class="step-icon"></div>' +
        '<div class="step-body">' +
          '<div class="step-title">We\'ve used up our requests to War Era for the moment</div>' +
          '<div class="step-sub"></div>' +
        '</div>' +
        '<div class="step-count"></div>';
      rootEl.appendChild(row);
    }
    row.querySelector('.step-sub').textContent = 'They refresh when the countdown ends, and loading carries on by itself.';
    tick();
    // The 1s interval only animates the countdown; removal is pinned to the
    // deadline itself, so the row can't outlive the wait by up to a tick.
    if (!timer) timer = setInterval(tick, 1000);
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(clear, Math.max(0, endsAt - Date.now()));
  }

  return { show, clear };
}

/*
 *  Stalled-step watch. A request with no timeout that never answers (a hung local Worker, say)
 *  would leave a step spinning in silence. While a step is active this
 *  shows how long it has waited; once one step waits STALL_MS, a notice in
 *  the panel says so and whether the API proxy answers its health check,
 *  rechecked every HEALTH_EVERY_MS. `onStall` lets a tool offer its own
 *  retry, described by `retryHint`. */
function makeStallWatch(rootEl, { onStall = null, retryHint = 'Reload the page to try again.' } = {}) {
  const STALL_MS = 15000, HEALTH_EVERY_MS = 30000;
  let timer = null, step = null, since = 0, checked = 0, epoch = 0;

  const elapsedOf = (el) => el.querySelector('.step-elapsed')
    || el.querySelector('.step-title').appendChild(Object.assign(document.createElement('span'), { className: 'step-elapsed' }));
  const notice = (text, isError) => {
    let el = rootEl.querySelector('.steps-stall');
    if (!text) { el?.remove(); return; }
    if (!el) el = rootEl.appendChild(Object.assign(document.createElement('div'), { className: 'steps-stall' }));
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  };
  function clearMarks() {
    rootEl.querySelectorAll('.step-elapsed').forEach(e => e.remove());
    notice('');
  }
  async function tick() {
    const el = rootEl.querySelector('.step[data-state="active"]');
    if (el !== step) { clearMarks(); step = el; since = Date.now(); checked = 0; }
    if (!el) { stop(); return; }
    const waited = Date.now() - since;
    if (waited >= 3000) elapsedOf(el).textContent = ` · ${Math.floor(waited / 1000)} s`;
    if (waited < STALL_MS || Date.now() - checked < HEALTH_EVERY_MS) return;
    checked = Date.now();
    const mine = epoch;
    const what = el.querySelector('.step-title').firstChild?.textContent?.trim() || 'this step';
    if (onStall) onStall();
    notice(`Still waiting on "${what}" after ${Math.floor(waited / 1000)} s. Checking our data service…`);
    let up = false;
    try { up = (await fetch(`${WORKER_BASE}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { up = false; }
    if (mine !== epoch || step !== el) return;
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(WORKER_BASE);
    notice(up
      ? `Still waiting on "${what}". War Era is slow to answer right now. Keep waiting, or: ${retryHint}`
      : `Still waiting on "${what}". Our data service isn't responding right now. ${retryHint}${
          local ? ` (Local development: check that \`wrangler dev\` is running at ${WORKER_BASE}, and restart it if it has stuck.)` : ''}`, !up);
  }
  function start() {
    if (timer) return;
    timer = setInterval(tick, 1000);
    tick();   // time the step from when it starts, not from the first interval
  }
  function stop() {
    epoch += 1;
    if (timer) { clearInterval(timer); timer = null; }
    step = null;
    clearMarks();
  }
  return { start, stop };
}

function makeSteps(rootEl, stallOptions) {
  const rateLimit = makeRateLimitStep(rootEl);
  const stall = makeStallWatch(rootEl, stallOptions);

  function setStep(n, state, { sub, count } = {}) {
    const el = rootEl.querySelector(`.step[data-step="${n}"]`);
    if (!el) return;
    el.dataset.state = state;
    if (state === 'active') stall.start();
    if (sub   !== undefined) el.querySelector('.step-sub').textContent   = sub   ?? '';
    if (count !== undefined) el.querySelector('.step-count').textContent = count ?? '';
  }
  function reset() {
    stall.stop();
    rootEl.classList.remove('hidden', 'fading');
    rateLimit.clear();
    // This panel owns rate-limit reporting for as long as it's on screen.
    setRateLimitHandler(rateLimit.show);
    for (const step of rootEl.querySelectorAll('.step')) {
      step.dataset.state = 'pending';
      step.querySelector('.step-sub').textContent = '';
      step.querySelector('.step-count').textContent = '';
    }
  }
  function markActiveAsError(message) {
    stall.stop();
    const active = rootEl.querySelector('.step[data-state="active"]');
    if (active) {
      active.dataset.state = 'error';
      active.querySelector('.step-sub').textContent = message;
    }
  }
  function fadeOut(delay = 1200) {
    release();
    setTimeout(() => rootEl.classList.add('fading'), delay);
    setTimeout(() => rootEl.classList.add('hidden'), delay + 500);
  }
  function hide() { release(); rootEl.classList.add('hidden'); }

  // Stop reporting into a panel the user can no longer see. Only give up the
  // global handler if it's still ours - another tool may have claimed it.
  function release() {
    stall.stop();
    rateLimit.clear();
    if (getRateLimitHandler() === rateLimit.show) setRateLimitHandler(null);
  }

  return { setStep, reset, markActiveAsError, fadeOut, hide };
}

function makeStatus(el) {
  return function setStatus(text, isError = false) {
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
  };
}

/* ── Production-bonus model ─────────────────────────────────────────
 *  Single source of truth for the four-component production bonus.
 *  Previously copy-pasted into advisor.js, dashboard.js and
 *  daily-profit.js; the fix in PR #9 had to be applied three times by
 *  hand and missed daily-profit-dev.js entirely. Keep it here.
 *
 *  The component semantics and the asymmetric gating were verified
 *  against many in-game tooltips — see the header comment in
 *  js/advisor.js for the worked examples. Do not change without
 *  re-verifying:
 *
 *    • Strategic + Specialisation fire on an eligible specialised item;
 *      the modifier is +10 at Industrialism +1 or +30 at +2.
 *    • Deposit fires whenever there's an active matching deposit, EXCEPT
 *      when the country specialises in the item AND is industrialist.
 *    • DepositCountry fires only for the four eligible deposit
 *      resources; the modifier is +10 at Industrialism -1 or +30 at -2.
 *
 *  Keep the allowlists separate: industrial specialisation covers 12
 *  goods, agrarian deposits only 4.
 * ─────────────────────────────────────────────────────────────────── */
const INDUSTRIALISM_SPECIALISATION_ITEMS = new Set([
  'lightAmmo', 'ammo', 'heavyAmmo', 'concrete', 'steel', 'iron',
  'limestone', 'petroleum', 'oil', 'lead', 'wood', 'paper',
]);
const AGRARIAN_DEPOSIT_ITEMS = new Set(['coca', 'grain', 'livestock', 'fish']);
const SPECIALISATION_MODIFIER_BY_TIER = { 1: 10, 2: 30 };
const DEPOSIT_MODIFIER_BY_TIER = { '-1': 10, '-2': 30 };
const INDUSTRIALISM_LABEL_BY_TIER = {
  1: 'Industrialist',
  2: 'Fanatic Industrialist',
  '-1': 'Agrarian',
  '-2': 'Fanatic Agrarian',
};

function isDepositActive(dep) {
  if (!dep) return false;
  const now = Date.now();
  const starts = dep.startsAt ? new Date(dep.startsAt).getTime() : 0;
  const ends   = dep.endsAt   ? new Date(dep.endsAt).getTime()   : 0;
  return now >= starts && now <= ends;
}

function industrialismTier(country) {
  const tier = country?.industrialism;
  return [-2, -1, 0, 1, 2].includes(tier) ? tier : 0;
}

/**
 * Compute the production bonus for a (country, region, item) combination.
 * Returns null if country is unknown.
 *
 * The result is the superset of what the callers need:
 *   strategic / specialisation / deposit / depositCountry
 *                   — the four components, as percentages (advisor's breakdown)
 *   total, tax      — summed bonus % and the country's income tax %
 *   netMult         — (1 + total%) × (1 − tax%), for take-home comparisons
 *   tier, industrialismLabel
 *                   — the country's Industrialism tier and its display name
 *   region, country — echoed back, so callers can carry the winning pair
 *   depositEndsAt   — expiry of the deposit driving the bonus, or null
 *   depositInfo     — { bonus, endsAt, type } for flagging a temporary
 *                     deposit in a table, or null. Note this is an OBJECT,
 *                     unlike the numeric `deposit` component above.
 */
function computeProductionBonus(country, region, itemCode) {
  if (!country) return null;

  const isSpecialised = country.specializedItem === itemCode;
  const tier          = industrialismTier(country);

  // Fanatic Agrarian disables specialization benefits. Such countries
  // cannot normally retain a specialization, but guard stale API data too.
  const strategic = isSpecialised && tier !== -2
    ? (country.strategicResources?.bonuses?.productionPercent || 0)
    : 0;
  const specialisation = isSpecialised
    && INDUSTRIALISM_SPECIALISATION_ITEMS.has(itemCode)
    ? (SPECIALISATION_MODIFIER_BY_TIER[tier] || 0) : 0;

  const hasDeposit = !!region?.deposit
    && region.deposit.type === itemCode
    && isDepositActive(region.deposit)
    && !(isSpecialised && tier > 0);
  const deposit        = hasDeposit ? (region.deposit.bonusPercent || 0) : 0;
  const depositCountry = hasDeposit && AGRARIAN_DEPOSIT_ITEMS.has(itemCode)
    ? (DEPOSIT_MODIFIER_BY_TIER[tier] || 0) : 0;

  const total   = strategic + specialisation + deposit + depositCountry;
  const tax     = country.taxes?.income ?? 0;
  const netMult = (1 + total / 100) * (1 - tax / 100);

  // Surface whether the bonus leans on a temporary regional deposit (these
  // expire — region.deposit has startsAt/endsAt), so tables can flag it.
  const depositInfo = hasDeposit
    ? { bonus: deposit + depositCountry, endsAt: region.deposit.endsAt, type: region.deposit.type }
    : null;

  return {
    strategic, specialisation, deposit, depositCountry,
    total, tax, netMult,
    tier, industrialismLabel: INDUSTRIALISM_LABEL_BY_TIER[tier] || 'Industrialism',
    region, country,
    depositEndsAt: hasDeposit ? region.deposit.endsAt : null,
    depositInfo,
  };
}

// Keep every monthly boundary anchored to the same date, including month ends.
function wealthMonthBoundary(now, monthsAgo) {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - monthsAgo);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
}

function wealthMonthBucketIndex(iso, now) {
  const date = new Date(iso);
  let index = 0;
  // A reading on a boundary belongs to the interval starting there.
  while (date < wealthMonthBoundary(now, index + 1)) index++;
  return index;
}

function wealthMonthBucketKey(iso, now) {
  return wealthMonthBoundary(now, wealthMonthBucketIndex(iso, now)).toISOString().slice(0, 10);
}

// Weekly intervals are rolling 7-day windows counted back from now, like the
// monthly ones, rather than calendar weeks.
const WEALTH_WEEK_MS = 7 * 86400000;

function wealthWeekBoundary(now, weeksAgo) {
  return new Date(new Date(now).getTime() - weeksAgo * WEALTH_WEEK_MS);
}

function wealthWeekBucketIndex(iso, now) {
  // A reading on a boundary belongs to the interval starting there.
  return Math.max(0, Math.ceil((new Date(now) - new Date(iso)) / WEALTH_WEEK_MS) - 1);
}

function wealthWeekBucketKey(iso, now) {
  return wealthWeekBoundary(now, wealthWeekBucketIndex(iso, now)).toISOString().slice(0, 10);
}

// Range choices, in display order. A bucket as wide as its range or wider
// would hold every reading, so only narrower buckets are offered.
const WEALTH_RANGES = [
  { key: 'day',     label: '1D',  title: 'Latest daily snapshot to now', buckets: ['day'] },
  { key: 'week',    label: '1W',  title: 'Last week',     buckets: ['day'] },
  { key: 'month',   label: '1M',  title: 'Last month',    buckets: ['day', 'week'] },
  { key: '3months', label: '3M',  title: 'Last 3 months', buckets: ['day', 'week', 'month'] },
  { key: 'all',     label: 'All', title: 'All time',      buckets: ['day', 'week', 'month'] },
];

function wealthRange(key) {
  return WEALTH_RANGES.find(r => r.key === key) || WEALTH_RANGES[WEALTH_RANGES.length - 1];
}

// Keep the chosen bucket unless the range rules it out; then use the widest
// bucket the range still allows.
function wealthBucketFor(range, bucket) {
  const { buckets } = wealthRange(range);
  return buckets.includes(bucket) ? bucket : buckets[buckets.length - 1];
}

// The chosen range and bucket persist across visits, shared by the dashboard
// card and the Wealth page.
const WEALTH_VIEW_KEY = 'warera:wealth-chart-view';

function loadWealthView() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(WEALTH_VIEW_KEY) || 'null'); } catch { /* storage off */ }
  const range = WEALTH_RANGES.some(r => r.key === saved?.range) ? saved.range : 'day';
  return { range, bucket: wealthBucketFor(range, saved?.bucket) };
}

function saveWealthView(range, bucket) {
  try { localStorage.setItem(WEALTH_VIEW_KEY, JSON.stringify({ range, bucket })); } catch { /* storage off */ }
}

// Filter before bucketing so an older reading cannot enter the selected range.
// The day range opens at the latest stored (non-live) snapshot, so it shows
// what was earned since the last daily log, however long ago that was.
function wealthSnapshotsInRange(snapshots, range, now = new Date()) {
  if (range === 'all') return snapshots;
  let start;
  if (range === 'day') {
    const stored = snapshots.filter(s => !s.live).map(s => s.t).sort();
    if (!stored.length) return snapshots;
    start = new Date(stored[stored.length - 1]);
  } else if (range === 'week') {
    start = wealthWeekBoundary(now, 1);
  } else {
    start = wealthMonthBoundary(now, range === '3months' ? 3 : 1);
  }
  return snapshots.filter(s => new Date(s.t) >= start);
}
