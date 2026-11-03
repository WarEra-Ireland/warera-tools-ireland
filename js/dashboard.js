/* ═══════════════════════════════════════════════════════════════════
 *  MY DASHBOARD  (powers the standalone #dashboard view)
 *
 *  A single-glance overview of the tools an Irish player uses most,
 *  styled after the personal warera-toie dashboard: columns of
 *  detailed cards (drag a card's handle to move it; the layout is saved),
 *  each with per-row breakdowns, status pills and a link out to the full
 *  tool.
 *
 *    🏭 Migration  — every company with its current region/bonus/tax and
 *                    a verdict ("✓ Best placed" or "→ Country · +X%")
 *    🎯 Products   — the most profitable product, how many companies make
 *                    it, and the top three by margin (ProductPickerTool)
 *    🎓 Training   — energy and the actions it covers, today's training
 *                    progress, what's waiting (hands, replacements,
 *                    mismatches) and the top three energy actions
 *                    (EmployeeTrainingTool.summary)
 *    ⏱ Managers    — how many managers are inactive, a status bar, and the
 *                    inactive and unknown ones listed (active ones folded)
 *    📈 Daily Profit— simplified projected income broken into rows
 *                    (companies + salary only — missions, case sales and
 *                    deductions are conditional, so they belong to the full
 *                    tool at #profit, which has controls for them)
 *    💰 Wealth      — current total, 7-day delta, gradient area chart
 *    🤝 Buddy       — buddies, open slots and players free to manage
 *    🔫 Military Unit— Irish-MU status; join CTA if not in one
 *
 *  This page is deliberately NOT linked from the home view — reached only
 *  via #dashboard (or #dashboard?u=<name>).
 *
 *  Reuse: the economic model (production-bonus maths, net-per-PP pricing,
 *  salary modelling) is ported from js/daily-profit.js. Managers load via
 *  ClockInTool.loadRows, and the Migration card calls
 *  AdvisorTool.loadPlacements, so the numbers agree with the full tools
 *  for everything this page actually shows.
 *
 *  Cards fill independently — cheap ones (Wealth, MU) land within a
 *  second; the heavy economy load (Migration + Profit) lands last. Each
 *  card owns its error state, so one failure never blanks the page.
 *
 *  Access: Irish-citizens-only via enforceIrishOnly (shared.js),
 *  honouring ?bypass=1.
 * ═══════════════════════════════════════════════════════════════════ */
