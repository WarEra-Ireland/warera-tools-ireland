/* ═══════════════════════════════════════════════════════════════════
 *  VIEW ROUTER
 *  Hash-based routing so views are deep-linkable.
 *    #home                Irish tools landing (default)
 *    #community           Community (external) tools landing
 *    #mu                  Irish Military Units
 *    #mu?filter=open      MU tool with the "Has slots" filter applied
 *    #advisor             Migration Advisor (empty)
 *    #advisor?u=toie      Migration Advisor auto-running for "toie"
 *    #clockin             Employee Clock-In Monitor (empty)
 *    #clockin?u=toie      Clock-In Monitor auto-running for "toie"
 *    #training            Employee Training card guide (no username)
 *
 *  Params live inside the hash (after a literal '?') so the whole route
 *  is portable as one fragment and survives static hosting that doesn't
 *  rewrite query strings.
 *
 *  Tabs: the two landing views (home, community) show the tab bar and
 *  hide the back-link. Every tool view hides the tabs and shows the
 *  back-link, which returns to #home. All internal tools belong to the
 *  Irish tab, so "back to home" is always the right destination.
 *
 *  Idempotency: activate(params) runs every time a view becomes active,
 *  not just on first mount. Tools handle being called repeatedly: MU
 *  doesn't re-fetch its data, the advisor only re-runs if the username
 *  changed. This is what makes hash edits like #advisor to #advisor?u=toie
 *  pick up the new param without a full reload.
 *
 *  Navigation: two tabs sit in the header. Within the Irish tab, users
 *  click into tools via the cards; the .back-link and the brand title
 *  both return to #home. The Community tab is a directory of external
 *  links that open in a new tab — it registers no tool.
 * ═══════════════════════════════════════════════════════════════════ */
(() => {
  const VALID = new Set([
    'home', 'community', 'gov', 'mu', 'buddy-finder', 'donation-draw',
    'advisor', 'clockin', 'softcap', 'products', 'training', 'profit', 'profit-dev', 'wealth', 'buddy', 'battle-orders',
    'dashboard', 'roster', 'tax', 'tax-dev', 'factory-tax',
  ]);
  const LANDING = new Set(['dashboard', 'home', 'community', 'gov']);
  const DEFAULT_VIEW = 'dashboard';
  const views = document.querySelectorAll('.view');
  const $backLink = document.querySelector('.back-link');
  const $tabs = document.getElementById('tabs');
  const tools = {
    home: ToolkitShell,
    community: null,
    gov: null,
    mu: MUTool,
    'buddy-finder': BuddyFinderTool,
    advisor: AdvisorTool,
    clockin: ClockInTool,
    softcap: GearSoftcapTool,
    products: ProductPickerTool,
    training: EmployeeTrainingTool,
    profit: DailyProfitTool,
    'profit-dev': DailyProfitDevTool,
    wealth: WealthMonitorTool,
    'donation-draw': IrelandDonationDrawTool,
    buddy: BuddySystemGate,
    'battle-orders': BattleOrdersGate,
    dashboard: DashboardTool,
    roster: RosterTool,
    tax: IrishTaxGate,
    'tax-dev': IrishTaxDevTool,
    'factory-tax': IrishFactoryTaxTool,
  };

  function parseRoute(hash = location.hash) {
    const raw = hash.replace(/^#/, '');
    const qIdx = raw.indexOf('?');
    const view = (qIdx >= 0 ? raw.slice(0, qIdx) : raw) || DEFAULT_VIEW;
    const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    return { view, params: new URLSearchParams(queryStr) };
  }

  // Tools rewrite their own hash with replaceState once a load resolves. Now
  // that opening a tool starts a load, one can finish after the user has moved
  // on, so drop a rewrite that names a different view than the one showing.
  const nativeReplaceState = history.replaceState.bind(history);
  history.replaceState = function (state, title, url) {
    if (url != null) {
      const target = parseRoute(new URL(url, location.href).hash).view;
      if (VALID.has(target) && target !== parseRoute().view) return;
    }
    return nativeReplaceState(state, title, url);
  };

  // ?proxy= picks the Worker (shared.js) and must outlive every hash
  // rewrite, so it lives in front of the '#', which rewrites keep. A hash
  // ?proxy= is moved there; on a later hash edit the page reloads, because
  // shared.js only reads it at load.
  function hoistProxy({ reload }) {
    const route = parseRoute();
    const proxy = route.params.get('proxy');
    if (proxy == null) return false;
    route.params.delete('proxy');
    const search = new URLSearchParams(location.search);
    search.set('proxy', proxy);
    const queryStr = route.params.toString();
    // ':' and '/' are legal in a query, so leave the URL readable.
    const readable = search.toString().replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    const url = `${location.pathname}?${readable}#${route.view}${queryStr ? `?${queryStr}` : ''}`;
    if (reload) location.replace(url);
    else nativeReplaceState(null, '', url);
    return reload;
  }

  function setView(name, { updateHash = true, params = new URLSearchParams() } = {}) {
    if (!VALID.has(name)) name = DEFAULT_VIEW;
    views.forEach(v => v.classList.toggle('active', v.dataset.view === name));

    // Tab bar on the two landing pages, back-link inside tools.
    const isLanding = LANDING.has(name);
    $backLink.hidden = isLanding;
    $backLink.setAttribute('href',
      (name === 'buddy' || name === 'battle-orders' || name === 'donation-draw') ? '#gov' : '#dashboard');
    if ($tabs) {
      $tabs.hidden = !isLanding;
      $tabs.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
    }

    if (updateHash) writeHash(name, params);

    const tool = tools[name];
    if (tool && !isHeld(name) && typeof tool.activate === 'function') {
      try { tool.activate(params); }
      catch (e) { console.error(`Failed to activate ${name}:`, e); }
    }
  }

  // The active player (the most recent in RecentPlayers) rides along into
  // any view that takes a player but was opened without ?u=, so every tool
  // shows the same player. Removing the active player leaves none active.
  const PLAYER_VIEWS = new Set([
    'dashboard', 'home', 'advisor', 'clockin', 'softcap', 'products', 'training',
    'profit', 'profit-dev', 'wealth', 'buddy-finder',
  ]);
  function withActivePlayer(r) {
    if (!PLAYER_VIEWS.has(r.view) || r.params.get('u')) return;
    if (new URLSearchParams(location.search).get('u')) return;   // tools read ?u= before the hash too
    const u = RecentPlayers.active();
    if (!u) return;
    r.params.set('u', u);
    writeHash(r.view, r.params);
  }

  window.addEventListener('hashchange', () => {
    if (hoistProxy({ reload: true })) return;
    const r = parseRoute();
    withActivePlayer(r);
    setView(r.view, { updateHash: false, params: r.params });
  });

  hoistProxy({ reload: false });
  pauseViews();

  const initial = parseRoute();
  withActivePlayer(initial);
  setView(initial.view, { updateHash: false, params: initial.params });
})();
