/* ═══════════════════════════════════════════════════════════════════
 *  UNIFIED IRISH TOOLKIT  (powers the #home view)
 *
 *  A single-page shell over the Irish tools. The user loads
 *  their name once; switching sub-tabs runs each tool for that name with
 *  no bouncing back to a landing screen. This is now the default Irish
 *  tools view (#home); it began life as the "staging" prototype, hence
 *  the StagingTool name kept here to avoid churn.
 *
 *  Reuse without rewrite: each tool is a self-contained IIFE whose DOM
 *  refs are captured once. They stay valid when the nodes are reparented,
 *  so this shell MOVES each tool's <section class="view"> into its mount
 *  and drives it through the tool's existing activate({u}). Nothing in
 *  mu/buddy-finder/advisor/clockin.js changes; borrowed views are handed
 *  back the moment the user leaves home.
 *
 *  Features:
 *    1. Background prefetch. On entry we warm every username-independent
 *       bulk endpoint into the shared trpc cache, so by the time a name
 *       is typed the heavy data is already loaded.
 *    2. Personal tools wait for a username; public tools open immediately.
 *       A loaded name with no tool chosen shows the landing cards beside
 *       the nav, as an overview.
 *    3. Recent usernames. Kept by RecentPlayers (shared.js) as quick-pick
 *       chips, handy for long names. Saved only on SUCCESSFUL resolution
 *       (see the name watcher), so failed searches never pollute the list.
 *    4. URLs. Each tool keeps its own (#advisor?u=<name>), so links and
 *       Back work as anywhere else; the overview is #home?u=<name>.
 *    5. A switcher card above each tool names it and opens every tool in
 *       a panel, grouped by category.
 * ═══════════════════════════════════════════════════════════════════ */
