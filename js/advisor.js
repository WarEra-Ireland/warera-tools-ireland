/* ═══════════════════════════════════════════════════════════════════
 *  COMPANY MIGRATION ADVISOR ("Bring it home")
 *
 *  v0.27 removed specialisation, deposits and party ethics, so the only
 *  location levers left are:
 *
 *    core region  — +5% employee output when the company sits in a core
 *                   region. Read as region.country === region.initialCountry
 *                   (the controller is the region's original owner). That
 *                   reading is inferred, not confirmed by the game.
 *    income tax   — charged on employee wages and paid to the country that
 *                   controls the region. Each 1% costs employees 1 happiness,
 *                   and each happiness point is ±1% employee output.
 *
 *  Both act on employee output only, not on automated engines or self-work.
 *  company.getProductionBonus is NOT a source for either: it still returns
 *  only {depositBonus, total} and was 0 for every company sampled on
 *  2026-10-26, core or not.
 *
 *  So each company is one of: home (Irish core region), not-core (Irish
 *  controlled but not core, i.e. Northern Ireland), or abroad. Abroad cards
 *  show how much wage tax went to the foreign country over the last week
 *  (work.getStatsByCompany `wage` × that country's income tax) and the
 *  output difference, honestly, including when staying abroad is better.
 *
 *  Moving costs 5 concrete, or nothing while company.freeMoves ≥ 1. The
 *  free move is a one-off v0.27 grant, not something that refills.
 *
 *  Access: restricted to Irish citizens (enforceIrishOnly from
 *  shared.js). The bypass=1 URL param lifts the restriction.
 * ═══════════════════════════════════════════════════════════════════ */
