/* ═══════════════════════════════════════════════════════════════════
 *  WEALTH MONITOR  (#wealth, and a tab in the #home shell)
 *
 *  Look up an Irish player → show their current wealth (its own box) and
 *  a wealth-over-time chart (total or 5-way breakdown), bucketed by
 *  day/week/month. Inside the home shell it's driven by the shared
 *  username field via activate({u}); standalone (#wealth) it uses its own
 *  input. Nothing renders until a username is supplied.
 *
 *  Data:
 *    - Current wealth: user.getUserById → stats.wealth (live).
 *    - History: per-user data/wealth/<id>.json, collected daily by
 *      wealth_log.py. The API has no per-user wealth history, so the
 *      chart only covers the period since a player was added; gaps
 *      (incl. removed-then-re-added) render as real-width blanks.
 *    - Coverage: every Irish citizen is tracked automatically by the
 *      logger (no opt-in) — each gets a per-user file under data/wealth/.
 *
 *  Access: Irish-citizens-only via enforceIrishOnly (shared.js),
 *  honouring ?bypass=1.
 * ═══════════════════════════════════════════════════════════════════ */
const WealthMonitorTool = (() => {
  // Per-user history file written by wealth_log.py for every Irish citizen.
  const histUrl = uid => `data/wealth/${uid}.json`;

  const COMPONENTS = [
    { key: 'companies',  label: 'Companies', color: '#60a5fa' },
    { key: 'items',      label: 'Items',     color: '#fbbf24' },
    { key: 'money',      label: 'Money',     color: '#34d399' },
    { key: 'equipments', label: 'Equipment', color: '#a78bfa' },
    { key: 'weapons',    label: 'Weapons',   color: '#f87171' },
  ];
  const TOTAL_COLOR = '#4ade80';

  const RECENT_KEY = 'wm:recent-usernames';
  const RECENT_MAX = 8;

  // DOM
  const $username  = document.getElementById('wm-username');
  const $submit    = document.getElementById('wm-submit');
  const $recent    = document.getElementById('wm-recent');
  const $status    = document.getElementById('wm-status');
  const $statsCard = document.getElementById('wm-stats-card');
  const $chartCard = document.getElementById('wm-chart-card');
  const $summary   = document.getElementById('wm-summary');
  const $breakdown = document.getElementById('wm-breakdown');
  const $metricSeg = document.getElementById('wm-metric-seg');
  const $bucketSeg = document.getElementById('wm-bucket-seg');
  const $rangeSeg  = document.getElementById('wm-range-seg');
  const $chartBox  = document.getElementById('wm-chart-box');
  const $legend    = document.getElementById('wm-legend');
  const steps      = makeSteps(document.getElementById('wm-steps'));

  // State
  let current      = null;            // { user, wealth, avatarUrl } for the resolved player
  let historySnaps = [];              // the resolved player's snapshots
  let readingTimes = new Map();       // bucketKey -> time of the reading it shows
  const OPENING = 'opening';          // x-slot key for the range's first reading
  const chart      = { user: null, metric: 'total', bucket: 'day', range: 'all' };

  // Helpers
  const wm_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  function fmtK(v, dp = 2) {
    if (v == null || !isFinite(v)) return '–';
    return Math.abs(v) >= 1000 ? (v / 1000).toFixed(dp) + 'K' : v.toFixed(dp);
  }

  function showStatus(level, html) {
    $status.className = `bf-inline-status ${level}`;
    $status.innerHTML = html;
    $status.classList.remove('hidden');
  }
  function hideStatus() { $status.classList.add('hidden'); $status.innerHTML = ''; }

  async function fetchJson(url) {
    const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
    if (!res.ok) { if (res.status === 404) return null; throw new Error(`HTTP ${res.status}`); }
    return res.json();
  }

  // Same anti-fuzzy resolution as the other tools: search, then verify an
  // exact username match. Never fall back to the top hit.
  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;
    const searchRes = await wm_trpc('search.searchAnything', { searchText: username });
    const ids = (searchRes?.userIds || []).slice(0, 10);
    if (!ids.length) return null;
    const profiles = await trpcManyValues('user.getUserLite',
      ids.map(userId => ({ userId })));
    return profiles.find(u =>
      u && typeof u.username === 'string' && u.username.toLowerCase() === needle
    ) || null;
  }

  async function fetchCurrentWealth(userId) {
    const data = await wm_trpc('user.getUserById', { userId });
    const wealth = data?.stats?.wealth;
    if (!wealth || typeof wealth !== 'object') return null;
    return { username: data.username, avatarUrl: data.avatarUrl, wealth };
  }


  // ── Recent usernames (localStorage) — mirrors the toolkit shell ─
  function readRecent() {
    try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  }
  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* storage off */ }
  }
  function rememberUsername(u) {
    const list = readRecent().filter(x => x.toLowerCase() !== u.toLowerCase());
    list.unshift(u);
    writeRecent(list);
    renderRecent();
  }
  function forgetUsername(name) {
    writeRecent(readRecent().filter(x => x.toLowerCase() !== name.toLowerCase()));
    renderRecent();
  }
  function renderRecent() {
    const list = readRecent();
    if (!list.length) { $recent.innerHTML = ''; $recent.classList.add('hidden'); return; }
    $recent.classList.remove('hidden');
    $recent.innerHTML =
      `<span class="stg-recent-label">Recent:</span>` +
      list.map(u => {
        const safe = escapeHtml(u);
        return `<span class="stg-recent-chip">
          <button class="stg-recent-pick" data-wm-recent="${safe}">${safe}</button>
          <button class="stg-recent-del" data-wm-recent-del="${safe}" title="Remove">×</button>
        </span>`;
      }).join('');
  }

  // ── Look-up flow ────────────────────────────────────────────────
  async function handleSubmit() {
    const raw = $username.value.trim();
    if (!raw) { showStatus('warn', 'Please enter an in-game username.'); $username.focus(); return; }
    if (raw.length > 40) { showStatus('warn', 'Username looks too long. Please double-check.'); return; }

    $submit.disabled = true;
    $statsCard.classList.add('hidden');
    $chartCard.classList.add('hidden');
    hideStatus();
    steps.reset();

    try {
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      let user;
      try { user = await resolveUsername(raw); }
      catch (e) {
        steps.markActiveAsError('Lookup failed');
        throw new Error(isTransientError(e)
          ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
          : `Username lookup failed: ${e.message}`);
      }
      if (!user) {
        steps.markActiveAsError('No user found with that name');
        throw new Error(`No War Era user found with username "${raw}". Check the spelling and try again.`);
      }

      // Irish-citizens-only. ?bypass=1 (query or hash) lifts it.
      enforceIrishOnly(user.country ?? user.countryId, user.username);
      steps.setStep(1, 'done', { count: `→ ${user.username}` });

      // Shareable URL + remember the verified name as a quick-pick chip.
      // The hash rewrite (same shape as the other tools) is what the home
      // shell's hash guard folds back into #home?u=…&tool=wealth.
      try { window.history.replaceState(null, '', `#wealth?u=${encodeURIComponent(user.username)}`); } catch {}
      rememberUsername(user.username);

      steps.setStep(2, 'active', { sub: 'Fetching wealth & history' });
      const live = await fetchCurrentWealth(user._id);
      if (!live) { steps.markActiveAsError('No wealth data'); throw new Error(`Couldn't read wealth for ${user.username}.`); }
      const hist = await fetchJson(histUrl(user._id)).catch(() => null);
      historySnaps = (hist && Array.isArray(hist.snapshots)) ? hist.snapshots : [];
      steps.setStep(2, 'done');
      steps.fadeOut(300);

      current = { user, wealth: live.wealth, avatarUrl: live.avatarUrl };
      chart.user = user._id;
      renderResults();
      rememberLoadedAccount(user.username);
    } catch (e) {
      steps.markActiveAsError(e.message);
      showStatus('error', escapeHtml(e.message));
    } finally {
      $submit.disabled = false;
    }
  }

  // ── Results rendering ───────────────────────────────────────────
  function avatarHtml(username, avatarUrl) {
    const initial = (username || '?').slice(0, 1).toUpperCase();
    if (avatarUrl && /^https?:\/\//.test(avatarUrl)) {
      return `<div class="wm-avatar"><img src="${escapeHtml(avatarUrl)}" alt="" onerror="this.parentElement.textContent='${escapeHtml(initial)}'"></div>`;
    }
    return `<div class="wm-avatar">${escapeHtml(initial)}</div>`;
  }

  function renderSummary() {
    const { user, wealth, avatarUrl } = current;
    $summary.innerHTML =
      avatarHtml(user.username, avatarUrl) +
      `<span class="wm-name"><a href="${GAME_BASE}/user/${user._id}" target="_blank" rel="noopener">${escapeHtml(user.username)}</a></span>` +
      `<span class="wm-total">${fmtK(wealth.total)}<small>total wealth</small></span>`;
  }

  function renderResults() {
    renderSummary();
    $breakdown.innerHTML = COMPONENTS.map(c =>
      `<span title="${c.label}"><span class="wm-dot" style="background:${c.color}"></span>${c.label}: <b>${fmtK(current.wealth[c.key])}</b></span>`
    ).join('');
    $statsCard.classList.remove('hidden');
    $chartCard.classList.remove('hidden');
    renderChart();
  }

  // ── Bucketing ───────────────────────────────────────────────────
  function bucketKey(iso, bucket, now) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    if (bucket === 'month') return wealthMonthBucketKey(iso, now);
    if (bucket === 'week')  return wealthWeekBucketKey(iso, now);
    return iso.slice(0, 10);
  }

  function bucketedValues(snapshots, key, bucket, now) {
    const byBucket = new Map();   // bucketKey -> { t, value }
    for (const s of snapshots || []) {
      const bk = bucketKey(s.t, bucket, now);
      if (!bk) continue;
      const v = s[key];
      if (typeof v !== 'number') continue;
      const prev = byBucket.get(bk);
      if (!prev || s.t > prev.t) byBucket.set(bk, { t: s.t, value: v });
    }
    const out = new Map();
    for (const [bk, o] of byBucket) out.set(bk, o.value);
    return out;
  }

  // Complete, gap-inclusive sequence of bucket keys from first..last. This
  // is what gives gaps their REAL WIDTH — every missing day/week/month gets
  // an x-slot even though no series has a value there.
  function allBuckets(firstISO, lastISO, bucket, now) {
    const start = new Date(firstISO), end = new Date(lastISO);
    if (isNaN(start) || isNaN(end)) return [];
    const keys = [];
    if (bucket === 'month' || bucket === 'week') {
      const [indexOf, boundary] = bucket === 'month'
        ? [wealthMonthBucketIndex, wealthMonthBoundary]
        : [wealthWeekBucketIndex, wealthWeekBoundary];
      const first = indexOf(firstISO, now);
      const last = indexOf(lastISO, now);
      for (let i = first; i >= last; i--) {
        keys.push(boundary(now, i).toISOString().slice(0, 10));
      }
      return keys;
    }
    const day = (dt) => new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    let cur = day(start); const last = day(end);
    let guard = 0;
    while (cur <= last && guard++ < 5000) {
      keys.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return keys;
  }

  function buildSeries() {
    const now = new Date();
    let snaps = historySnaps.slice();
    // Append the live "now" reading so the chart's right edge matches the
    // game. Stored snapshots lag by up to the cron interval, so without this
    // the last point can sit hours behind the in-game figure.
    if (current && current.user._id === chart.user && current.wealth) {
      const w = current.wealth;
      snaps.push({
        t: now.toISOString(),
        companies: w.companies, items: w.items, money: w.money,
        equipments: w.equipments, weapons: w.weapons, total: w.total,
      });
    }
    snaps = wealthSnapshotsInRange(snaps, chart.range, now);
    if (!snaps.length) return { labels: [], series: [], dataCount: 0 };
    const times = snaps.map(s => s.t).filter(Boolean).sort();
    const labels = allBuckets(times[0], times[times.length - 1], chart.bucket, now);
    readingTimes = new Map();
    for (const s of snaps) {
      const bk = bucketKey(s.t, chart.bucket, now);
      if (bk && typeof s.total === 'number' && !(readingTimes.get(bk) > s.t)) readingTimes.set(bk, s.t);
    }

    // Breakdown is now multi-line (one line per category) rather than a
    // stacked area, so Companies no longer swamps the smaller categories.
    const series = (chart.metric === 'breakdown')
      ? COMPONENTS.map(c => ({
          key: c.key, label: c.label, color: c.color,
          values: bucketedValues(snaps, c.key, chart.bucket, now),
        }))
      : [{ key: 'total', label: 'Total', color: TOTAL_COLOR, values: bucketedValues(snaps, 'total', chart.bucket, now) }];

    // Start the line at the range's first reading, which its bucket's latest
    // reading would otherwise hide (a week range would start 6 days late).
    const open = snaps.filter(s => typeof s.total === 'number').reduce((a, s) => (!a || s.t < a.t ? s : a), null);
    if (open && readingTimes.get(labels[0]) !== open.t) {
      labels.unshift(OPENING);
      readingTimes.set(OPENING, open.t);
      for (const s of series) if (typeof open[s.key] === 'number') s.values.set(OPENING, open[s.key]);
    }

    const dataCount = series.reduce((m, s) => Math.max(m, s.values.size), 0);
    return { labels, series, dataCount };
  }

  // ── SVG chart ───────────────────────────────────────────────────
  // The viewBox is sized to the box's rendered width, so one SVG unit is one
  // CSS pixel and axis text stays legible on a phone instead of shrinking.
  // The left margin is fitted to the widest y-axis label at render time.
  const M = { top: 16, right: 6, bottom: 30 };

  function renderChart() {
    const { labels, series, dataCount } = buildSeries();

    if (dataCount === 0) {
      $chartBox.innerHTML = `<div class="wm-chart-empty">No history yet for this player. A daily snapshot is collected, so the chart fills in over the next few days — check back tomorrow.</div>`;
      $legend.innerHTML = '';
      return;
    }
    if (dataCount === 1) {
      $chartBox.innerHTML = `<div class="wm-chart-empty">Only one data point in this range. Choose a wider range or a smaller bucket, or check back as more daily snapshots are collected.</div>`;
      $legend.innerHTML = '';
      return;
    }

    // Breakdown: a grid of per-category mini-charts, each on its OWN scale,
    // so a big category (Companies) can't flatten the small ones.
    if (chart.metric === 'breakdown') {
      $legend.innerHTML = '';
      renderSmallMultiples(labels, series);
      return;
    }

    // Total: one large single-series chart.
    renderLegend(series);
    const W = Math.max(280, Math.round($chartBox.clientWidth) || 900);
    const H = Math.max(200, Math.round(W * 0.4));
    // Data-driven y-range (not pinned to zero) so small moves are visible.
    const { min: yMin, max: yMax, step } = yDomain(series);
    const ticks = Math.max(1, Math.round((yMax - yMin) / step));
    const tickLabels = Array.from({ length: ticks + 1 }, (_, i) => fmtTick(yMin + step * i, step));
    const left = Math.max(28, Math.max(...tickLabels.map(t => t.length)) * 7 + 12);
    const n = labels.length;
    // Every x label sits centred on its point. Labels are spaced by a fixed
    // point step, as tight as their widest text allows, counting back from
    // the latest point so it is always shown; the right margin fits half of it.
    const xLabels = labels.map(l => pointLabel(l));
    const labelW = Math.max(...xLabels.map(t => t.length)) * 6.5;
    const right = Math.max(M.right, Math.ceil(xLabels[n - 1].length * 3.25) + 2);
    const PW = W - left - right, PH = H - M.top - M.bottom;
    const s = series[0];
    const x = i => left + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
    const y = v => M.top + PH - ((v - yMin) / (yMax - yMin || 1)) * PH;

    let svg = '';
    for (let i = 0; i <= ticks; i++) {
      const yy = y(yMin + step * i);
      svg += `<line class="wm-grid-line" x1="${left}" y1="${yy.toFixed(1)}" x2="${left + PW}" y2="${yy.toFixed(1)}"/>`;
      svg += `<text class="wm-axis-text" x="${left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${tickLabels[i]}</text>`;
    }
    const xstep = n > 1 ? Math.max(1, Math.ceil((labelW + 16) / (PW / (n - 1)))) : 1;
    for (let i = n - 1; i >= 0; i -= xstep) {
      svg += `<text class="wm-axis-text" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${escapeHtml(xLabels[i])}</text>`;
    }
    svg += linePath(s, labels, x, y, n, M.top + PH);
    svg += `<line id="wm-hover-line" class="wm-hover-line" x1="0" y1="${M.top}" x2="0" y2="${M.top + PH}" style="display:none"/>`;
    $chartBox.innerHTML =
      `<svg class="wm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>` +
      `<div class="wm-tooltip" id="wm-tooltip"></div>`;
    wireHover(labels, series, x, n, W);
  }

  // One series as a continuous line with a soft gradient area fill beneath —
  // matching the dashboard charts. Present points are connected straight
  // across any missing buckets (no broken segments, no per-point dots).
  // `baseY` is the plot's bottom edge, used to close the fill to the axis.
  function linePath(s, labels, x, y, n, baseY) {
    let line = '', firstX = null, lastX = null;
    for (let i = 0; i < n; i++) {
      if (!s.values.has(labels[i])) continue;
      const px = x(i), py = y(s.values.get(labels[i]));
      line += `${firstX === null ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`;
      if (firstX === null) firstX = px;
      lastX = px;
    }
    if (firstX === null) return '';
    const gid = `wmg-${s.key}`;
    const area = `${line} L${lastX.toFixed(1)} ${baseY.toFixed(1)} L${firstX.toFixed(1)} ${baseY.toFixed(1)} Z`;
    return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${s.color}" stop-opacity="0.28"/>`
      + `<stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`
      + `<path d="${area}" fill="url(#${gid})" stroke="none"/>`
      + `<path class="wm-series-line" d="${line}" stroke="${s.color}"/>`;
  }

  function renderLegend(series) {
    $legend.innerHTML = series.map(s =>
      `<span class="wm-legend-item"><span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`
    ).join('');
  }

  // Axis tick label with enough precision that adjacent ticks differ. fmtK at
  // 1dp collapses e.g. 12,015 and 11,990 both to "12.0K"; this picks decimals
  // from the tick step so the real range is legible.
  function fmtTick(v, step) {
    const a = Math.abs(v);
    if (a >= 1000 || (a === 0 && step >= 1000)) {
      const dp = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / 1000))));
      return (v / 1000).toFixed(dp) + 'K';
    }
    const dp = Math.min(2, Math.max(0, Math.ceil(-Math.log10(step || 1))));
    return v.toFixed(dp);
  }

  // ── Small multiples (breakdown) ─────────────────────────────────
  // Collapsed = compact card; click a card to expand it to full width with a
  // detailed (full-axis) chart. expandedKey holds the expanded category key.
  const MINI     = { W: 320, H: 150, m: { top: 12, right: 12, bottom: 22, left: 48 } };
  const MINI_BIG = { W: 900, H: 300, m: { top: 16, right: 16, bottom: 30, left: 56 } };
  let expandedKey = null;

  const EXPAND_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"/></svg>`;
  const SHRINK_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9h4V5M19 9h-4V5M5 15h4v4M19 15h-4v4"/></svg>`;

  function lastValue(values, labels) {
    for (let i = labels.length - 1; i >= 0; i--) if (values.has(labels[i])) return values.get(labels[i]);
    return null;
  }

  function renderSmallMultiples(labels, series) {
    $chartBox.innerHTML = `<div class="wm-mini-grid">${series.map((s, idx) => {
      const last = lastValue(s.values, labels);
      const ex = expandedKey === s.key;
      return `<div class="wm-mini${ex ? ' expanded' : ''}" data-mini-key="${s.key}" title="${ex ? 'Click to shrink' : 'Click to enlarge'}">
        <div class="wm-mini-head">
          <span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}
          <span class="wm-mini-val" data-mini-val="${idx}">${last == null ? '–' : fmtK(last)}</span>
          <span class="wm-mini-expand">${ex ? SHRINK_ICON : EXPAND_ICON}</span>
        </div>
        ${miniSvg(s, labels, idx, ex)}
      </div>`;
    }).join('')}</div>`;
    series.forEach((s, idx) => wireMiniHover(idx, labels, s, expandedKey === s.key));
  }

  function miniSvg(s, labels, idx, expanded) {
    const { W, H, m } = expanded ? MINI_BIG : MINI;
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const n = labels.length;
    const x = i => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const dom = yDomain([s]);
    const y = v => m.top + ph - ((v - dom.min) / (dom.max - dom.min || 1)) * ph;

    let svg = '';
    if (expanded) {
      // Full axes: stepped y-ticks + thinned x-date labels.
      const ticks = Math.max(1, Math.round((dom.max - dom.min) / dom.step));
      for (let i = 0; i <= ticks; i++) {
        const val = dom.min + dom.step * i, yy = y(val);
        svg += `<line class="wm-grid-line" x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}"/>`;
        svg += `<text class="wm-axis-text" x="${m.left - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmtTick(val, dom.step)}</text>`;
      }
      const xstep = Math.max(1, Math.ceil(n / 8));
      for (let i = 0; i < n; i += xstep) {
        svg += `<text class="wm-axis-text" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${escapeHtml(pointLabel(labels[i]))}</text>`;
      }
    } else {
      // Compact: just the min/max bounds + first/last dates.
      for (const val of [dom.max, dom.min]) {
        const yy = y(val);
        svg += `<line class="wm-grid-line" x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}"/>`;
        svg += `<text class="wm-axis-text" x="${m.left - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmtTick(val, (dom.max - dom.min) || 1)}</text>`;
      }
      svg += `<text class="wm-axis-text" x="${x(0).toFixed(1)}" y="${H - 7}" text-anchor="start">${escapeHtml(pointLabel(labels[0]))}</text>`;
      svg += `<text class="wm-axis-text" x="${x(n - 1).toFixed(1)}" y="${H - 7}" text-anchor="end">${escapeHtml(pointLabel(labels[n - 1]))}</text>`;
    }
    svg += linePath(s, labels, x, y, n, m.top + ph);
    svg += `<line id="wm-mhl-${idx}" class="wm-hover-line" x1="0" y1="${m.top}" x2="0" y2="${m.top + ph}" style="display:none"/>`;
    return `<svg class="wm-mini-chart" id="wm-msvg-${idx}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`;
  }

  function wireMiniHover(idx, labels, s, expanded) {
    const svg = document.getElementById(`wm-msvg-${idx}`);
    const hl = document.getElementById(`wm-mhl-${idx}`);
    const valEl = $chartBox.querySelector(`[data-mini-val="${idx}"]`);
    if (!svg || !hl || !valEl) return;
    const { W, m } = expanded ? MINI_BIG : MINI;
    const pw = W - m.left - m.right, n = labels.length;
    const x = i => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const last = lastValue(s.values, labels);
    const resetText = last == null ? '–' : fmtK(last);

    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) / r.width * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - sx); if (d < bd) { bd = d; best = i; } }
      const lab = labels[best];
      hl.setAttribute('x1', x(best)); hl.setAttribute('x2', x(best)); hl.style.display = '';
      valEl.textContent = (s.values.has(lab) ? fmtK(s.values.get(lab)) : '–') + ' · ' + pointLabel(lab, true);
    });
    svg.addEventListener('mouseleave', () => { hl.style.display = 'none'; valEl.textContent = resetText; });
  }

  function niceNum(range, round) {
    if (range <= 0 || !isFinite(range)) return 1;
    const exp = Math.floor(Math.log10(range));
    const f = range / Math.pow(10, exp);
    const nf = round
      ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
      : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return nf * Math.pow(10, exp);
  }

  // Bracket the visible data with ~8% padding and round to nice ticks. The
  // floor is clamped at 0 (wealth can't be negative) but is otherwise NOT
  // pinned to zero, which is what makes small movements legible.
  function yDomain(visible) {
    let min = Infinity, max = -Infinity;
    for (const s of visible) for (const v of s.values.values()) { if (v < min) min = v; if (v > max) max = v; }
    if (!isFinite(min)) return { min: 0, max: 1, step: 1 };
    if (max === min) { const p = Math.abs(max) * 0.1 || 1; min -= p; max += p; }
    else { const p = (max - min) * 0.08; min -= p; max += p; }
    min = Math.max(0, min);
    const step = niceNum((max - min) / 4, true);
    const niceMin = Math.floor(min / step) * step;
    let niceMax = Math.ceil(max / step) * step;
    if (niceMax <= niceMin) niceMax = niceMin + step;
    return { min: niceMin, max: niceMax, step };
  }

  function shortLabel(label) {
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) { const [, m, d] = label.split('-'); return `${+d} ${mon[+m - 1]}`; }
    if (/^\d{4}-\d{2}$/.test(label)) { const [yr, m] = label.split('-'); return `${mon[+m - 1]} ${yr.slice(2)}`; }
    return label;
  }

  // A bucket shows its latest reading, so label it with that reading's date
  // rather than the bucket key, which marks where the interval ends. Empty
  // buckets fall back to the key.
  function pointLabel(label, describeGap = false) {
    const t = readingTimes.get(label);
    if (t) return shortLabel(t.slice(0, 10));
    if (!describeGap || chart.bucket === 'day') return shortLabel(label);
    return `${chart.bucket === 'week' ? 'Week' : 'Month'} to ${shortLabel(label)}`;
  }

  function wireHover(labels, series, x, n, W) {
    const svg = $chartBox.querySelector('svg');
    const $tt = document.getElementById('wm-tooltip');
    const $hl = document.getElementById('wm-hover-line');
    if (!svg || !$tt || !$hl) return;

    function locate(clientX) {
      const r = svg.getBoundingClientRect();
      const sx = (clientX - r.left) / r.width * W;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - sx); if (d < bestD) { bestD = d; best = i; } }
      return best;
    }
    function show(clientX) {
      const i = locate(clientX), lab = labels[i];
      $hl.setAttribute('x1', x(i)); $hl.setAttribute('x2', x(i)); $hl.style.display = '';
      let rows = '';
      for (const s of series) {
        if (!s.values.has(lab)) continue;
        const v = s.values.get(lab);
        rows += `<div class="wm-tt-row"><span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}<span class="wm-tt-val">${fmtK(v)}</span></div>`;
      }
      if (!rows) { $tt.innerHTML = `<div class="wm-tt-date">${escapeHtml(pointLabel(lab, true))} · no data</div>`; positionTip(i); return; }
      $tt.innerHTML = `<div class="wm-tt-date">${escapeHtml(pointLabel(lab, true))}</div>${rows}`;
      positionTip(i);
    }
    function positionTip(i) {
      const r = svg.getBoundingClientRect();
      const px = x(i) / W * r.width;
      const left = Math.min(Math.max(px + 12, 4), r.width - $tt.offsetWidth - 4);
      $tt.style.left = `${left}px`; $tt.style.top = `8px`; $tt.style.opacity = 1;
    }
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', () => { $tt.style.opacity = 0; $hl.style.display = 'none'; });
  }

  // ── Control wiring ──────────────────────────────────────────────
  $submit.addEventListener('click', handleSubmit);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-wm-recent-del]');
    if (del) { forgetUsername(del.dataset.wmRecentDel); return; }
    const pick = e.target.closest('[data-wm-recent]');
    if (pick) { $username.value = pick.dataset.wmRecent; handleSubmit(); }
  });
  $metricSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    chart.metric = b.dataset.metric;
    expandedKey = null;   // reset any expanded mini when switching views
    $metricSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderChart();
  });
  // Click a breakdown mini-chart to expand it to full width (and again to shrink).
  // Re-fit the Total chart when the box width changes (rotation, resize).
  let chartWidth = 0;
  new ResizeObserver(() => {
    const w = $chartBox.clientWidth;
    if (w === chartWidth) return;
    chartWidth = w;
    if (current && chart.metric !== 'breakdown') renderChart();
  }).observe($chartBox);
  $chartBox.addEventListener('click', e => {
    const card = e.target.closest('.wm-mini'); if (!card) return;
    const key = card.dataset.miniKey;
    expandedKey = (expandedKey === key) ? null : key;
    renderChart();
  });
  function syncRangeControls() {
    const { buckets } = wealthRange(chart.range);
    $rangeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.range === chart.range));
    $bucketSeg.querySelectorAll('button').forEach(x => {
      x.disabled = !buckets.includes(x.dataset.bucket);
      x.classList.toggle('active', x.dataset.bucket === chart.bucket);
    });
  }
  $rangeSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    chart.range = b.dataset.range;
    chart.bucket = wealthBucketFor(chart.range, chart.bucket);
    syncRangeControls();
    renderChart();
  });
  $bucketSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    chart.bucket = b.dataset.bucket;
    syncRangeControls();
    renderChart();
  });

  return {
    /**
     * Router/shell entry. Driven by the shared username in the home shell
     * (activate({u})); standalone (#wealth?u=…) it reads its own params.
     * Idempotent: re-runs the lookup only when the username changes.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      renderRecent();

      const u = (params && params.get && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; handleSubmit(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