const ToolkitShell = (() => {
  const TOOLS              = ['advisor', 'clockin', 'training', 'buddy-finder', 'products', 'profit', 'wealth', 'mu', 'softcap', 'sp-advisor', 'roster'];
  const USERNAME_DRIVEN    = new Set(['buddy-finder', 'advisor', 'clockin', 'training', 'products', 'profit', 'wealth', 'softcap', 'sp-advisor']);

  const MODULES = {
    roster:         () => RosterTool,
    training:       () => EmployeeTrainingTool,
    mu:             () => MUTool,
    'buddy-finder': () => BuddyFinderTool,
    advisor:        () => AdvisorTool,
    clockin:        () => ClockInTool,
    products:       () => ProductPickerTool,
    profit:         () => DailyProfitTool,
    wealth:         () => WealthMonitorTool,
    softcap:        () => GearSoftcapTool,
    'sp-advisor':   () => SkillPointAdvisorTool,
  };

  // Each tool's name, icon and explainer, shown in the tool list, on the
  // switcher card and on its landing card. Hosted tools have no title or
  // description of their own.
  const TOOL_INFO = {
    roster:         { icon: '🛰️', title: 'Battle Intel Ireland', desc: `A live citizen roster for war planning: build, pills, health, hunger and who's online.` },
    advisor:        { icon: '🏭', title: 'Migration Advisor', desc: `Find your companies outside Ireland and what moving them home is worth.` },
    clockin:        { icon: '📋', title: 'Manager Check-In',  desc: `Check your company managers, their activity, last login and hourly pay.` },
    training:       { icon: '🎓', title: 'Employee Training', desc: `Plan your employees: which training card to keep, who to hire or replace, and where each one should work.` },
    wealth:         { icon: '💰', title: 'Wealth Tracker',    desc: `Track any Irish player's wealth over time.` },
    'buddy-finder': { icon: '🤝', title: 'Buddy Finder',      desc: `See your open buddy slots and which Irish players can fill them.` },
    products:       { icon: '🎯', title: 'Top products',    desc: `Compare product margins from the latest market trades. Treat these figures as a snapshot, not a recommendation to switch your workforce.` },
    profit:         { icon: '📈', title: 'Daily Profit',      desc: `Your projected daily profit — companies, salary, missions and case sales — plus which products pay best per production point and whether hiring is worth it. Auto-filled from the game.` },
    mu:             { icon: '🪖', title: 'Irish Military Units', desc: `Military Units owned by Irish citizens, based in Ireland, with a majority-Irish roster.` },
    softcap:        { icon: '🛡️', title: 'Gear Softcap Advisor', desc: `Find the cheapest chest, pants and boots that give the same armor and dodge.` },
    'sp-advisor':   { icon: '🧮', title: 'Skill Point Advisor', desc: `Enter your level, companies and workers managed, and get the optimal Entrepreneurship / Energy / Production split for the rest of your skill points.` },
  };

  const $mount    = document.getElementById('stg-mount');
  const $nav      = document.getElementById('stg-nav');
  const $side     = document.getElementById('stg-side');
  const $body     = $side.parentElement;   // .stg-body
  const $navToggle  = document.getElementById('stg-nav-toggle');
  const $username = document.getElementById('stg-username');
  const $load     = document.getElementById('stg-load');
  const $empty    = document.getElementById('stg-empty');
  const $emptySub = document.getElementById('stg-empty-sub');
  const $preview  = document.getElementById('stg-preview');
  const $recent   = document.getElementById('stg-recent');

  const state = { active: null, username: '', mounted: false, pendingTool: null, params: new URLSearchParams() };

  /* ── View hosting (reparent existing tool views) ────────── */
  const VIEW = {}; // tool -> { el, placeholder, hosted }
  function capture(tool) {
    if (VIEW[tool]) return VIEW[tool];
    const el = document.querySelector(`.view[data-view="${tool}"]`);
    if (!el) return null;
    VIEW[tool] = { el, placeholder: document.createComment(`stg:${tool}`), hosted: false };
    return VIEW[tool];
  }
  function hideTargets(tool) {
    const v = VIEW[tool]; if (!v) return [];
    // The shell provides the username field, so the tool's own lookup bar
    // (input + recent chips) is hidden. The shared name drives it.
    return [v.el.querySelector('.stg-idbar')].filter(Boolean);
  }
  function setHidden(tool, on) {
    hideTargets(tool).forEach(el => el.classList.toggle('stg-hide', on));
  }
  function host(tool) {
    const v = capture(tool); if (!v || v.hosted) return;
    v.el.parentNode.insertBefore(v.placeholder, v.el);
    $mount.appendChild(v.el);
    v.hosted = true;
    setHidden(tool, true);
  }
  function restore(tool) {
    const v = VIEW[tool]; if (!v || !v.hosted) return;
    setHidden(tool, false);
    if (v.placeholder.parentNode) {
      v.placeholder.parentNode.insertBefore(v.el, v.placeholder);
      v.placeholder.remove();
    }
    v.hosted = false;
  }
  function restoreAll() { TOOLS.forEach(restore); }

  // --- Tool switcher ---
  // The card above the tool opens the list of every tool.
  function setNavOpen(open) {
    $side.classList.toggle('open', open);
    $navToggle.setAttribute('aria-expanded', String(open));
  }
  // Pinned while scrolling, the card drops its description to stay one line
  // tall. The space it gives up goes into its bottom margin, so the page
  // keeps its length; otherwise a short page loses its scroll room and the
  // card un-pins again.
  // The pinned height is measured on a hidden copy, so the page is never laid
  // out with the card shrunk but its margin not yet grown: the browser's
  // scroll anchoring would see the page below move up, scroll up after it,
  // and un-pin the card, over and over on a slow scroll.
  function pinnedHeight() {
    const copy = $side.cloneNode(true);
    for (const el of [copy, ...copy.querySelectorAll('[id]')]) el.removeAttribute('id');
    copy.classList.add('pinned');
    copy.style.cssText = `position:absolute; visibility:hidden; width:${$side.offsetWidth}px`;
    $side.after(copy);
    const height = copy.offsetHeight;
    copy.remove();
    return height;
  }
  const $sentinel = document.createElement('div');
  $side.parentElement.before($sentinel);
  new IntersectionObserver(([e]) => {
    const pinned = !e.isIntersecting;
    if (pinned === $side.classList.contains('pinned')) return;
    $side.style.marginBottom = '';
    if (!pinned) { $side.classList.remove('pinned'); return; }
    const before = $side.offsetHeight;
    const margin = parseFloat(getComputedStyle($side).marginBottom) || 0;
    const after = pinnedHeight();
    $side.classList.add('pinned');
    $side.style.marginBottom = `${margin + before - after}px`;
  }).observe($sentinel);

  /* ── URLs ───────────────────────────────────────────────
   *  Each tool keeps its own URL (#advisor?u=<name>), which the router hands
   *  to the shell, so moving between tools goes through the address bar:
   *  every move is a history entry, and Back returns to the previous tool.
   *  The overview is #home?u=<name>. */
  function go(view, params) {
    const qs = params.toString();
    const hash = `#${view}${qs ? `?${qs}` : ''}`;
    if (hash === location.hash) return false;
    location.hash = hash;
    return true;
  }
  function openTool(tool) {
    const params = new URLSearchParams();
    if (state.username && USERNAME_DRIVEN.has(tool)) params.set('u', state.username);
    go(tool, params);
  }

  /* ── Name watcher ───────────────────────────────────────
   *  A hosted tool rewrites its own URL (#advisor?u=…) only after it has
   *  resolved the name, and it writes the canonical (correct-case) one. So
   *  that rewrite is the one reliable signal to commit the name to the
   *  recent list and adopt its casing. Failed searches never reach a
   *  rewrite, so they never get saved. */
  let nativeReplace = null;
  function watchNames() {
    if (nativeReplace) return;
    nativeReplace = history.replaceState.bind(history);
    history.replaceState = function (s, t, url) {
      if (typeof url === 'string') {
        // Tools write a full path + query + hash, so read the hash off it.
        const [route, query = ''] = new URL(url, location.href).hash.slice(1).split('?');
        const u = new URLSearchParams(query).get('u');
        if (u && route === state.active && USERNAME_DRIVEN.has(route)) {
          state.username = u;
          RecentPlayers.remember(u);
        }
      }
      return nativeReplace(s, t, url);
    };
  }
  function unwatchNames() {
    if (!nativeReplace) return;
    history.replaceState = nativeReplace;
    nativeReplace = null;
  }

  /* ── Background prefetch ─────────────────────────────────
   *  Warm the username-independent bulk data into the shared trpc cache
   *  so the tools find it hot. Fire-and-forget; failures are swallowed
   *  (the tools refetch on demand). Runs once per entry. */
  let prefetchStarted = false;

  function walkPaginated(endpoint, baseInput) {
    let cursor, safety = 0;
    (async () => {
      while (safety++ < 200) {
        const input = { ...baseInput, limit: 100 };
        if (cursor) input.cursor = cursor;
        let page;
        try { page = await trpc(endpoint, input, { retry: true }); }
        catch { break; }
        const arr  = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
        const next = page?.nextCursor ?? page?.cursor ?? null;
        if (!next || arr.length === 0) break;
        cursor = next;
      }
    })();
  }

  /*
   *  Warm every country's full record. This uses the same batched call the
   *  tools themselves make (trpcMany, default chunk size), which matters:
   *  the resolved cache keys a batch by its whole input array, so warming
   *  one country at a time would leave zero hits for a tool that then asks
   *  for them in batches. Same shape in, same shape out.
   */
  async function warmCountries(arr) {
    const settled = await trpcMany('country.getCountryById',
      arr.filter(c => c?._id).map(c => ({ countryId: c._id })));
    const countryById = {};
    settled.forEach(result => {
      if (result.status === 'fulfilled' && result.value?._id) {
        countryById[result.value._id] = result.value;
      }
    });
    await enrichCountriesWithIndustrialism(countryById);
  }

  function markReady() {
    if (!$emptySub) return;
    $emptySub.textContent = 'Data ready. Enter your username to begin.';
    $emptySub.classList.add('ready');
  }

  function prefetch() {
    if (prefetchStarted) return;
    prefetchStarted = true;

    // Migration Advisor's heavy block.
    const countriesP = trpc('country.getAllCountries', {}).catch(() => null);
    trpc('region.getRegionsObject', {}).catch(() => {});
    trpc('gameConfig.getGameConfig', {}).catch(() => {});
    countriesP.then(list => {
      const arr = Array.isArray(list) ? list : (list?.items || []);
      // Prefetch errors are surfaced when the selected tool performs its own
      // load; consume them here so a background warm-up cannot create an
      // unhandled rejection or leave the shell looking permanently busy.
      warmCountries(arr).then(markReady, markReady);
    });

    // MU + Buddy Finder share the Irish citizen list; MU also needs the MU list.
    walkPaginated('mu.getManyPaginated', {});
    walkPaginated('user.getUsersByCountry', { countryId: IRELAND_COUNTRY_ID });
  }

  // --- Stage ---
  // What the shell shows: the landing that asks for a name ('gate'), the
  // landing cards beside the nav once a name is loaded but no tool is
  // chosen ('overview'), or a tool ('tool').
  function setStage(stage) {
    $side.classList.toggle('hidden', stage === 'gate');
    if (stage === 'gate') setNavOpen(false);
    $mount.classList.toggle('hidden', stage !== 'tool');
    $empty.classList.toggle('hidden', stage === 'tool');
    $body.classList.toggle('overview', stage === 'overview');
  }
  // Marks the tool in the list and shows it on the switcher card, in its
  // category's colour.
  function markActive(tool) {
    $nav.querySelectorAll('.stg-tab').forEach(b => {
      const on = b.dataset.stgTab === tool;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const info = TOOL_INFO[tool];
    const cat = CATEGORIES.find(c => c.tools.includes(tool));
    $side.dataset.cat = cat ? cat.key : '';
    const card = (sel, text) => { $navToggle.querySelector(sel).textContent = text; };
    card('.stg-sw-icon', info ? info.icon : '');
    card('.stg-sw-cat', cat ? cat.name : '');
    card('.stg-sw-title', info ? info.title : '');
    card('.stg-sw-desc', info ? info.desc : '');
  }

  /* Full reset back to the landing state: clear the loaded username, hand
   *  the active tool's view back, and re-show the preview. Wired to the
   *  brand link so clicking the title is a clean "start over". */
  function resetHome() {
    if (state.active) restore(state.active);
    state.active = null;
    state.pendingTool = null;
    state.username = '';
    state.params = new URLSearchParams();
    $username.value = '';
    markActive(null);
    setStage('gate');
    // No hash rewrite here: the brand's href="#home" fires the navigation,
    // and the router re-activates the shell. Because state.username is now
    // cleared, that re-activation lands on the gated landing. (A replaceState
    // here would suppress that hashchange and strand other views on-screen.)
  }

  /* ── Driving the active tool ─────────────────────────────
   *  Tools' activate() is idempotent: it re-runs only when the passed ?u=
   *  differs from their own input, so repeated calls are safe no-ops. */
  // Tools that call the employee model on the main thread wait until it is
  // ready, as the router's MODEL_VIEWS do: the .wasm loads after the page.
  // Only the latest activation runs, so a quick switch away and back
  // doesn't activate twice.
  const MODEL_TOOLS = new Set(['training', 'products']);
  let activation = 0;
  function driveActive() {
    const tool = state.active;
    const mod = MODULES[tool] && MODULES[tool]();
    if (!mod || isHeld(tool) || typeof mod.activate !== 'function') return;
    const params = new URLSearchParams(state.params);
    if (USERNAME_DRIVEN.has(tool) && state.username) params.set('u', state.username);
    const activate = () => {
      try { mod.activate(params); }
      catch (e) { console.error(`[home] activate ${tool} failed`, e); }
    };
    const token = ++activation;
    if (!MODEL_TOOLS.has(tool)) return activate();
    EmployeeModel.ready.then(() => { if (token === activation) activate(); },
      () => { if (token === activation) modelFailed(tool); });
  }
  function modelFailed(tool) {
    const el = VIEW[tool] && VIEW[tool].el;
    if (!el || el.querySelector('.model-error')) return;
    const note = document.createElement('p');
    note.className = 'status error model-error';
    note.setAttribute('role', 'alert');
    note.textContent = "Couldn't load the employee model. Reload the page to try again.";
    el.prepend(note);
  }

  // Tool categories, in order, for the tool list and the landing cards.
  // `key` picks the category's colour in styles.css.
  const CATEGORIES = [
    { key: 'production', icon: '🏭', name: 'Production', tools: ['advisor', 'clockin', 'training'] },
    { key: 'profits',    icon: '💰', name: 'Profits',    tools: ['products', 'buddy-finder', 'wealth'] },
    { key: 'combat',     icon: '⚔️', name: 'Combat',     tools: ['mu', 'softcap', 'roster'] },
  ];
  $nav.innerHTML = CATEGORIES.map(c => `<div class="stg-nav-group" data-cat="${c.key}">
    <div class="stg-nav-cat">${c.icon} ${c.name}</div>
    ${c.tools.map(t => {
      const i = TOOL_INFO[t];
      return `<button class="stg-tab" type="button" data-stg-tab="${t}"><span class="stg-tab-icon" aria-hidden="true">${i.icon}</span><span class="stg-tab-name">${escapeHtml(i.title)}</span></button>`;
    }).join('')}
  </div>`).join('');

  // Preview of every tool on the empty/landing state, so newcomers see
  // what's inside before typing a name. Clicking one pre-selects it.
  // Landing cards, grouped into sections (same style as the Community tab).
  function renderPreview() {
    if (!$preview || $preview.dataset.done) return;
    const card = t => {
      const i = TOOL_INFO[t]; if (!i) return '';
      return `<button class="tool-card" data-prev="${t}">
        <div class="tool-card-icon">${i.icon}</div>
        <div class="tool-card-body">
          <h3>${escapeHtml(i.title)}</h3>
          <p>${escapeHtml(i.desc)}</p>
          <span class="tool-link">Open ${escapeHtml(i.title)} →</span>
        </div>
      </button>`;
    };
    $preview.innerHTML = CATEGORIES.map(c =>
      `<h3 class="community-cat">${c.icon} ${c.name}</h3><div class="tool-cards">${c.tools.map(card).join('')}</div>`
    ).join('');
    markPausedLinks($preview);
    $preview.dataset.done = '1';
  }

  function selectTool(tool, { run = true } = {}) {
    if (!TOOLS.includes(tool)) return showOverview();
    setNavOpen(false);
    setStage('tool');
    state.pendingTool = null;
    if (state.active === tool) { if (run) driveActive(); return; }
    if (state.active) restore(state.active);
    state.active = tool;
    host(tool);
    markActive(tool);
    $mount.dataset.active = tool;
    if (run) driveActive();
  }

  function showOverview() {
    if (state.active) restore(state.active);
    state.active = null;
    state.pendingTool = null;
    state.params = new URLSearchParams();
    delete $mount.dataset.active;
    markActive(null);
    setStage('overview');
    // Opened as #home with a remembered name: show the name in the URL.
    const params = new URLSearchParams();
    if (state.username) params.set('u', state.username);
    writeHash('home', params);
  }

  function loadUsername() {
    const u = $username.value.trim();
    if (!u) { $username.focus(); return; }
    state.username = u;
    // Not saved to the recent list here — the name isn't verified yet.
    // Saving on Load is what let typos land in the list. The recent list
    // is committed only when a tool successfully resolves (name watcher).
    const tool = state.pendingTool || (USERNAME_DRIVEN.has(state.active) ? state.active : null);
    state.pendingTool = null;
    if (tool) {
      // The open tool keeps its other settings (tab, sort) for the new name.
      const params = tool === state.active ? hashParams() : new URLSearchParams();
      params.set('u', u);
      if (!go(tool, params)) driveActive();   // same URL: run it again
    } else if (!state.active) go('home', new URLSearchParams({ u }));
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  $nav.addEventListener('click', e => {
    const btn = e.target.closest('.stg-tab');
    if (!btn) return;
    const tool = btn.dataset.stgTab;
    setNavOpen(false);
    if (USERNAME_DRIVEN.has(tool) && !state.username) {
      state.pendingTool = tool;
      $username.focus();
      return;
    }
    if (tool !== state.active) openTool(tool);
  });
  $navToggle.addEventListener('click', () => setNavOpen(!$side.classList.contains('open')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setNavOpen(false); });
  document.addEventListener('click', e => { if (!$side.contains(e.target)) setNavOpen(false); });
  $load.addEventListener('click', loadUsername);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') loadUsername(); });
  RecentPlayers.mount($recent, u => { $username.value = u; loadUsername(); });
  // Landing cards open their tool; one that needs a name, with none loaded
  // yet, is remembered and the name field focused.
  $preview.addEventListener('click', e => {
    const card = e.target.closest('[data-prev]');
    if (!card) return;
    if (state.username || !USERNAME_DRIVEN.has(card.dataset.prev)) openTool(card.dataset.prev);
    else { state.pendingTool = card.dataset.prev; $username.focus(); }
  });

  // Clicking the brand/title is a clean "start over": reset to the landing
  // and clear the loaded username. The href="#home" still handles the view
  // switch when we're coming from another tab; resetHome() clears the state
  // first, so the router's re-activation lands on the gated landing.
  const $brand = document.querySelector('.brand');
  if ($brand) $brand.addEventListener('click', () => resetHome());

  // Identifies this view as the resolved cache's owner, so its teardown
  // can't clear a cache another view has since claimed (see setTrpcCache).
  const CACHE_OWNER = 'toolkit';

  // Leaving the Irish tools: turn off the shared cache (clears it), hand the
  // borrowed views back, and reset so the next entry re-warms cleanly.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'home' && !TOOLS.includes(view) && state.mounted) {
      unwatchNames();
      setTrpcCache(false, CACHE_OWNER);
      restoreAll();
      state.mounted = false;
      state.active = null;
      prefetchStarted = false;
    }
  });

  return {
    supports: tool => TOOLS.includes(tool),
    /**
     * Router entry, for #home and for each hosted tool's own route
     * (#advisor?u=toie), which the router passes on as tool=advisor.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      state.mounted = true;
      watchNames();
      setTrpcCache(true, CACHE_OWNER);
      prefetch();
      renderPreview();

      const tool = (params && TOOLS.includes(params.get('tool'))) ? params.get('tool') : null;
      const u = (params && params.get('u')) || state.username || RecentPlayers.active() || '';

      state.params = new URLSearchParams(params);
      state.params.delete('u');
      state.params.delete('tool');

      if (u || (tool && !USERNAME_DRIVEN.has(tool))) {
        // Deep-link / returning name: don't pre-save it. If it resolves,
        // the tool's hash rewrite commits it; if not, it stays out.
        $username.value = u;
        state.username = u;
        if (tool) selectTool(tool); else showOverview();
      } else {
        setStage('gate');
        state.pendingTool = tool;
      }
    },
  };
})();