const AdvisorTool = (() => {
  const companyUrlFor = id => `${GAME_BASE}/company/${id}`;

  const CORE_BONUS_PCT = 5;
  const MOVE_COST_CONCRETE = 5;
  const TAX_WINDOW_DAYS = 7;

  const ITEMS = {
    cocain:     { name: 'Pill',            file: 'cocain.png',     fb: '💊' },
    coca:       { name: 'Mysterious Plant',file: 'coca.png',       fb: '🌿' },
    lightAmmo:  { name: 'Light Ammo',      file: 'lightAmmo.png',  fb: '•' },
    ammo:       { name: 'Ammo',            file: 'ammo.png',       fb: '🔫' },
    heavyAmmo:  { name: 'Heavy Ammo',      file: 'heavyAmmo.png',  fb: '💥' },
    lead:       { name: 'Lead',            file: 'lead.png',       fb: '⚫' },
    cookedFish: { name: 'Cooked Fish',     file: 'cookedFish.png', fb: '🍣' },
    steak:      { name: 'Steak',           file: 'steak.png',      fb: '🥩' },
    bread:      { name: 'Bread',           file: 'bread.png',      fb: '🍞' },
    fish:       { name: 'Fish',            file: 'fish.png',       fb: '🐟' },
    livestock:  { name: 'Livestock',       file: 'livestock.png',  fb: '🐄' },
    grain:      { name: 'Grain',           file: 'grain.png',      fb: '🌾' },
    oil:        { name: 'Oil',             file: 'oil.png',        fb: '⛽' },
    steel:      { name: 'Steel',           file: 'steel.png',      fb: '🏗️' },
    concrete:   { name: 'Concrete',        file: 'concrete.png',   fb: '🧱' },
    petroleum:  { name: 'Petroleum',       file: 'petroleum.png',  fb: '🛢️' },
    iron:       { name: 'Iron',            file: 'iron.png',       fb: '⛓️' },
    limestone:  { name: 'Limestone',       file: 'limestone.png',  fb: '🪨' },
    paper:      { name: 'Paper',           file: 'paper.png',      fb: '📄' },
    wood:       { name: 'Wood',            file: 'wood.png',       fb: '🪵' },
  };

  const $grid     = document.getElementById('adv-grid');
  const $hint     = document.getElementById('adv-hint');
  const $username = document.getElementById('adv-username');
  const $go       = document.getElementById('adv-go');
  const $howto    = document.getElementById('adv-howto');
  const steps     = makeSteps(document.getElementById('adv-steps'));
  const setStatus = makeStatus(document.getElementById('adv-status'));

  let lastResult = null;

  const adv_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  let USER_ENDPOINT = null;
  async function fetchUser(userId) {
    if (USER_ENDPOINT) {
      try { return await adv_trpc(USER_ENDPOINT, { userId }); }
      catch { return null; }
    }
    const candidates = ['user.getById', 'user.getUserById', 'user.getUser', 'user.get'];
    for (const ep of candidates) {
      try {
        const u = await adv_trpc(ep, { userId });
        if (u) { USER_ENDPOINT = ep; return u; }
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Fetch several users at once.
   *
   * Which user procedure this build exposes isn't known up front, so the
   * first IDs are probed one at a time through fetchUser until one of them
   * pins USER_ENDPOINT down. Everything after that goes out as a single
   * tRPC batch instead of one request per candidate.
   *
   * @param {string[]} userIds User IDs to fetch.
   * @param {function(number, number):void} [onProgress] Called with (done, total).
   * @returns {Promise<Array<Object|null>>} Profiles in input order; null where unavailable.
   */
  async function fetchUsers(userIds, onProgress) {
    const total = userIds.length;
    const results = new Array(total).fill(null);
    let probed = 0;
    while (probed < total && !USER_ENDPOINT) {
      results[probed] = await fetchUser(userIds[probed]);
      probed++;
      onProgress?.(probed, total);
    }
    if (probed >= total) return results;

    const rest = await trpcManyValues(USER_ENDPOINT,
      userIds.slice(probed).map(userId => ({ userId })),
      { onProgress: (done) => onProgress?.(probed + done, total) });
    rest.forEach((u, index) => { results[probed + index] = u; });
    return results;
  }

  /**
   * Resolve a username to the correct user ID.
   *
   * search.searchAnything is fuzzy/relevance-ranked across all entities,
   * so userIds[0] is NOT guaranteed to be an exact username match. We
   * pull profiles for the top N and pick the one whose username matches
   * exactly (case-insensitive). Fallback only when nothing can be verified.
   *
   * Returns the resolved user's `country` alongside id/username so the
   * Irish-only gate has it without an extra call.
   */
  async function resolveUserId(username) {
    const search = await adv_trpc('search.searchAnything', { searchText: username });
    const candidateIds = search?.userIds || [];
    if (!candidateIds.length) {
      throw new Error(`No user found matching "${username}"`);
    }

    steps.setStep(1, 'active', {
      sub: `Verifying username among ${candidateIds.length} match${candidateIds.length === 1 ? '' : 'es'}`,
      count: `0/${Math.min(candidateIds.length, 10)}`
    });

    const top = candidateIds.slice(0, 10);
    const profiles = await fetchUsers(top, (done, total) => {
      steps.setStep(1, 'active', { count: `${done}/${total}` });
    });

    const known = profiles.filter(Boolean);
    const normalise = s => (s || '').toLowerCase().trim();
    const target = normalise(username);

    const exact = known.find(u => normalise(u.username) === target);
    if (exact) return { userId: exact._id, username: exact.username, country: exact.country, exact: true };

    if (!known.length) {
      console.warn('[advisor] Could not verify usernames; falling back to top search result.');
      return { userId: candidateIds[0], username, country: null, exact: false };
    }

    const found = known.map(u => u.username).filter(Boolean);
    throw new Error(
      `No exact match for "${username}". ` +
      `Search returned: ${found.slice(0, 5).join(', ')}${found.length > 5 ? '…' : ''}`
    );
  }

  const isCore = region => !!region && region.country === region.initialCountry;

  // Employee output from location alone, as a percentage: the core bonus
  // minus one point per point of income tax (via happiness).
  const locationPct = side => (side.core ? CORE_BONUS_PCT : 0) - (side.tax ?? 0);

  /**
   * Where Irish companies should go: the Irish core regions, best
   * development first. On 2026-10-26 all four were tied at 52.25.
   */
  function irishCoreRegions(regionsObj) {
    return Object.values(regionsObj)
      .filter(r => r?.country === IRELAND_COUNTRY_ID && isCore(r))
      .sort((a, b) => (b.development || 0) - (a.development || 0) || a.name.localeCompare(b.name));
  }

  /**
   * Load and classify every company a user owns. Also used by the
   * dashboard's Migration card, so it reports progress through an optional
   * callback instead of touching this view's step panel.
   *
   * @param {string} userId
   * @param {function(string, Object):void} [onStep] Called with (phase, info).
   * @returns {Promise<{placements: Object[], homeRegions: Object[], ireland: Object}>}
   */
  async function loadPlacements(userId, onStep) {
    const companyList = await adv_trpc('company.getCompanies', { userId, perPage: 100 });
    const companyIds = companyList?.items || [];
    if (!companyIds.length) return { placements: [], homeRegions: [], ireland: null };

    onStep?.('companies', { done: 0, total: companyIds.length });
    const settled = await trpcMany('company.getById',
      companyIds.map(companyId => ({ companyId })),
      { onProgress: (done, total) => onStep?.('companies', { done, total }) });
    // Your own companies are the whole analysis, so a failure here is fatal
    // rather than a gap to skip over.
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const companies = settled.map(result => result.value).filter(Boolean);

    onStep?.('places', {});
    const [regionsObj, stats] = await Promise.all([
      adv_trpc('region.getRegionsObject', {}),
      // Wage history is a nice-to-have: a company without it just shows no
      // tax figure.
      trpcManyValues('work.getStatsByCompany', companies.map(c => ({ companyId: c._id }))),
    ]);

    const countryIds = [...new Set([IRELAND_COUNTRY_ID,
      ...companies.map(c => regionsObj[c.region]?.country).filter(Boolean)])];
    const countries = await trpcManyValues('country.getCountryById',
      countryIds.map(countryId => ({ countryId })));
    const countryById = {};
    countries.forEach((country, i) => { if (country) countryById[countryIds[i]] = country; });

    const ireland = countryById[IRELAND_COUNTRY_ID];
    const homeRegions = irishCoreRegions(regionsObj);
    const homeSide = {
      region: homeRegions[0] || null,
      country: ireland,
      core: true,
      tax: ireland?.taxes?.income ?? null,
    };

    const placements = companies.map((company, i) => {
      const region = regionsObj[company.region] || null;
      const country = region ? countryById[region.country] : null;
      const side = { region, country, core: isCore(region), tax: country?.taxes?.income ?? null };
      const status = region?.country !== IRELAND_COUNTRY_ID ? 'abroad'
        : side.core ? 'home' : 'not-core';

      const days = (stats[i] || []).slice(-TAX_WINDOW_DAYS);
      const wages = days.length ? days.reduce((sum, d) => sum + (d.wage || 0), 0) : null;
      const taxPaid = wages != null && side.tax != null ? wages * side.tax / 100 : null;

      // Relative change in employee output from moving home.
      const gain = (1 + locationPct(homeSide) / 100) / (1 + locationPct(side) / 100) * 100 - 100;

      return {
        company, side, homeSide, status, wages, taxPaid, gain,
        freeMove: (company.freeMoves || 0) >= 1,
      };
    });

    const order = { abroad: 0, 'not-core': 1, home: 2 };
    placements.sort((a, b) => order[a.status] - order[b.status] || (b.taxPaid || 0) - (a.taxPaid || 0));
    return { placements, homeRegions, ireland };
  }

  async function analyse(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const resolved = await resolveUserId(username);
    steps.setStep(1, 'done', {
      count: resolved.exact ? `→ ${resolved.username}` : `→ ${resolved.username} (unverified)`
    });

    // Irish-citizens-only gate. The bypass=1 URL param lifts this
    // for admin/debugging. Non-Irish users get a hard block here,
    // before any of the company loading runs.
    enforceIrishOnly(resolved.country, resolved.username);

    steps.setStep(2, 'active', { sub: 'Fetching company list' });
    const result = await loadPlacements(resolved.userId, (phase, info) => {
      if (phase === 'companies') {
        steps.setStep(2, 'active', { sub: `Loading ${info.total} company details`, count: `${info.done}/${info.total}` });
      } else if (phase === 'places') {
        steps.setStep(2, 'done', {});
        steps.setStep(3, 'active', { sub: 'Loading regions, taxes and wage history' });
      }
    });
    if (!result.placements.length) throw new Error(`"${resolved.username}" has no companies`);
    steps.setStep(2, 'done', { count: `${result.placements.length} loaded` });
    steps.setStep(3, 'done', {});
    return { username: resolved.username, ...result };
  }

  function iconHtml(itemCode) {
    const it = ITEMS[itemCode];
    if (!it) return `<div class="icon-box"><span class="fallback">📦</span></div>`;
    return `<div class="icon-box"><img src="images/${it.file}" alt="${it.name}" onerror="this.outerHTML='<span class=\\'fallback\\'>${it.fb}</span>'"></div>`;
  }

  const money = v => v == null ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 });
  const signed = v => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 1)}%`;

  function renderSide(side, label) {
    if (!side.region || !side.country) return `<div class="side"><div style="color:var(--muted)">Unknown location</div></div>`;
    const taxClass = side.tax >= 12 ? 'tax-high' : side.tax >= 8 ? 'tax-mid' : 'tax-low';
    return `
      <div class="side">
        <div class="label">${label}</div>
        <div class="country">
          <span class="region">${escapeHtml(side.region.name)}</span>
          <span class="controller">controlled by</span>
          <span class="flag">${flag(side.country.code)}</span>
          <span class="controller">${escapeHtml(side.country.name)}</span>
        </div>
        <div class="stats">
          <span><span class="stat-label">Core region</span> <span class="stat-value ${side.core ? 'pos' : 'tax-high'}">${side.core ? `Yes, +${CORE_BONUS_PCT}%` : 'No'}</span></span>
          <span><span class="stat-label">Income tax</span> <span class="stat-value ${taxClass}">${side.tax == null ? '?' : `${fmt(side.tax)}%`}</span></span>
        </div>
        <div class="net" title="Core bonus minus income tax (each 1% of tax costs employees 1 happiness, worth 1% output).">
          <span class="stat-label">Employee output from location</span>
          <span class="net-val">${signed(locationPct(side))}</span>
        </div>
      </div>`;
  }

  function verdictFor(p) {
    if (p.status === 'home')     return { cls: 'optimal', text: '✓ Home' };
    if (p.status === 'not-core') return { cls: 'move', text: 'Move to an Irish core region' };
    return { cls: 'huge', text: `Abroad in ${p.side.country?.name || 'another country'}` };
  }

  function moveLine(p, homeRegions) {
    const names = homeRegions.map(r => r.name);
    const where = names.length > 1 && homeRegions[0].development === homeRegions[1].development
      ? `any Irish core region (${names.join(', ')})`
      : names[0] || 'an Irish core region';
    const cost = p.freeMove
      ? '<strong>Free</strong> with your one-off v0.27 free move.'
      : `Costs ${MOVE_COST_CONCRETE} concrete.`;
    return `<p><strong>Move to ${escapeHtml(where)}.</strong> ${cost}</p>`;
  }

  function renderCard(p, homeRegions) {
    const { company, side, homeSide, status } = p;
    const item = ITEMS[company.itemCode] || { name: company.itemCode || 'Unknown' };
    const verdict = verdictFor(p);
    const showCompanyName = company.name && company.name !== item.name;
    const freeBadge = p.freeMove && status !== 'home'
      ? `<span class="worker-badge" title="This company still has its one-off v0.27 free move.">Free move</span>` : '';

    const country = escapeHtml(side.country?.name || 'that country');
    const taxLine = p.taxPaid == null
      ? `<p class="breakdown">No wage history for this company yet.</p>`
      : p.wages < 0.005
      ? `<p class="breakdown">No employee wages paid in the last ${TAX_WINDOW_DAYS} days, so no income tax either.</p>`
      : `<p>Over the last ${TAX_WINDOW_DAYS} days this company paid about <strong>₿${money(p.wages)}</strong> in wages, so roughly <strong>₿${money(p.taxPaid)}</strong> of income tax went to ${status === 'abroad' ? country : 'Ireland'}.</p>`;

    let body;
    if (status === 'home') {
      body = `<div class="panels">${renderSide(side, 'Current location')}</div>${taxLine}`;
    } else {
      let take;
      if (status === 'not-core') {
        take = `<p>Ireland controls ${escapeHtml(side.region?.name || 'this region')}, but it isn't an Irish core region, so you miss the +${CORE_BONUS_PCT}% core bonus. Moving to a core region is about <strong>${signed(p.gain)}</strong> employee output.</p>`;
      } else if (p.gain >= 0.05) {
        take = `<p>Moving home is about <strong>${signed(p.gain)}</strong> employee output, and your wage tax would fund Ireland instead of ${country}.</p>`;
      } else if (p.gain <= -0.05) {
        take = `<p>Staying is about <strong>${fmt(-p.gain, 1)}% better</strong> for employee output, because ${country}'s location bonus beats Ireland's. Your wage tax still funds ${country}, not Ireland.</p>`;
      } else {
        take = `<p>Output is about the same in Ireland, and your wage tax would fund Ireland instead of ${country}.</p>`;
      }
      body = `
        <div class="panels compare">
          ${renderSide(side, 'Current location')}
          <div class="arrow">→</div>
          ${renderSide(homeSide, 'In Ireland')}
        </div>
        ${take}${taxLine}${moveLine(p, homeRegions)}`;
    }

    return `
      <div class="adv-card${status === 'home' ? '' : ' expanded'}">
        <div class="card-head">
          <div class="title">
            ${iconHtml(company.itemCode)}
            <span>${escapeHtml(item.name)}</span>
            ${showCompanyName ? `<span class="sub-title">· ${escapeHtml(company.name)}</span>` : ''}
            <a href="${companyUrlFor(company._id)}" target="_blank" rel="noopener" class="link-icon" title="Open this company in War Era"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>
            ${freeBadge}
          </div>
          <div class="verdict ${verdict.cls}">${escapeHtml(verdict.text)}</div>
          <span class="chev">▾</span>
        </div>
        <div class="body">${body}</div>
      </div>`;
  }

  function summaryText(username, placements) {
    const abroad = placements.filter(p => p.status === 'abroad');
    const notCore = placements.filter(p => p.status === 'not-core');
    const away = abroad.length + notCore.length;
    if (!away) return `All ${placements.length} of ${username}'s companies are home in Irish core regions. 🇮🇪`;
    const parts = [];
    if (abroad.length) parts.push(`${abroad.length} of ${placements.length} companies are abroad`);
    if (notCore.length) parts.push(`${notCore.length} ${notCore.length === 1 ? 'is' : 'are'} in Ireland but not a core region`);
    const foreignTax = abroad.reduce((sum, p) => sum + (p.taxPaid || 0), 0);
    if (foreignTax > 0) parts.push(`about ₿${money(foreignTax)} of wage tax went to foreign countries in the last ${TAX_WINDOW_DAYS} days`);
    const free = placements.filter(p => p.status !== 'home' && p.freeMove).length;
    if (free) parts.push(`${free} can move for free`);
    return `${username}: ${parts.join(' · ')}.`;
  }

  function render() {
    if (!lastResult) return;
    const { username, placements, homeRegions } = lastResult;
    setStatus(summaryText(username, placements));
    $grid.innerHTML = placements.map(p => renderCard(p, homeRegions)).join('');
    $howto.classList.remove('hidden');
  }

  async function run() {
    const username = $username.value.trim();
    if (!username) { $username.focus(); return; }

    // Make the current advisor view shareable as a URL. Preserve any
    // extra params (like bypass=1) the user came in with so they survive
    // the re-write — otherwise the gate can't see them after the run starts.
    // replaceState keeps back-button history intact and (unlike a real
    // navigation) does not fire hashchange, so this won't trigger a
    // re-activation loop.
    const params = hashParams();
    params.set('u', username);
    writeHash('advisor', params);

    $go.disabled = true;
    $hint.classList.add('hidden');
    setStatus('');
    $grid.innerHTML = '';
    $howto.classList.add('hidden');
    steps.reset();
    try {
      lastResult = await analyse(username);
      rememberLoadedAccount(lastResult.username);
      steps.fadeOut(400);
      render();
    } catch (e) {
      steps.hide();
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      $go.disabled = false;
    }
  }

  $go.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  $grid.addEventListener('click', e => {
    if (e.target.closest('details, summary, button, a')) return;
    const card = e.target.closest('.adv-card');
    if (!card) return;
    if (e.target.closest('.card-head')) {
      card.classList.toggle('expanded');
    }
  });

  return {
    loadPlacements,
    /**
     * Called by the router every time this view becomes active. Idempotent:
     * if the username param differs from what's already in the input, the
     * field is updated and analysis re-runs. Otherwise it's a no-op (or
     * focuses the empty field).
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    }
  };
})();