const DashboardTool = (() => {
  const { FIDELITY_DAY1_PCT, FIDELITY_DAY5_PCT, META, ICON_FILE, skill, resolveUsername } = ProfitCore;

  const itemName = (code) => META[code]?.name || code || '—';
  function iconHtml(code) {
    const f = ICON_FILE[code];
    if (!f) return `<span class="dash-ic">📦</span>`;
    return `<span class="dash-ic"><img src="images/${f}" alt="" onerror="this.parentElement.textContent='📦'"></span>`;
  }

  // Production-bonus model lives in shared.js (computeProductionBonus).

  /* ── DOM ─────────────────────────────────────────────────────────── */
  const $username = document.getElementById('dash-username');
  const $load     = document.getElementById('dash-load');
  const $status   = document.getElementById('dash-status');
  const $grid     = document.getElementById('dash-grid');
  const $recent   = document.getElementById('dash-recent');
  const $resetOrder = document.getElementById('dash-reset-order');

  let running = false;
  let mounted = false;

  // Identifies this view as the resolved cache's owner, so its teardown
  // can't clear a cache another view has since claimed (see setTrpcCache).
  // Module scope: used by both the run path and the hashchange teardown.
  const CACHE_OWNER = 'dashboard';

  /* ── Helpers ─────────────────────────────────────────────────────── */
  const db_trpc = (ep, input) => trpc(ep, input, { retry: true });

  function setStatus(text, isError = false) {
    if (!text) { $status.classList.add('hidden'); return; }
    $status.textContent = text;
    $status.classList.toggle('error', isError);
    $status.classList.remove('hidden');
  }

  const fmtK = (v, dp = 1) => {
    if (v == null || !isFinite(v)) return '–';
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(dp) + 'M';
    if (Math.abs(v) >= 1000)      return (v / 1000).toFixed(dp) + 'K';
    return v.toFixed(dp).replace(/\.0$/, '');
  };
  const pct = (v) => (v == null || !isFinite(v)) ? '–' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  async function fetchJsonUrl(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) { if (res.status === 404) return null; throw new Error(`HTTP ${res.status}`); }
    return res.json();
  }

  /* ── Visual building blocks (toie style) ─────────────────────────── */
  function pill(label, kind) { return `<span class="dash-pill ${kind}">${escapeHtml(label)}</span>`; }
  const chip = (label, value) => `<span class="dash-chip"><i>${escapeHtml(label)}</i>${escapeHtml(String(value))}</span>`;

  /* ── Card scaffolding ────────────────────────────────────────────── */
  const CARDS = [
    { key: 'migration', icon: '🏭', title: 'Migration',     href: '#advisor' },
    { key: 'products',  icon: '🎯', title: 'Top products', href: '#products' },
    { key: 'training',  icon: '🎓', title: 'Employee Training', href: '#training' },
    { key: 'clockin',   icon: '⏱',  title: 'Managers',      href: '#clockin' },
    { key: 'profit',    icon: '📈', title: 'Daily Profit',  href: '#profit'  },
    { key: 'wealth',    icon: '💰', title: 'Wealth Trend',  href: '#wealth'  },
    { key: 'buddy',     icon: '🤝', title: 'Buddy Finder',  href: '#buddy-finder' },
    { key: 'mu',        icon: '🔫', title: 'Military Unit', href: '#mu'      },
  ];

  /* ── Card layout (localStorage) ──
   *  Cards sit in explicit columns, so a card only moves when it's dragged:
   *  dropping one never reshuffles the others between columns. A layout is
   *  saved per column count (a wide screen fits 3, a phone 1); a count with
   *  no saved layout deals the cards out round-robin, in the reading order
   *  of another saved layout or else the default order. Hidden (paused)
   *  cards keep their saved slot, and new cards join the shortest column. */
  const LAYOUT_KEY = 'dash:card-layout';
  const COL_MIN = 400, COL_GAP = 16;   // COL_GAP matches .dash-grid.cols' gap
  const readLayouts = () => { try { const o = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
  const writeLayouts = (o) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(o)); } catch { /* storage off */ } };
  const isLayout = (cols) => Array.isArray(cols) && cols.every(Array.isArray);
  // Reading order of a layout: row by row across the columns.
  const flatten = (cols) => {
    const out = [];
    for (let i = 0; cols.some(c => i < c.length); i++) cols.forEach(c => { if (i < c.length) out.push(c[i]); });
    return out;
  };
  function layoutFor(n, shown) {
    const layouts = readLayouts();
    let cols = isLayout(layouts[n]) && layouts[n].length === n ? layouts[n].map(c => c.filter(k => shown.includes(k))) : null;
    if (!cols) {
      const other = Object.values(layouts).find(isLayout);
      const order = other ? flatten(other) : CARDS.map(c => c.key);
      cols = Array.from({ length: n }, () => []);
      order.filter(k => shown.includes(k)).forEach((k, i) => cols[i % n].push(k));
    }
    const seen = new Set();
    cols = cols.map(c => c.filter(k => !seen.has(k) && seen.add(k)));
    shown.filter(k => !seen.has(k)).forEach(k => cols.reduce((a, b) => b.length < a.length ? b : a).push(k));
    return cols;
  }
  const colsOf  = () => [...$grid.children].filter(el => el.classList.contains('dash-col'));
  const cardsIn = (col) => [...col.children].filter(el => el.classList.contains('dash-card'));
  const currentLayout = () => colsOf().map(col => cardsIn(col).map(el => el.dataset.card));
  const colCount = () => Math.max(1, Math.floor(($grid.clientWidth + COL_GAP) / (COL_MIN + COL_GAP)));
  function saveLayout() {
    const cols = currentLayout(), n = cols.length;
    const prev = readLayouts()[n];
    if (isLayout(prev)) {   // put hidden cards back where they were
      const shown = new Set(cols.flat());
      prev.forEach((c, ci) => c.forEach((k, i) => {
        if (cols[ci] && !shown.has(k) && CARDS.some(x => x.key === k)) cols[ci].splice(Math.min(i, cols[ci].length), 0, k);
      }));
    }
    writeLayouts({ ...readLayouts(), [n]: cols });
    syncResetOrder();
  }
  function syncResetOrder() { $resetOrder?.classList.toggle('hidden', !Object.keys(readLayouts()).length || !cardEls.size); }

  let cardEls = new Map();   // key → card element, for the loaded account
  function arrange(n) {
    $grid.replaceChildren(...layoutFor(n, [...cardEls.keys()]).map(keys => {
      const col = document.createElement('div');
      col.className = 'dash-col';
      col.append(...keys.map(k => cardEls.get(k)));
      return col;
    }));
  }
  // Re-deal the columns when the width fits a different number of them.
  new ResizeObserver(() => {
    if (drag || !cardEls.size) return;
    const n = colCount();
    if (n !== colsOf().length) arrange(n);
  }).observe($grid);

  /* ── Smooth moves (FLIP) ──
   *  Measure every card, change the DOM, then animate each card from where
   *  it was to where it now is. Running animations are cancelled first so a
   *  card already sliding picks up from wherever it visually is. */
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const movers = () => [...$grid.querySelectorAll('.dash-card, .dash-ph')].filter(el => el !== drag?.card);
  function withFlip(mutate) {
    const els = movers();
    const first = new Map(els.map(el => [el, el.getBoundingClientRect()]));
    els.forEach(el => el.getAnimations().forEach(a => a.cancel()));
    mutate();
    if (reduceMotion()) return;
    movers().forEach(el => {
      const f = first.get(el); if (!f) return;
      const l = el.getBoundingClientRect();
      const dx = f.left - l.left, dy = f.top - l.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(.2, .7, .3, 1)' });
    });
  }

  /* ── Drag to reorder ──
   *  The dragged card lifts out and follows the pointer while a placeholder
   *  holds its landing spot. The spot is the column under the pointer, above
   *  the first card whose midpoint is below it. Midpoints come from layout
   *  (offsetTop), not the animated positions, and moving the placeholder
   *  pushes the next card further from the pointer, so the spot can't flip
   *  back and forth. Arrow keys on a focused handle move a card one place
   *  (up/down within its column, left/right across columns). */
  let drag = null;
  const LIFT = 'scale(1.02)';
  function placeDragged() { drag.card.style.transform = `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) ${LIFT}`; }
  function retarget() {
    const { x, y, ph } = drag;
    let col = null, best = Infinity;
    for (const c of colsOf()) {
      const r = c.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < best) { best = d; col = c; }
    }
    if (!col) return;
    const top = col.getBoundingClientRect().top;
    const before = cardsIn(col).find(el => y < top + el.offsetTop + el.offsetHeight / 2) || null;
    const unchanged = ph.parentElement === col && (before ? ph.nextElementSibling === before : !ph.nextElementSibling);
    if (!unchanged) withFlip(() => before ? before.before(ph) : col.append(ph));
  }
  function dragFrame() {
    const edge = 70, y = drag.y;
    if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 5));
    else if (y > innerHeight - edge) window.scrollBy(0, Math.ceil((y - innerHeight + edge) / 5));
    placeDragged();
    retarget();
    drag.raf = requestAnimationFrame(dragFrame);
  }
  function endDrag() {
    if (!drag) return;
    const { card, ph, raf, start } = drag;
    cancelAnimationFrame(raf);
    drag = null;
    const from = card.getBoundingClientRect();
    ph.replaceWith(card);
    card.style.cssText = '';
    card.classList.remove('dragging');
    $grid.classList.remove('is-dragging');
    const to = card.getBoundingClientRect();
    if (!reduceMotion()) card.animate(
      [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) ${LIFT}` }, { transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.2, .7, .3, 1)' });
    if (JSON.stringify(currentLayout()) !== start) saveLayout();
  }
  $grid.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.dash-drag');
    if (!handle || e.button !== 0 || drag) return;
    e.preventDefault();
    const card = handle.closest('.dash-card');
    card.getAnimations().forEach(a => a.cancel());
    const r = card.getBoundingClientRect();
    const start = JSON.stringify(currentLayout());
    const ph = document.createElement('div');
    ph.className = 'dash-ph';
    ph.style.height = `${r.height}px`;
    card.before(ph);
    handle.setPointerCapture(e.pointerId);
    drag = { card, ph, start, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY };
    Object.assign(card.style, { position: 'fixed', left: '0', top: '0', width: `${r.width}px`, zIndex: '50', pointerEvents: 'none' });
    card.classList.add('dragging');
    $grid.classList.add('is-dragging');
    $grid.append(card);   // out of its column; fixed, so it takes no space
    placeDragged();
    drag.raf = requestAnimationFrame(dragFrame);
  });
  $grid.addEventListener('pointermove', e => { if (drag) { drag.x = e.clientX; drag.y = e.clientY; } });
  $grid.addEventListener('pointerup', endDrag);
  $grid.addEventListener('pointercancel', endDrag);
  $grid.addEventListener('lostpointercapture', endDrag);
  $grid.addEventListener('keydown', e => {
    const handle = e.target.closest('.dash-drag');
    if (!handle || drag || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const card = handle.closest('.dash-card'), col = card.parentElement, cols = colsOf(), ci = cols.indexOf(col);
    let mutate = null;
    if (e.key === 'ArrowUp' && card.previousElementSibling) mutate = () => card.previousElementSibling.before(card);
    else if (e.key === 'ArrowDown' && card.nextElementSibling) mutate = () => card.nextElementSibling.after(card);
    else {
      const target = cols[ci + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : NaN)];
      if (target) {
        const idx = cardsIn(col).indexOf(card);
        mutate = () => { const ref = cardsIn(target)[idx]; ref ? ref.before(card) : target.append(card); };
      }
    }
    if (!mutate) return;
    withFlip(mutate);
    handle.focus();
    saveLayout();
  });

  function renderScaffold(username) {
    const u = encodeURIComponent(username);
    const tpl = document.createElement('template');
    tpl.innerHTML = CARDS.filter(c => !isPaused(c.href.slice(1))).map(c => `
      <section class="dash-card" id="dash-card-${c.key}" data-card="${c.key}">
        <header class="dash-card-head">
          <button type="button" class="dash-drag" title="Drag to move this card (or focus and use the arrow keys)" aria-label="Move the ${escapeHtml(c.title)} card">⠿</button>
          <span class="dash-card-icon">${c.icon}</span>
          <h3>${escapeHtml(c.title)}</h3>
          <span class="dash-card-note" id="dash-note-${c.key}"></span>
          <a class="dash-open" href="${c.href}?u=${u}" title="Open the full ${escapeHtml(c.title)} tool">Open →</a>
        </header>
        <div class="dash-card-body" id="dash-body-${c.key}">
          <div class="dash-skel"><span class="dash-spinner"></span> Loading…</div>
        </div>
      </section>`).join('');
    cardEls = new Map([...tpl.content.children].map(el => [el.dataset.card, el]));
    $grid.classList.add('cols');
    arrange(colCount());
    syncResetOrder();
  }
  const body = (key) => document.getElementById(`dash-body-${key}`);
  function setBody(key, html) { const el = body(key); if (el) el.innerHTML = html; }
  function setNote(key, text) { const el = document.getElementById(`dash-note-${key}`); if (el) el.textContent = text || ''; }
  function setError(key, msg) { setBody(key, `<div class="dash-err">${escapeHtml(msg)}</div>`); }
  function setHref(key, href) { const a = document.querySelector(`#dash-card-${key} .dash-open`); if (a) a.setAttribute('href', href); }
  // Big lead figure + supporting line, used by the simpler cards.
  function lead(value, sub) { return `<div class="dash-lead">${value}</div><div class="dash-sub">${sub}</div>`; }

  /* ── Card: Wealth Trend ── (toie-style: one chart; switch the metric via
   *  tabs — Total / Companies / Items / Money / Gear / Weapons — and the
   *  bucket via Day / Week / Month. The headline, delta and line colour all
   *  follow the selected metric.) ───────────────────────────────────── */
  const WEALTH_METRICS = [
    ['total',      'Total',     'var(--accent)'],
    ['companies',  'Companies', '#60a5fa'],
    ['items',      'Items',     '#fbbf24'],
    ['money',      'Money',     '#34d399'],
    ['equipments', 'Gear',      '#a78bfa'],
    ['weapons',    'Weapons',   '#f87171'],
  ];
  const wealthState = { snaps: [], metric: 'total', ...loadWealthView() };

  async function fillWealth(full) {
    try {
      const w = full?.stats?.wealth;
      if (!w || typeof w !== 'object') { setBody('wealth', lead('–', 'No wealth data available.')); return; }
      const hist = await fetchJsonUrl(`data/wealth/${full._id}.json?t=${Math.floor(Date.now() / 30000)}`).catch(() => null);
      let snaps = (hist && Array.isArray(hist.snapshots)) ? hist.snapshots.filter(s => typeof s.total === 'number') : [];
      // Live "now" point carries every component so every metric tab matches.
      snaps = snaps.concat([{ t: new Date().toISOString(), live: true, companies: w.companies, items: w.items, money: w.money, equipments: w.equipments, weapons: w.weapons, total: w.total }]);
      snaps.sort((a, b) => new Date(a.t) - new Date(b.t));
      wealthState.snaps = snaps; wealthState.metric = 'total'; Object.assign(wealthState, loadWealthView());

      setNote('wealth', `${snaps.length} record${snaps.length === 1 ? '' : 's'}`);

      if (snaps.length < 2) {
        setBody('wealth', lead(`₿${fmtK(w.total)}`, 'Tracking just started — the chart fills in as daily snapshots accumulate.'));
        return;
      }

      const metricTabs = WEALTH_METRICS.map(([k, label]) =>
        `<button class="dash-seg-btn${k === 'total' ? ' active' : ''}" data-val="${k}">${label}</button>`).join('');
      const rangeTabs = WEALTH_RANGES.map(r =>
        `<button class="dash-seg-btn" data-val="${r.key}" title="${r.title}">${r.label}</button>`).join('');
      setBody('wealth', `
        <div class="dash-seg-row">
          <div class="dash-seg wrap" data-group="metric">${metricTabs}</div>
        </div>
        <div class="dash-seg-row">
          <div class="dash-seg-field"><span class="dash-seg-label">Range</span>
            <div class="dash-seg" data-group="range">${rangeTabs}</div>
          </div>
          <div class="dash-seg-field"><span class="dash-seg-label">Bucket</span>
            <div class="dash-seg" data-group="bucket">
              <button class="dash-seg-btn" data-val="day">Day</button>
              <button class="dash-seg-btn" data-val="week">Week</button>
              <button class="dash-seg-btn" data-val="month">Month</button>
            </div>
          </div>
        </div>
        <div id="dash-wlead"></div>
        <div id="dash-wchart"></div>`);
      renderWealth();
      wireWealthTabs();
    } catch (e) { setError('wealth', `Couldn't load wealth: ${e.message}`); }
  }

  // Delta for a metric across the selected range: its first reading to its
  // latest, the same endpoints the chart line runs between.
  function wealthDelta(snaps, key, range, now) {
    const pts = wealthSnapshotsInRange(snaps, range, now).filter(s => typeof s[key] === 'number');
    if (pts.length < 2) return null;
    const base = pts[0], cur = pts[pts.length - 1][key];
    const change = cur - base[key];
    const pctv = base[key] ? change / base[key] * 100 : null;
    return { cur, change, pctv, since: base.t };
  }

  /* ── Wealth bucketing + charts ──
   *  Buckets the full snapshot history by day / week / month (one point per
   *  bucket = the latest reading in it), so the chart uses ALL stored
   *  history, not just the endpoints. */
  function bucketKey(iso, bucket, now) {
    const d = new Date(iso); if (isNaN(d)) return null;
    if (bucket === 'month') return wealthMonthBucketKey(iso, now);
    if (bucket === 'week')  return wealthWeekBucketKey(iso, now);
    return iso.slice(0, 10);
  }
  function bucketedSeries(snaps, key, bucket, now = new Date()) {
    const m = new Map();
    for (const s of snaps) {
      const bk = bucketKey(s.t, bucket, now); if (!bk) continue;
      const v = s[key]; if (typeof v !== 'number') continue;
      const prev = m.get(bk); if (!prev || s.t > prev.t) m.set(bk, { t: s.t, v });
    }
    const pts = [...m.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
    // Start the line at the range's first reading, which its bucket's latest
    // reading would otherwise hide (a week range would start 6 days late).
    const open = snaps.filter(s => typeof s[key] === 'number').reduce((a, s) => (!a || s.t < a.t ? s : a), null);
    if (open && pts.length && pts[0].t !== open.t) pts.unshift({ t: open.t, v: open[key] });
    return pts;
  }

  // preserveAspectRatio "none" stretches to full width; non-scaling-stroke
  // keeps the 2px line crisp despite the horizontal scaling.
  const CW = 600, CPAD = { t: 8, r: 6, b: 6, l: 6 };
  function geom(points, height) {
    const vals = points.map(p => p.v);
    const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    const n = points.length, pw = CW - CPAD.l - CPAD.r, ph = height - CPAD.t - CPAD.b;
    const times = points.map(p => new Date(p.t).getTime());
    const timeSpan = times[n - 1] - times[0];
    const x = i => CPAD.l + (timeSpan ? (times[i] - times[0]) / timeSpan * pw : pw / 2);
    const y = v => CPAD.t + ph - ((v - min) / span) * ph;
    return { x, y, n, baseY: CPAD.t + ph };
  }
  function areaSvg(points, { color, gradId, height, hlId }) {
    const g = geom(points, height);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)} ${g.y(p.v).toFixed(1)}`).join('');
    const area = `${line} L${g.x(g.n - 1).toFixed(1)} ${g.baseY} L${g.x(0).toFixed(1)} ${g.baseY} Z`;
    const hl = hlId ? `<line id="${hlId}" class="dash-chart-hl" x1="0" y1="${CPAD.t}" x2="0" y2="${g.baseY}" style="display:none" vector-effect="non-scaling-stroke"/>` : '';
    return `<svg class="dash-chart" style="height:${height}px" viewBox="0 0 ${CW} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gradId})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>${hl}
    </svg>`;
  }
  function renderWealth() {
    const { snaps, metric, bucket, range } = wealthState;
    const [key, label, color] = WEALTH_METRICS.find(m => m[0] === metric) || WEALTH_METRICS[0];

    const now = new Date();
    const $lead = document.getElementById('dash-wlead');
    if ($lead) {
      const d = wealthDelta(snaps, key, range, now);
      if (!d) { $lead.innerHTML = `<div class="dash-wlead-row"><span class="dash-lead">–</span></div>`; }
      else {
        const cls = d.change >= 0 ? 'dash-pos' : 'dash-neg';
        const arrow = d.change >= 0 ? '▲' : '▼';
        $lead.innerHTML = `<div class="dash-wlead-row">
          <span class="dash-lead">₿${fmtK(d.cur)}</span>
          <span class="dash-wdelta ${cls}">${arrow} ₿${fmtK(Math.abs(d.change))}${d.pctv != null ? ` (${pct(d.pctv)})` : ''} since ${escapeHtml(fmtDateShort(d.since))}</span>
          <span class="dash-wmetric" style="color:${color}">· ${escapeHtml(label)}</span>
        </div>`;
      }
    }

    const cont = document.getElementById('dash-wchart'); if (!cont) return;
    const pts = bucketedSeries(wealthSnapshotsInRange(snaps, range, now), key, bucket, now);
    if (pts.length < 2) { cont.innerHTML = `<div class="dash-chart-note">Only ${pts.length} ${bucket}-point in this range. Try Day or a wider range.</div>`; return; }
    cont.innerHTML = `<div class="dash-chart-wrap">
      ${areaSvg(pts, { color, gradId: 'g_w', height: 130, hlId: 'dash-chl' })}
      <div class="dash-chart-tip" id="dash-chart-tip"></div>
      <div class="dash-chart-axis"><span>${escapeHtml(fmtDateShort(pts[0].t))}</span><span class="dash-chart-hint">tap chart for a date</span><span>now</span></div>
    </div>`;
    wireChartHover(pts);
  }
  function wireWealthTabs() {
    const card = document.getElementById('dash-card-wealth'); if (!card) return;
    const syncRangeControls = () => {
      const { buckets } = wealthRange(wealthState.range);
      card.querySelectorAll('[data-group="range"] .dash-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === wealthState.range));
      card.querySelectorAll('[data-group="bucket"] .dash-seg-btn').forEach(b => {
        b.disabled = !buckets.includes(b.dataset.val);
        b.classList.toggle('active', b.dataset.val === wealthState.bucket);
      });
    };
    syncRangeControls();
    card.addEventListener('click', e => {
      const btn = e.target.closest('.dash-seg-btn'); if (!btn || btn.disabled) return;
      const group = btn.parentElement.dataset.group, val = btn.dataset.val;
      if (group === 'metric') {
        wealthState.metric = val;
        btn.parentElement.querySelectorAll('.dash-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      } else if (group === 'range') {
        wealthState.range = val;
        wealthState.bucket = wealthBucketFor(val, wealthState.bucket);
        saveWealthView(wealthState.range, wealthState.bucket);
        syncRangeControls();
      } else {
        wealthState.bucket = val;
        saveWealthView(wealthState.range, wealthState.bucket);
        syncRangeControls();
      }
      renderWealth();
    });
  }
  function wireChartHover(points) {
    const svg = document.querySelector('#dash-card-wealth .dash-chart');
    const hl  = document.getElementById('dash-chl');
    const tip = document.getElementById('dash-chart-tip');
    if (!svg || !hl || !tip) return;
    const g = geom(points, 130);
    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const sx = (clientX - r.left) / r.width * CW;
      let best = 0, bd = Infinity;
      for (let i = 0; i < g.n; i++) { const d = Math.abs(g.x(i) - sx); if (d < bd) { bd = d; best = i; } }
      hl.setAttribute('x1', g.x(best)); hl.setAttribute('x2', g.x(best)); hl.style.display = '';
      tip.textContent = `₿${fmtK(points[best].v)} · ${fmtDateShort(points[best].t)}`;
      tip.style.left = `${Math.min(Math.max((g.x(best) / CW) * r.width, 30), r.width - 30)}px`;
      tip.style.opacity = 1;
    };
    svg.addEventListener('mousemove', e => move(e.clientX));
    svg.addEventListener('touchmove', e => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', () => { hl.style.display = 'none'; tip.style.opacity = 0; });
  }
  function fmtDateShort(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return '?'; }
  }

  /* ── Card: Military Unit ─────────────────────────────────────────── */
  async function fillMU(full) {
    const findCta = `<a class="dash-cta" href="#mu?u=${encodeURIComponent(full.username)}">Find an Irish MU →</a>`;
    try {
      if (!full.mu) {
        setHref('mu', `#mu?u=${encodeURIComponent(full.username)}`);
        setBody('mu', `${pill('Not in a unit', 'loss')}
          <div class="dash-sub">Join an Irish military unit to fight together and earn rewards.</div>${findCta}`);
        return;
      }
      const mu = await db_trpc('mu.getById', { muId: full.mu }).catch(() => null);
      const name = mu?.name || 'your unit';
      const members = Array.isArray(mu?.members) ? mu.members.length : null;
      const link = `<a href="${GAME_BASE}/mu/${escapeHtml(full.mu)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
      const chips = members != null ? `<div class="dash-chips">${chip('Members', members)}</div>` : '';
      if (mu?.country === IRELAND_COUNTRY_ID) {
        setBody('mu', `${pill('🇮🇪 Irish unit', 'ok')}
          <div class="dash-sub">Member of ${link}.</div>${chips}`);
      } else {
        setBody('mu', `${pill('Not Irish-based', 'warn')}
          <div class="dash-sub">You're in ${link}, which isn't Irish-based. Consider an Irish unit.</div>${chips}${findCta}`);
      }
    } catch (e) { setError('mu', `Couldn't load unit: ${e.message}`); }
  }

  /* ── Card: Buddy system ──────────────────────────────────────────── */
  // The Irish buddy pool: buddies (Irish managers), open slots, the
  // player's own manager job, and the players free to manage, most open
  // slots first, using Buddy Finder's own scan.
  async function fillBuddy(full) {
    const u = encodeURIComponent(full.username);
    try {
      const { mine, roster } = await BuddyFinderTool.loadBuddyPool(full);
      const n = mine.buddies.length;
      setNote('buddy', `${mine.openSlots} open slot${mine.openSlots === 1 ? '' : 's'}`);
      const link = b => `<a href="${GAME_BASE}/user/${escapeHtml(b._id)}" target="_blank" rel="noopener">${escapeHtml(b.username)}</a>`;
      const job = mine.job
        ? ` You manage a company for ${mine.employer ? link(mine.employer) : 'an Irish player'}.`
        : ' You are free to manage a company for someone.';
      const status = n
        ? `<div class="dash-statline">${pill(`🤝 ${n} ${n === 1 ? 'buddy' : 'buddies'}`, 'ok')}</div>`
        : `<div class="dash-note">${pill('No buddies', 'muted')}<span>You could use some buddies${mine.companies > 1 ? `, one for each of your ${mine.companies} companies` : ''}.${job}</span></div>`;
      const free = roster.filter(p => p.id !== full._id && ManagerCore.canManage(p)).sort(ManagerCore.rankRoster);
      const row = (p, i) => `<div class="dash-row">
          <div class="dash-row-main">
            <div class="dash-row-title"><span class="dash-rank">${i + 1}</span><a href="${GAME_BASE}/user/${escapeHtml(p.user._id)}" target="_blank" rel="noopener"><strong>${escapeHtml(p.user.username)}</strong> ↗</a></div>
            <span class="dash-top-v">${ManagerCore.points(p.user)}<small>/11</small></span>
          </div>
          <div class="dash-sub small">${p.openSlots} of ${p.companies} manager job${p.companies === 1 ? '' : 's'} available</div>
        </div>`;
      const list = free.length
        ? `<div class="dash-top"><div class="dash-top-h">Free to manage<span>${free.length} player${free.length === 1 ? '' : 's'}, most jobs available first</span></div><div class="dash-rows">${free.slice(0, 3).map(row).join('')}</div></div>`
        : '<div class="dash-sub">No Irish players are free to manage right now.</div>';
      setBody('buddy', `${status}${list}<a class="dash-cta" href="#buddy-finder?u=${u}">See the Irish roster →</a>`);
    } catch (e) { setError('buddy', `Couldn't load the buddy pool: ${e.message}`); }
  }

  /* ── Card: Managers ── inactive managers first. Vacancies belong to the
   *  Buddy card, so they only get a footer link here. A manager whose
   *  status couldn't be read stays "unknown", never inactive. */
  async function fillClockin(full) {
    try {
      const rows = await ClockInTool.loadRows(full._id);
      if (!rows.length) {
        setBody('clockin', lead('No companies', 'No active companies found for this account.'));
        return;
      }
      const u = encodeURIComponent(full.username);
      const contracts = rows.filter(r => r.manager);
      const vacant = rows.length - contracts.length;
      setNote('clockin', contracts.length ? `${contracts.length} manager${contracts.length === 1 ? '' : 's'}` : '');
      if (!contracts.length) {
        setBody('clockin', `<div class="dash-lead">No managers</div><div class="dash-sub">None of your ${rows.length} companies has a manager, so there is nothing to watch here. <a href="#buddy-finder?u=${u}">Find a buddy →</a></div>`);
        return;
      }
      const now = Date.now();
      const time = v => { const ms = v ? new Date(v).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };
      const ago = v => {
        const ms = time(v);
        if (ms == null) return null;
        const min = Math.max(0, (now - ms) / 60000);
        return min < 1 ? 'now' : min < 60 ? `${Math.round(min)}m` : min < 2880 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
      };
      const lastLogin = r => time(r.profile?.dates?.lastConnectionAt) ?? 0;
      const stalest = (a, b) => lastLogin(a) - lastLogin(b);
      const inactive = contracts.filter(r => r.manager.isInactive === true).sort(stalest);
      const active = contracts.filter(r => r.manager.isInactive === false).sort(stalest);
      const unknown = contracts.filter(r => r.manager.isInactive !== true && r.manager.isInactive !== false);

      const n = contracts.length;
      const head = inactive.length
        ? `<div class="dash-mgr-head"><span class="dash-mgr-big dash-neg">${inactive.length}</span><span>of ${n} managers ${inactive.length === 1 ? 'is' : 'are'} inactive</span></div>`
        : `<div class="dash-mgr-head"><span class="dash-mgr-big">${active.length}/${n}</span><span>managers active${unknown.length ? `, ${unknown.length} unknown` : ''}</span></div>`;
      const seg = (cls, count) => count ? `<i class="${cls}" style="flex:${count}"></i>` : '';
      const bar = `<div class="dash-mgr-bar">${seg('bad', inactive.length)}${seg('unk', unknown.length)}${seg('ok', active.length)}</div>
        <div class="dash-mgr-keys">${[['bad', inactive, 'inactive'], ['unk', unknown, 'unknown'], ['ok', active, 'active']]
          .filter(([, list]) => list.length).map(([cls, list, label]) => `<span><i class="dash-mgr-dot ${cls}"></i>${list.length} ${label}</span>`).join('')}</div>`;
      const row = r => {
        const kind = r.manager.isInactive === true ? 'bad' : r.manager.isInactive === false ? 'ok' : 'unk';
        const name = r.profile
          ? `<a href="${GAME_BASE}/user/${encodeURIComponent(r.manager.user)}" target="_blank" rel="noopener">${escapeHtml(r.profile.username || `User ${r.manager.user.slice(-6)}`)}</a>`
          : 'Profile not loaded';
        const login = ago(r.profile?.dates?.lastConnectionAt);
        const care = ago(r.profile?.dates?.lastManagerCareAt);
        const when = kind === 'unk' || !r.profile
          ? '<b>Unknown</b>couldn\'t load activity'
          : `<b title="Last login">${login ?? 'Unknown'}</b>${care ? `care ${care === 'now' ? 'just now' : `${care} ago`}` : 'care unknown'}`;
        return `<div class="dash-mgr-row ${kind}"><i class="dash-mgr-dot ${kind}"></i>
          <div class="dash-mgr-who"><span class="dash-mgr-name">${name}</span><span class="dash-mgr-co">${escapeHtml(r.company.name || 'Company')}</span></div>
          <div class="dash-mgr-when">${when}</div></div>`;
      };
      const exceptions = [...inactive, ...unknown];
      const list = exceptions.length ? `<div class="dash-mgr-list">${exceptions.map(row).join('')}</div>` : '';
      const rest = active.length
        ? `<details class="dash-more"><summary>Show ${active.length} active manager${active.length === 1 ? '' : 's'}</summary><div class="dash-mgr-list">${active.map(row).join('')}</div></details>`
        : '';
      const foot = vacant
        ? `<div class="dash-mgr-foot">${vacant} ${vacant === 1 ? 'company has' : 'companies have'} no manager. <a href="#buddy-finder?u=${u}">Find a buddy →</a></div>`
        : '';
      setBody('clockin', head + bar + list + rest + foot);
    } catch (e) { setError('clockin', `Couldn't load managers: ${e.message}`); }
  }

  /* ── Heavy shared load: economy (Profit + Migration) ─────────────── */
  async function fillEconomy(full, companiesP, workersP) {
    try {
      const companyList = await companiesP;
      if (!companyList?.items?.length) {
        setBody('profit', lead('No companies', 'You own no companies to project profit from.'));
        return;
      }

      const model = await ProfitCore.loadModel(full, { companyList, workersData: workersP, fullUser: full });
      const { companies, countryById, regionsByCountry } = model;
      if (!companies.length) {
        setBody('profit', lead('No active companies', 'All your companies are disabled.'));
        return;
      }

      // ── Profit ──
      // Rows are the full tool's product table at its defaults (no what-ifs).
      const rows = ProfitCore.buildRows(model);
      // Headline: today's output, i.e. each product's Actual.
      const companiesIncome = rows.reduce((sum, r) => sum + (r.actual ?? 0), 0);
      // Companies + salary only, on purpose. Mission money and case sales are
      // conditional on what you actually completed and sold, and this card has
      // no controls to say otherwise — the full tool does, so it owns them.
      // The card would rather understate than assert income you can't correct.
      const total = companiesIncome + model.salaryDaily;

      // Top products: the full tool's Total max — every engine plus your
      // staff on that product at its best-bonus region, each hire costed at
      // no less than the market wage. A loss-making staff contribution is
      // floored at 0.
      const topProducts = rows.filter(r => r.totalMax != null)
        .sort((a, b) => b.totalMax - a.totalMax).slice(0, 3);
      const hasStaff = model.employees.length > 0 || model.selfPPbase > 0;

      const incRow = (label, value, sub) =>
        `<div class="dash-inc"><span class="dash-inc-l">${escapeHtml(label)}</span><span class="dash-inc-v">₿${fmtK(value)}</span><span class="dash-inc-s">${escapeHtml(sub)}</span></div>`;
      // One short line per product so it stays readable on a phone; the full
      // breakdown sits in the row's tooltip for desktop.
      const topRow = (r, i) => {
        const where = r.country
          ? `${escapeHtml(r.country.name)} · ${pct(r.bonus)} bonus`
          : 'No bonus region';
        // What to offer a hire there: the market net wage grossed up for that
        // country's income tax — the same wage the ₿/day projection charges.
        const wage = r.lowWage == null ? ''
          : ` · wage ${r.lowWage.toFixed(3)}${r.tax != null ? ` (${r.tax}% tax)` : ''}`;
        // Can a new hire at that wage pay for themselves here?
        const verdict = r.employeeProfitDay1 == null ? ''
          : r.employeeProfitDay1 >= 0 ? pill('✅ Hire profitable', 'ok')
          : r.employeeProfitDay5 >= 0 ? pill('🟡 Hire profitable by day 5', 'warn')
          : pill('❌ Hire unprofitable', 'loss');
        const sale = ProfitCore.price(model, r.code);
        const detail = [
          r.region ? `Best region: ${r.region.name}` : null,
          r.employeeProfitDay1 == null ? null
            : `New hire (${fmtK(model.genericWorker.basePP)} base PP) at wage ${r.lowWage.toFixed(3)}, tested at ${FIDELITY_DAY1_PCT}% fidelity on day 1 and ${FIDELITY_DAY5_PCT}% by day 5`,
          `Sells ₿${sale.toFixed(3)} · margin ₿${(sale - ProfitCore.rawCostOf(model, r.code)).toFixed(3)}/item · ₿${r.netPP.toFixed(4)}/PP`,
          `Engines ₿${fmtK(r.maxCompany)}${hasStaff ? ` + staff ₿${fmtK(Math.max(r.maxEmployee, 0))}` : ''}`,
        ].filter(Boolean).join('\n');
        return `<div class="dash-row top" title="${escapeHtml(detail)}">
          <div class="dash-row-main">
            <div class="dash-row-title"><span class="dash-rank">${i + 1}</span>${iconHtml(r.code)} <strong>${escapeHtml(itemName(r.code))}</strong>${r.makesIt ? ' ' + pill('You make this', 'ok') : ''}</div>
            <span class="dash-top-v">₿${fmtK(r.totalMax)}<small>/day</small></span>
          </div>
          <div class="dash-sub small">${where}${wage}</div>
          ${verdict ? `<div class="dash-hire">${verdict}</div>` : ''}
        </div>`;
      };
      setNote('profit', `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);
      setBody('profit', `
        <div class="dash-lead">₿${fmtK(total)}<small>/day</small></div>
        <div class="dash-sub">Companies and salary. Missions and case sales live in the full tool, where you can tick what you actually did.</div>
        <div class="dash-inc-list">
          ${incRow('Companies', companiesIncome, `${companies.length} active, current output`)}
          ${incRow('Salary', model.salaryDaily, model.salaryCount ? `~${model.salaryWorksPerDay.toFixed(0)} works/day × ${model.salaryAvgPerWork.toFixed(2)} net` : 'no recent wages')}
        </div>
        ${topProducts.length ? `
        <div class="dash-top">
          <div class="dash-top-h">Most profitable products <span>all your output, market wages</span></div>
          <div class="dash-rows">${topProducts.map((t, i) => topRow(t, i)).join('')}</div>
        </div>` : ''}
        <a class="dash-cta" href="#profit?u=${encodeURIComponent(full.username)}">Compare every product →</a>`);
    } catch (e) {
      setError('profit', `Couldn't load economy: ${e.message}`);
    }
  }

  /* ── Card: Top products ── (most profitable product, from the full
   *  tool's own loader and maths so the two can't disagree) ─────────── */
  async function fillProducts(full) {
    try {
      const PP = ProductPickerTool;
      const name = code => PP.ITEMS[code]?.name || code;
      const model = await PP.loadModel(full);
      const { rows } = PP.productRows(model);
      const ranked = rows.filter(r => r.mg);
      if (!ranked.length) { setBody('products', lead('–', 'No market prices available right now.')); return; }
      const best = ranked[0];
      const n = model.companies.length;
      setNote('products', `${n} compan${n === 1 ? 'y' : 'ies'}`);

      const making = best.owned;

      const missing = model.companies.filter(c => c.statsMissing).length;
      const warn = missing
        ? `<div class="dash-warn">${pill('⚠ Employee data missing', 'warn')}<span>${model.statsNeedPremium
            ? 'Employee output and wages need a Premium API key, and the data proxy has none right now.'
            : `Couldn't load output history for ${missing} of ${n} companies.`} Profit figures leave employees out.</span></div>`
        : '';

      const topRow = (r, i) => `<div class="dash-row top">
          <div class="dash-row-main">
            <div class="dash-row-title"><span class="dash-rank">${i + 1}</span>${iconHtml(r.code)} <strong>${escapeHtml(name(r.code))}</strong>${r.owned ? ' ' + pill(`You make ×${r.owned}`, 'ok') : ''}</div>
            <span class="dash-top-v">${r.mg.perPP.toFixed(3)}<small>/PP</small></span>
          </div>
        </div>`;

      setBody('products', `
        ${warn}
        <div class="dash-row-main">
          <div class="dash-product-heading">
            <div class="dash-lead dash-pick">${iconHtml(best.code)} ${escapeHtml(name(best.code))}</div>
            ${making ? pill(`You make ×${making}`, 'ok') : ''}
          </div>
          <span class="dash-top-v" title="Margin per production point, based on recent market trades">${best.mg.perPP.toFixed(3)}<small>/PP</small></span>
        </div>
        <p class="dp-muted">Current prices only. Rankings change, and switching products affects employee specialisation and trait bonuses.</p>
        ${ranked.length > 1 ? `<div class="dash-top">
          <div class="dash-top-h">Top products <span>margin per PP</span></div>
          <div class="dash-rows">${ranked.slice(1, 3).map((r, i) => topRow(r, i + 1)).join('')}</div>
        </div>` : ''}
        <a class="dash-cta" href="#products?u=${encodeURIComponent(full.username)}">Compare every product →</a>`);
    } catch (e) { setError('products', `Couldn't load products: ${e.message}`); }
  }

  /* ── Card: Migration ── (companies outside Irish core regions) ────── */
  /* ── Card: Employee Training ──
   *  Loads through the Training page itself (EmployeeTrainingTool.summary),
   *  so its numbers match the page's Overview and opening it is instant.
   *  Card pricing and the assignment planner finish in the background;
   *  watch() redraws the card as they land. Rows rank by career profit,
   *  as Next actions does, and show it averaged per working day. ─────── */
  let trainingUnwatch = null;
  async function fillTraining(full) {
    trainingUnwatch?.();
    trainingUnwatch = null;
    const mine = s => s.username.toLowerCase() === full.username.toLowerCase();
    try {
      const s = await EmployeeTrainingTool.summary(full.username);
      if (!mine(s) || !body('training')) return;
      renderTraining(s);
      trainingUnwatch = EmployeeTrainingTool.watch(next => { if (mine(next) && body('training')) renderTraining(next); });
    } catch (e) { setError('training', `Couldn't load employees: ${e.message}`); }
  }

  function renderTraining(s) {
    const u = encodeURIComponent(s.username);
    const link = (q = '') => `#training?u=${u}${q}`;
    const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
    const cta = `<a class="dash-cta" href="${link()}">Plan today's training →</a>`;
    if (!s.employees) { setNote('training', ''); setBody('training', lead('No employees', 'Hire into one of your companies to start training.') + cta); return; }
    setNote('training', plural(s.employees, 'employee'));

    const energy = s.energy == null ? '' : `${s.energy}${s.energyMax ? ` / ${s.energyMax}` : ''} energy`;
    const head = s.actions == null ? `<div class="dash-lead">–<small>energy unavailable</small></div>`
      : s.actions > 0 ? `<div class="dash-lead">${plural(s.actions, 'action')}<small>${energy} · ${escapeHtml(s.energyFull.replace(/^./, c => c.toLowerCase()))}</small></div>`
      : `<div class="dash-lead">No actions yet<small>${energy}${s.tenIn != null ? ` · 10 more in ${escapeHtml(formatDuration(s.tenIn))}` : ''}</small></div>`;
    const share = n => s.trainable ? (n / s.trainable * 100).toFixed(1) : 0;
    const progress = s.trainable ? `
      <div class="dash-sub">${s.trained} of ${s.trainable} trained today · resets 00:00 UTC, in ${escapeHtml(formatDuration(s.untilReset))}</div>
      <div class="dash-train-bar" role="img" aria-label="${s.trained} trained, ${s.hands} with a hand waiting, of ${s.trainable}">
        <i class="done" style="width:${share(s.trained)}%"></i><i class="hand" style="width:${share(s.hands)}%"></i>
      </div>` : `<div class="dash-sub">Everyone is fully trained.</div>`;

    const pillLink = (label, kind, q) => `<a class="dash-pill ${kind}" href="${link(q)}">${escapeHtml(label)}</a>`;
    const pills = [
      s.hands ? pillLink(`🃏 ${plural(s.hands, 'hand')} waiting`, 'warn', '') : '',
      s.moves ? pillLink(`🧭 ${plural(s.moves, 'move')} instead of replacing`, 'info', '&tab=assignments') : '',
      s.replace ? pillLink(`${s.replace} to replace`, 'loss', '&tab=keep') : '',
      s.mismatches ? pillLink(plural(s.mismatches, 'mismatch', 'mismatches'), 'warn', '&tab=assignments') : '',
    ].filter(Boolean);

    const money = v => `${v < 0 ? '−' : '+'}₿${Math.abs(v).toFixed(3)}`;
    let cut = false;
    const rows = s.top.map((a, i) => {
      const line = !cut && a.belowSelf ? (cut = true, `<div class="dash-train-cut">Below here, self-work earns more</div>`) : '';
      const what = a.kind === 'hire' ? `Hire into <strong>${escapeHtml(a.company)}</strong>`
        : `${a.kind === 'train' ? 'Train' : 'Replace'} <strong>${escapeHtml(a.name)}</strong>`;
      const q = a.kind === 'hire' ? '&tab=hire' : `&tab=${a.kind === 'train' ? 'train' : 'keep'}&emp=${encodeURIComponent(a.emp)}`;
      const value = a.perDay != null ? `${money(a.perDay)}<small>/day</small>` : `≈ ${a.pp >= 0 ? '+' : '−'}${Math.abs(a.pp).toFixed(1)}<small> PP</small>`;
      return `${line}<a class="dash-row dash-train-row" href="${link(q)}">
          <div class="dash-row-main">
            <div class="dash-row-title"><span class="dash-rank">${i + 1}</span>${iconHtml(a.itemCode)}<span>${what}<span class="dash-sub small">${a.kind === 'hire' ? '' : `${escapeHtml(a.company)} · `}${escapeHtml(a.detail)}</span></span></div>
            <span class="dash-top-v${a.perDay != null && a.perDay < 0 ? ' dash-neg' : ' dash-pos'}">${value}</span>
          </div>
        </a>`;
    }).join('');

    setBody('training', `
      ${head}
      ${progress}
      ${pills.length ? `<div class="dash-chips">${pills.join('')}</div>` : ''}
      <div class="dash-top">
        <div class="dash-top-h">Best uses of energy <span>ranked by career profit${s.pricing ? ' · valuing moves…' : ''}</span></div>
        ${rows ? `<div class="dash-rows">${rows}</div>` : '<div class="dash-sub">Nothing to train, hire or replace right now.</div>'}
      </div>
      ${cta}`);
  }

  async function fillMigration(full) {
    try {
      const { placements } = await AdvisorTool.loadPlacements(full._id);
      if (!placements.length) {
        setBody('migration', lead('No companies', 'Buy a company first.'));
        return;
      }
      setNote('migration', `${placements.length} compan${placements.length === 1 ? 'y' : 'ies'}`);
      const away = placements.filter(p => p.status !== 'home');
      if (!away.length) {
        setBody('migration', `<div class="dash-statline"><span class="dash-pos">🇮🇪 All ${placements.length} compan${placements.length === 1 ? 'y is' : 'ies are'} home in Irish core regions</span></div>`);
        return;
      }
      const foreignTax = away.reduce((sum, p) => sum + (p.status === 'abroad' ? p.taxPaid || 0 : 0), 0);
      const row = p => {
        const c = p.company;
        const where = `${escapeHtml(p.side.region?.name || '—')}${p.side.country ? ' · ' + escapeHtml(p.side.country.name) : ''}`;
        const verdict = p.status === 'abroad'
          ? `<span class="dash-verdict move">→ Ireland<b>${pct(p.gain)} output</b></span>`
          : `<span class="dash-verdict move">→ Irish core region<b>${pct(p.gain)} output</b></span>`;
        const tax = p.status === 'abroad' && p.taxPaid > 0 ? ` · ₿${fmtK(p.taxPaid)} tax abroad (7d)` : '';
        return `<div class="dash-row mig">
          <div class="dash-row-main">
            <div class="dash-row-title">${iconHtml(c.itemCode)} <strong>${escapeHtml(c.name || itemName(c.itemCode))}</strong>${p.freeMove ? ' ' + pill('Free move', 'ok') : ''}</div>
            ${verdict}
          </div>
          <div class="dash-sub small">${escapeHtml(itemName(c.itemCode))} · ${where}${tax}</div>
        </div>`;
      };
      const who = away.length === 1 ? '1 company is' : `${away.length} companies are`;
      setBody('migration', `
        <div class="dash-warn">${pill('⚠ Bring it home', 'warn')}
          <span>${who} outside Irish core regions${foreignTax > 0 ? `, and about <strong>₿${fmtK(foreignTax)}</strong> of wage tax went abroad this week` : ''}.</span></div>
        <div class="dash-rows">${away.map(row).join('')}</div>
        <a class="dash-cta" href="#advisor?u=${encodeURIComponent(full.username)}">Plan the move →</a>`);
    } catch (e) { setError('migration', `Couldn't load companies: ${e.message}`); }
  }

  /* ── Orchestration ───────────────────────────────────────────────── */
  /*
   *  No step panel here, so rate-limit waits surface on the status line
   *  instead. Without this the tool sits silent for as long as the API's
   *  window has left to run, which reads as a hang rather than a wait.
   */
  function reportRateLimit(waitMs, itemCount) {
    setStatus(`Rate limited by the game API — retrying ${itemCount} request${itemCount === 1 ? '' : 's'} in ${Math.ceil(waitMs / 1000)}s…`);
  }

  async function run() {
    if (running) return;
    const raw = $username.value.trim();
    if (!raw) { $username.focus(); return; }

    running = true;
    $load.disabled = true;
    setStatus('');
    setRateLimitHandler(reportRateLimit);
    setTrpcCache(true, CACHE_OWNER);   // dedupe the country/profile fetches shared across cards
    cardEls = new Map();
    $grid.classList.remove('cols');
    $grid.innerHTML = `<div class="dash-loading"><span class="dash-spinner"></span> Looking up “${escapeHtml(raw)}”…</div>`;
    syncResetOrder();

    try {
      const lite = await resolveUsername(raw);
      if (!lite) throw new Error(`No War Era user found with username “${raw}”. Check the spelling and try again.`);
      enforceIrishOnly(lite.country ?? lite.countryId, lite.username);

      const full = await db_trpc('user.getUserById', { userId: lite._id });
      if (!full) throw new Error(`Couldn't load profile for ${lite.username}.`);

      try { writeHash('dashboard', new URLSearchParams({ u: full.username })); } catch {}
      RecentPlayers.remember(full.username);   // verified canonical name → recent chips
      renderScaffold(full.username);
      rememberLoadedAccount(full.username);

      // The economy card still depends on the removed worker API.
      fillClockin(full);
      fillWealth(full);
      fillMU(full);
      fillMigration(full);
      fillProducts(full);
      if (!isPaused('training')) fillTraining(full);
      fillBuddy(full);
    } catch (e) {
      $grid.innerHTML = '';
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : e.message;
      setStatus(friendly, true);
    } finally {
      running = false;
      $load.disabled = false;
      // Only release it if it's still ours, matching makeSteps.
      if (getRateLimitHandler() === reportRateLimit) setRateLimitHandler(null);
    }
  }

  // Leaving the dashboard: turn the shared cache off (and clear it) so other
  // views behave exactly as before.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'dashboard' && mounted) { setTrpcCache(false, CACHE_OWNER); trainingUnwatch?.(); trainingUnwatch = null; mounted = false; }
  });

  /* ── Wire-up ─────────────────────────────────────────────────────── */
  $load.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if ($resetOrder) $resetOrder.addEventListener('click', () => {
    try { localStorage.removeItem(LAYOUT_KEY); } catch { /* storage off */ }
    withFlip(() => arrange(colsOf().length));
    syncResetOrder();
  });
  RecentPlayers.mount($recent, u => { $username.value = u; run(); });

  return {
    activate(params) {
      mounted = true;
      const u = (params && params.get && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; run(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
