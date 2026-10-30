/* ═══════════════════════════════════════════════════════════════════
 *  TOP PRODUCTS
 *
 *  What each company earns now, and what it would earn making something
 *  else. Built for v0.27, laid out like the old
 *  Daily Profit tool: projected income, profit by product, your companies.
 *
 *  Output comes from three sources, all in production points (PP):
 *
 *    • automated engines: the config rate for the engine level. Since v0.27
 *      engines get no production bonus;
 *    • employees and self-work: the last full UTC day of
 *      work.getStatsByCompany (Premium API keys only). Stats are daily and
 *      employees move between companies, so older days are ignored.
 *
 *  A product turns PP into money at its margin per PP:
 *
 *    margin per PP = (sale price × (1 − market tax) − input cost) ÷ productionPoints
 *
 *  Profit is output × margin, minus employee wages and the manager's pay.
 *  Employee tax is withheld from wages, so it costs the owner nothing.
 *
 *  Employees pay off on a product while their wage expectation is below
 *  margin × (1 + bonus) ÷ ppValue. ppValue (gameStat.getPpMoneyValue) is
 *  the money value of a production point that the game sets every wage
 *  from: an employee is paid ppValue × expectation (70–130%) for each base
 *  point, and produces (1 + bonus) points for it. The bonus counted is the
 *  owner's Management and the manager (+2% a point, +44% together at most)
 *  plus +5% in a core region. The threshold excludes individual happiness,
 *  traits and specialization.
 *
 *  Prices are the volume-weighted average of each item's latest market
 *  trades (transaction.getPaginatedTransactions, type "trading"). Trades
 *  older than PRICE_MAX_AGE_MS are ignored, so an item nobody has traded
 *  recently has no price rather than a stale one.
 *
 *  Switching product costs company.changeItemCost concrete. Employees also
 *  lose their specialization on the old product while they make the new
 *  one (it's saved per product). The full tool shows this progress from
 *  employee rosters; switching estimates still hold output fixed.
 *
 *  Access: Irish citizens only (enforceIrishOnly). bypass=1 lifts it.
 * ═══════════════════════════════════════════════════════════════════ */
const ProductPickerTool = (() => {
  const companyUrlFor = id => `${GAME_BASE}/company/${id}`;

  // Busy items trade 100 times in minutes to a couple of hours.
  const PRICE_SAMPLE_TRADES = 100;
  const PRICE_MAX_AGE_MS = 24 * 3600 * 1000;
  const CHANGE_ITEM_COST_FALLBACK = 5;
  const MGMT_PCT_PER_POINT = 2;
  const MGMT_CAP_PCT = 44;
  const CORE_REGION_PCT = 5;
  const WAGE_EXPECTATION_MIN = 70;
  const WAGE_EXPECTATION_MAX = 130;

  const ITEMS = {
    cookedFish: { name: 'Cooked Fish',      file: 'cookedFish.png', fb: '🍣' },
    steak:      { name: 'Steak',            file: 'steak.png',      fb: '🥩' },
    bread:      { name: 'Bread',            file: 'bread.png',      fb: '🍞' },
    fish:       { name: 'Fish',             file: 'fish.png',       fb: '🐟' },
    livestock:  { name: 'Livestock',        file: 'livestock.png',  fb: '🐄' },
    grain:      { name: 'Grain',            file: 'grain.png',      fb: '🌾' },
    cocain:     { name: 'Pill',             file: 'cocain.png',     fb: '💊' },
    coca:       { name: 'Mysterious Plant', file: 'coca.png',       fb: '🌿' },
    heavyAmmo:  { name: 'Heavy Ammo',       file: 'heavyAmmo.png',  fb: '💥' },
    ammo:       { name: 'Ammo',             file: 'ammo.png',       fb: '🔫' },
    lightAmmo:  { name: 'Light Ammo',       file: 'lightAmmo.png',  fb: '•' },
    lead:       { name: 'Lead',             file: 'lead.png',       fb: '⚫' },
    steel:      { name: 'Steel',            file: 'steel.png',      fb: '🏗️' },
    iron:       { name: 'Iron',             file: 'iron.png',       fb: '⛓️' },
    concrete:   { name: 'Concrete',         file: 'concrete.png',   fb: '🧱' },
    limestone:  { name: 'Limestone',        file: 'limestone.png',  fb: '🪨' },
    oil:        { name: 'Oil',              file: 'oil.png',        fb: '⛽' },
    petroleum:  { name: 'Petroleum',        file: 'petroleum.png',  fb: '🛢️' },
    paper:      { name: 'Paper',            file: 'paper.png',      fb: '📄' },
    wood:       { name: 'Wood',             file: 'wood.png',       fb: '🪵' },
  };

  const $username   = document.getElementById('pp-username');
  const $go         = document.getElementById('pp-go');
  const $hint       = document.getElementById('pp-hint');
  const $bestCard   = document.getElementById('pp-best-card');
  const $incomeCard = document.getElementById('pp-income-card');
  const $incomeHead = document.getElementById('pp-income-head');
  const $assump     = document.getElementById('pp-assump');
  const $income     = document.getElementById('pp-income');
  const $prodCard   = document.getElementById('pp-products-card');
  const $prodTable  = document.getElementById('pp-products');
  const $compCard   = document.getElementById('pp-companies-card');
  const $compTable  = document.getElementById('pp-companies');
  const $mobile     = document.getElementById('pp-mobile');
  const steps       = makeSteps(document.getElementById('pp-steps'));
  const setStatus   = makeStatus(document.getElementById('pp-status'));

  let model = null;
  // What-if output and table sorting reset when a new player loads.
  let overrides = {};
  let sort = { key: 'totalWithoutSelf', dir: -1 };
  let companySort = { key: 'company', dir: 1 };

  const pp_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  async function resolveUser(username) {
    const needle = username.trim().toLowerCase();
    const search = await pp_trpc('search.searchAnything', { searchText: username });
    const ids = (search?.userIds || []).slice(0, 10);
    if (!ids.length) throw new Error(`No user found matching "${username}"`);
    const profiles = await trpcManyValues('user.getUserLite', ids.map(userId => ({ userId })));
    const exact = profiles.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle);
    if (!exact) throw new Error(`No exact match for "${username}"`);
    return exact;
  }

  /**
   * Volume-weighted average price per item over its latest trades, all
   * items in one batched request. Trades past PRICE_MAX_AGE_MS are dropped,
   * and an item left with none gets no price.
   */
  async function tradePrices(codes) {
    const cutoff = Date.now() - PRICE_MAX_AGE_MS;
    const pages = await trpcManyValues('transaction.getPaginatedTransactions', codes.map(code => ({
      transactionType: 'trading', itemCode: code, limit: PRICE_SAMPLE_TRADES,
    })));
    const prices = {};
    pages.forEach((page, i) => {
      let money = 0, qty = 0, trades = 0, since = null;
      for (const tx of page?.items || []) {
        if (!(tx.quantity > 0) || typeof tx.money !== 'number') continue;
        const at = new Date(tx.createdAt).getTime();
        if (at < cutoff) continue;
        money += tx.money; qty += tx.quantity; trades++;
        since = since == null ? at : Math.min(since, at);
      }
      if (qty > 0) prices[codes[i]] = { price: money / qty, trades, qty, since };
    });
    return prices;
  }


  /** Employee output, wages and self-work from the last full UTC day. */
  function lastFullDay(stats) {
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const row = (stats || []).find(d => d.dailyDate === day) || {};
    return { total: row.total || 0, empPP: row.employeeProd || 0, wage: row.wage || 0, selfPP: row.selfWork || 0 };
  }

  /**
   * Companies, their output, costs and managers, and live prices for one
   * player. Also used by the dashboard's Top products card, so progress
   * goes through an optional makeSteps().setStep-shaped callback (steps 2
   * and 3).
   *
   * @param {{_id: string, username: string}} user
   * @param {function(number, string, Object):void} [step]
   * @param {{includeSpecialisations?: boolean}} [options]
   */
  async function loadModel(user, step = () => {}, { includeSpecialisations = false } = {}) {
    step(2, 'active', { sub: 'Fetching company list' });
    const full = user.skills?.management?.total != null ? user : await pp_trpc('user.getUserById', { userId: user._id });
    const [companyList, gameConfig, country, ppValue] = await Promise.all([
      pp_trpc('company.getCompanies', { userId: full._id, perPage: 100 }),
      pp_trpc('gameConfig.getGameConfig', {}),
      pp_trpc('country.getCountryById', { countryId: full.country }).catch(() => null),
      pp_trpc('gameStat.getPpMoneyValue', null).catch(() => null),
    ]);
    const companyIds = companyList?.items || [];
    if (!companyIds.length) throw new Error(`"${full.username}" has no companies`);
    step(2, 'active', { sub: 'Loading companies, output and managers', count: `0/${companyIds.length}` });
    const companies = (await trpcManyValues('company.getById', companyIds.map(companyId => ({ companyId })),
      { onProgress: (done, total) => step(2, 'active', { count: `${done}/${total}` }) }))
      .filter(c => c && !c.disabledAt);
    if (!companies.length) throw new Error(`All of "${full.username}"'s companies are disabled`);
    const byCompany = companies.map(c => ({ companyId: c._id }));
    const [statsSettled, managers, offers, regions, rosters] = await Promise.all([
      // Only Premium API keys can read this; a 403 means the proxy has none.
      trpcMany('work.getStatsByCompany', companies.map(c => ({ companyId: c._id, days: 2 }))),
      trpcManyValues('manager.getByCompanyId', byCompany),
      trpcManyValues('managerOffer.getByCompanyId', byCompany),
      trpcManyValues('region.getById', [...new Set(companies.map(c => c.region))].map(regionId => ({ regionId }))),
      includeSpecialisations ? trpcManyValues('employee.getCompanyEmployees', byCompany) : [],
    ]);
    const managerIds = [...new Set(managers.map(m => m?.user).filter(Boolean))];
    const managerUsers = await trpcManyValues('user.getUserLite', managerIds.map(userId => ({ userId })));
    const managerName = Object.fromEntries(managerIds.map((id, i) => [id, managerUsers[i]?.username]));
    const regionById = Object.fromEntries(regions.filter(Boolean).map(r => [r._id, r]));
    const statsNeedPremium = statsSettled.some(result => result.status === 'rejected' && result.reason?.status === 403);
    const aeLevels = gameConfig?.upgradesConfig?.automatedEngine?.levels || {};
    const rows = companies.map((company, i) => {
      const stats = statsSettled[i].status === 'fulfilled' ? statsSettled[i].value : null;
      const manager = managers[i]?._id ? managers[i] : null;
      return {
        company,
        region: regionById[company.region] || null,
        corePct: regionById[company.region]?.initialCountry === full.country ? CORE_REGION_PCT : 0,
        aePP: aeLevels[company.activeUpgradeLevels?.automatedEngine]?.stats?.dailyProd || 0,
        ...lastFullDay(stats),
        statsMissing: stats == null,
        employees: Array.isArray(rosters[i]) ? rosters[i] : null,
        manager,
        managerName: manager ? managerName[manager.user] || null : null,
        managerPct: manager?.productionBonusPercent || 0,
        managerDay: manager ? (manager.hourlyWage || 0) * 24 : 0,
        offer: offers[i]?._id ? offers[i] : null,
      };
    });
    step(2, 'done', { count: `${rows.length} active` });

    const gameItems = gameConfig?.items || {};
    const codes = Object.keys(ITEMS).filter(code => gameItems[code]?.productionPoints);
    step(3, 'active', { sub: `Averaging the latest ${PRICE_SAMPLE_TRADES} trades per item` });
    const prices = await tradePrices(codes);
    step(3, 'done', { count: `${Object.keys(prices).length} priced` });

    return {
      username: full.username, companies: rows, gameItems, codes, prices,
      taxes: country?.taxes || { income: 0, market: 0, manager: 0 },
      mgmtPct: (full.skills?.management?.total || 0) * MGMT_PCT_PER_POINT,
      ppValue: typeof ppValue === 'number' && ppValue > 0 ? ppValue : null,
      changeItemCost: gameConfig?.company?.changeItemCost ?? CHANGE_ITEM_COST_FALLBACK,
      statsNeedPremium,
      selfWorkEnergy: full.skills?.energy?.total ?? null,
      selfWorkProduction: full.skills?.production?.total ?? null,
      selfWorkEnergyCost: gameConfig?.user?.energyCostPerAction ?? null,
    };
  }

  /** Sale price after market tax, input cost and margin per PP, or null. */
  function margin(m, code) {
    const it = m.gameItems[code];
    const sale = m.prices[code]?.price;
    if (!it?.productionPoints || sale == null) return null;
    let inputs = 0;
    for (const [input, qty] of Object.entries(it.productionNeeds || {})) {
      const p = m.prices[input]?.price;
      if (p == null) return null;
      inputs += qty * p;
    }
    const net = sale * (1 - (m.taxes.market || 0) / 100);
    return { sale, net, inputs, perPP: (net - inputs) / it.productionPoints };
  }

  const outputPP = c => c.aePP + c.empPP + c.selfPP;
  const costDay = c => c.wage + c.managerDay;
  function profitAt(m, c, code) {
    const mg = margin(m, code);
    return mg ? outputPP(c) * mg.perPP - costDay(c) : null;
  }

  /** The employee bonus that applies in a company, as a percentage. */
  const employeeBonusPct = (m, c) => Math.min(MGMT_CAP_PCT, m.mgmtPct + c.managerPct) + c.corePct;

  /**
   * The highest wage expectation (%) at which an employee still earns more
   * than they cost making this product, or null without a price or ppValue.
   */
  function payOffLimit(m, code, bonusPct) {
    const mg = margin(m, code);
    if (!mg || !m.ppValue) return null;
    return mg.perPP * (1 + bonusPct / 100) / m.ppValue * 100;
  }

  function totals(m) {
    return m.companies.reduce((t, c) => ({
      aePP: t.aePP + c.aePP, empPP: t.empPP + c.empPP, selfPP: t.selfPP + c.selfPP,
      wage: t.wage + c.wage, managerDay: t.managerDay + c.managerDay,
    }), { aePP: 0, empPP: 0, selfPP: 0, wage: 0, managerDay: 0 });
  }

  /**
   * One row per priced product: margin, what each output source would earn
   * if all of it went to this product, and the employee pay-off limit.
   * `profitDay` is all output on this product, minus wages and managers.
   * Sorted by margin, best first.
   */
  function productRows(m, ov = {}) {
    const t = totals(m);
    const aePP = ov.aePP ?? t.aePP, empPP = ov.empPP ?? t.empPP, selfPP = ov.selfPP ?? t.selfPP;
    const costs = t.wage + t.managerDay;
    const corePct = Math.max(0, ...m.companies.map(c => c.corePct));
    const rows = m.codes.map(code => {
      const mg = margin(m, code);
      const mine = m.companies.filter(c => c.company.itemCode === code);
      if (!mg) return { code, mg, owned: mine.length };
      const maxEmployees = empPP * mg.perPP - costs;
      const maxEngines = aePP * mg.perPP;
      const maxSelf = selfPP * mg.perPP;
      const totalWithoutSelf = maxEngines + Math.max(0, maxEmployees);
      return {
        code, mg, owned: mine.length,
        maxEngines,
        maxEmployees,
        maxSelf, totalWithoutSelf,
        totalWithSelf: totalWithoutSelf + maxSelf,
        profitDay: (aePP + empPP + selfPP) * mg.perPP - costs,
        actual: mine.length ? mine.reduce((sum, c) => sum + profitAt(m, c, code), 0) : null,
        payOff: payOffLimit(m, code, m.mgmtPct + corePct),
      };
    });
    rows.sort((a, b) => (b.mg?.perPP ?? -Infinity) - (a.mg?.perPP ?? -Infinity));
    return { rows, totals: t };
  }

  /** Current product vs the most profitable one for a company. */
  function companyPlan(m, c) {
    const profitNow = profitAt(m, c, c.company.itemCode);
    let best = null;
    for (const code of m.codes) {
      const mg = margin(m, code);
      if (mg && (!best || mg.perPP > best.mg.perPP)) best = { code, mg };
    }
    if (!best || profitNow == null) return { best, profitNow, gain: null };
    if (best.code === c.company.itemCode) return { best, profitNow, gain: 0, isBest: true };
    const concrete = m.prices.concrete?.price;
    return {
      best, profitNow, isBest: false,
      gain: profitAt(m, c, best.code) - profitNow,
      cost: concrete != null ? m.changeItemCost * concrete : null,
    };
  }

  const HELP = {
    income: ['About projected income', '<p>Total per day and week includes engines and employees, minus wages and manager pay. It excludes self-work. Engines use their configured output; employee output and wages use the last full UTC day.</p><p>The estimate beneath Total adds one full energy bar spent on self-work at your best-margin owned product, using your Production stat. The weekly estimate assumes this each day. It assumes storage space and excludes energy regenerated while working.</p><p>Engine and employee inputs update income and product comparisons as you type, keeping their current product mix and costs. The self-work input starts at one full energy bar and affects the product comparison only. Company rows and Actual values keep the loaded figures.</p>'],
    best: ['About the highest margin', '<p>This product has the highest margin per production point at current market prices. Rankings change over time.</p><p>This is a price snapshot, not a recommendation to switch your workforce. Changing products affects employee specialisation and trait bonuses. For example, Labourer favours raw resources and penalises manufactured goods; Craftsman does the reverse. Company comparisons hold output fixed and do not include these changes.</p>'],
    products: ['About product margins', '<p>Margin per production point (PP) is the sale price after market tax, minus input costs, divided by the PP needed to make it. Inputs use market prices even when you make them yourself.</p><p>Prices average the latest 100 trades, weighted by quantity. Trades older than 24 hours are excluded. Products without recent prices are omitted.</p><p>Max columns put all your output into that product. Without self-work adds engines and profitable employee output. With self-work adds Max self-work, using the PP input above. Both exclude employee output when it loses money. The default sort is Without self-work, highest first. Actual is what your companies making it earn now. Green rows are products you make. Click a heading to sort.</p><p>Employees pay off shows the highest wage expectation that earns a profit, using your Management and core-region bonus. Wages use the game’s PP value × wage expectation (70–130%). Bonuses increase output without increasing wages. This threshold excludes individual happiness, traits and specialisation.</p>'],
    companies: ['About company profits and switching', '<p>Daily profit is output × the current product margin, minus wages and manager pay. Employee bonuses include your Management, the manager and a core region.</p><p>Gain per day compares the current product with the best product at the same output and costs. Switch cost is the concrete needed to change products. Companies start grouped by product, then ordered by company name. Click a column heading to sort; click again to reverse it.</p><p>Expand Specialisations to see each employee’s current bonus and saved progress on other products, capped at +20%. An unlisted product has no saved progress. Switching restores that product’s progress. Potential gains hold output fixed and exclude changes to specialisation and trait bonuses. Labourer favours raw resources and penalises manufactured goods; Craftsman does the reverse.</p>'],
  };
  const help = key => sectionHelp(...HELP[key]);

  /* ── Rendering ─────────────────────────────────────────── */
  const num = (v, dp = 2) => v == null || !isFinite(v) ? '–'
    : v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const money = v => v == null || !isFinite(v) ? '–' : `${v < 0 ? '−' : ''}₿${num(Math.abs(v), Math.abs(v) < 10 ? 2 : 0)}`;
  const signedMoney = v => v == null || !isFinite(v) ? '–'
    : `<span class="${v >= 0 ? 'pp-pos' : 'pp-neg'}">${v >= 0 ? '+' : ''}${money(v)}</span>`;
  const muted = text => `<span class="dp-muted">${text}</span>`;
  const pill = (label, kind) => `<span class="dash-pill ${kind}">${escapeHtml(label)}</span>`;

  function iconBox(code) {
    const it = ITEMS[code] || { fb: '📦' };
    return it.file
      ? `<div class="icon-box"><img src="images/${it.file}" alt="" onerror="this.outerHTML='<span class=\\'fallback\\'>${it.fb}</span>'"></div>`
      : `<div class="icon-box"><span class="fallback">${it.fb}</span></div>`;
  }

  function productCell(code, suffix = '') {
    return `<span class="dp-prod">${iconBox(code)}<span>${escapeHtml(ITEMS[code]?.name || code)}</span>${suffix}</span>`;
  }

  function payOffHtml(limit) {
    if (limit == null) return muted('–');
    if (limit >= WAGE_EXPECTATION_MAX) return pill('any', 'ok');
    if (limit < WAGE_EXPECTATION_MIN) return pill('none', 'loss');
    return pill(`≤ ${num(limit, 0)}%`, 'warn');
  }

  function bonusChips(c) {
    if (!c.empPP) return muted('no employees');
    const chip = (label, pct) => `<span class="pp-chip${pct ? '' : ' off'}">${label} +${num(pct, 0)}%</span>`;
    return `<span class="pp-chips">${chip('Mgmt', model.mgmtPct)}${chip('Manager', c.managerPct)}${chip('Core', c.corePct)}</span>`;
  }

  function statusTags(c) {
    const tags = [];
    if (c.company.isFull) tags.push(['warn', 'Storage full', 'Production stops until the storage is emptied.']);
    if (!c.statsMissing && c.total === 0) tags.push(['warn', 'Idle', 'No output on the last full day.']);
    else if ((profitAt(model, c, c.company.itemCode) ?? 0) < 0) tags.push(['loss', 'Losing money', 'Wages and the manager cost more than the output is worth.']);
    if ((margin(model, c.company.itemCode)?.perPP ?? 0) < 0) tags.push(['loss', 'Inputs cost more', 'The inputs cost more than the product sells for.']);
    if (c.manager?.isInactive) tags.push(['warn', 'Manager inactive', 'The manager is inactive, so their bonus may not apply.']);
    if (!c.manager && c.empPP > 0) tags.push(['info', c.offer ? 'Hiring a manager' : 'No manager', 'A manager adds +2% per point to every employee.']);
    if (!tags.length) return '';
    return `<div class="pp-tags">${tags.map(([kind, label, tip]) => `<span class="dash-pill ${kind}" title="${escapeHtml(tip)}">${label}</span>`).join('')}</div>`;
  }

  function managerHtml(c) {
    const mgr = c.manager;
    if (mgr) {
      const lock = new Date(mgr.canEndAt || mgr.lockedUntil);
      return `<span class="pp-mgr"><strong>${escapeHtml(c.managerName || 'Unknown')}</strong>${mgr.isInactive ? ' ' + pill('inactive', 'warn') : ''}
        <small>+${num(mgr.productionBonusPercent, 0)}% · ₿${num(mgr.hourlyWage, 3)}/h (${money(c.managerDay)}/day)</small>
        <small>${lock > new Date() ? `locked until ${lock.toUTCString().slice(5, 22)} UTC` : 'can be ended'}</small></span>`;
    }
    if (c.offer) return `<span class="pp-mgr"><strong class="dp-muted">Hiring</strong><small>up to ₿${num(c.offer.maxHourlyWage, 3)}/h</small></span>`;
    return muted('None');
  }

  /** The product with the highest current margin per production point. */
  function bestSummary() {
    return { best: productRows(model).rows.find(r => r.mg) || null };
  }

  function renderBest() {
    const { best } = bestSummary();
    if (!best) { $bestCard.classList.add('hidden'); return; }
    const fact = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
    $bestCard.innerHTML = `
      <div class="pp-best-main">${iconBox(best.code)}
        <div><div class="pp-best-label">Highest margin right now</div><div class="pp-best-name">${escapeHtml(ITEMS[best.code]?.name || best.code)}</div></div>
      </div>
      <div class="pp-best-facts">
        ${fact('Margin', `${num(best.mg.perPP, 3)} / PP`)}
        ${fact('Employees pay off', payOffHtml(best.payOff))}
        ${fact('You make it', best.owned ? `×${best.owned}` : 'not yet')}
      </div>`;
    $bestCard.classList.remove('hidden');
  }

  /** Money earned per source on each company's current product, and the total. */
  function incomeSummary(m = model, ov = {}) {
    const actual = totals(m);
    const t = {
      ...actual,
      aePP: ov.aePP ?? actual.aePP,
      empPP: ov.empPP ?? actual.empPP,
      selfPP: ov.selfPP ?? actual.selfPP,
    };
    const ownedMargins = m.companies.map(c => margin(m, c.company.itemCode)?.perPP).filter(v => v != null);
    const fallbackMargin = ownedMargins.length ? Math.max(...ownedMargins) : 0;
    const earned = key => {
      const current = m.companies.reduce((sum, c) => sum + c[key] * (margin(m, c.company.itemCode)?.perPP ?? 0), 0);
      return ov[key] == null ? current : t[key] * (actual[key] > 0 ? current / actual[key] : fallbackMargin);
    };
    const engines = earned('aePP'), employees = earned('empPP'), self = earned('selfPP');
    const costs = actual.wage + actual.managerDay;
    return {
      t, costs, engines, employees, self,
      total: engines + employees + self - costs,
      statsMissing: m.companies.some(c => c.statsMissing),
      unpriced: m.companies.some(c => !margin(m, c.company.itemCode)),
    };
  }

  /** One full energy bar spent on the best-margin product already owned. */
  function selfWorkProjection(m) {
    const energy = m.selfWorkEnergy, production = m.selfWorkProduction, cost = m.selfWorkEnergyCost;
    if (![energy, production, cost].every(Number.isFinite) || energy < 0 || production < 0 || cost <= 0) return null;
    let best = null;
    for (const c of m.companies) {
      const mg = margin(m, c.company.itemCode);
      if (!mg) return null;
      if (!best || mg.perPP > best.perPP) best = { company: c.company, perPP: mg.perPP };
    }
    if (!best) return null;
    const actions = Math.floor(energy / cost);
    const pp = actions * production;
    return { energy, cost, actions, pp, profit: pp * best.perPP, company: best.company };
  }

  function renderIncome() {
    const t = totals(model);
    overrides.selfPP ??= selfWorkProjection(model)?.pp ?? 0;
    const field = (id, label, value, suffix) => `
      <div class="dp-field">
        <label for="${id}">${label}</label>
        <input type="number" id="${id}" value="${Math.round(value)}" min="0" step="1">
        <span class="dp-suffix">${suffix}</span>
      </div>`;
    $incomeHead.textContent = `Projected income · ${model.username}`;
    $assump.innerHTML = `
      ${field('pp-ae', 'Engine PP / day', overrides.aePP ?? t.aePP, 'automated engines')}
      ${field('pp-emp', 'Employee PP / day', overrides.empPP ?? t.empPP, 'last full day')}
      ${field('pp-self', 'Self-work PP / day', overrides.selfPP, 'product comparison only')}`;
    renderIncomeTotals();
    const bind = (id, key) => $assump.querySelector(`#${id}`).addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      overrides[key] = isFinite(v) && v >= 0 ? v : 0;
      renderIncomeTotals();
      renderProducts();
      renderMobile();
    });
    bind('pp-ae', 'aePP');
    bind('pp-emp', 'empPP');
    bind('pp-self', 'selfPP');
    $incomeCard.classList.remove('hidden');
  }

  function incomeTotalValue(total) {
    return `${money(total)}<small class="pp-total-week">≈ ${money(total * 7)}/week</small>`;
  }

  function incomeTotalNote(total) {
    const projection = selfWorkProjection(model);
    if (!projection) return 'Self-work estimate unavailable';
    const withSelfWork = total + projection.profit;
    return `With self-work: ${money(withSelfWork)}/day · ${money(withSelfWork * 7)}/week`;
  }

  const incomeTone = value => value > 0 ? 'pp-inc-positive' : value < 0 ? 'pp-inc-negative' : '';

  function renderIncomeTotals() {
    const { t, costs, engines, employees } = incomeSummary(model, overrides);
    const total = engines + employees - costs;
    const tile = (label, value, sub, cls = '') => `<div class="dp-inc ${cls}"><div class="dp-inc-label">${label}</div><div class="dp-inc-val">${value}</div><div class="dp-inc-sub">${sub}</div></div>`;
    $income.innerHTML = `
      ${tile('Engines', money(engines), `${num(t.aePP, 0)} PP`, incomeTone(engines))}
      ${tile('Employees', money(employees), `${num(t.empPP, 0)} PP`, incomeTone(employees))}
      ${tile('Wages + managers', '−' + money(costs), `employee tax ${num(model.taxes.income, 0)}% is withheld from wages`, 'dp-inc-deduct')}
      ${tile('Total / day', incomeTotalValue(total), incomeTotalNote(total), total < 0 ? 'total dp-inc-deduct' : 'total')}`;
  }

  const PRODUCT_COLS = [
    { key: 'name',         label: 'Product', l: true, dir: 1 },
    { key: 'perPP',        label: 'Margin / PP', title: 'Sale price after market tax, minus inputs, per production point' },
    { key: 'maxEngines',   label: 'Max engines', title: 'If all your automated engines made this' },
    { key: 'maxEmployees', label: 'Max employees', title: 'If all your employees made this, minus wages and managers' },
    { key: 'maxSelf',      label: 'Max self-work', title: 'If all your self-work went into this' },
    { key: 'totalWithoutSelf', label: 'Without self-work', title: 'Max engines plus max employees when positive, per day' },
    { key: 'totalWithSelf', label: 'With self-work', title: 'Total without self-work plus max self-work, per day' },
    { key: 'actual',       label: 'Actual / day', title: 'What your companies making this earn now' },
    { key: 'payOff',       label: 'Employees pay off', title: 'Highest wage expectation (70–130%) at which an employee still makes money on this product, with your Management and core-region bonus' },
  ];
  const sortValue = (r, key) => key === 'name' ? (ITEMS[r.code]?.name || r.code)
    : key === 'perPP' ? r.mg?.perPP : r[key];

  function compareValues(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (typeof a === 'string' ? a.localeCompare(b) : a - b) * dir;
  }

  function sortableHead(columns, state) {
    return `<thead><tr>${columns.map(c => {
      const active = state.key === c.key;
      const aria = active ? (state.dir === 1 ? 'ascending' : 'descending') : 'none';
      const arrow = active ? (state.dir === 1 ? '▲' : '▼') : '↕';
      return `<th class="dp-sortable${c.l ? ' dp-l' : ''}" aria-sort="${aria}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><button type="button" class="pp-sort" data-sort-key="${c.key}">${c.label}<span class="dp-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
    }).join('')}</tr></thead>`;
  }

  function bindSorting(table, columns, state, update, renderTable) {
    table.querySelectorAll('button[data-sort-key]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      const column = columns.find(c => c.key === key);
      const focused = document.activeElement === button;
      update({ key, dir: state.key === key ? -state.dir : column.dir || -1 });
      renderTable();
      if (focused) table.querySelector(`button[data-sort-key="${key}"]`).focus({ preventScroll: true });
    }));
  }

  function renderProducts() {
    const { rows } = productRows(model, overrides);
    const priced = rows.filter(r => r.mg);
    priced.sort((a, b) => compareValues(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir));
    $prodTable.innerHTML = `
      ${sortableHead(PRODUCT_COLS, sort)}
      <tbody>${priced.map(r => `<tr class="${r.owned ? 'dp-owned' : ''}">
        <td class="dp-l">${productCell(r.code, r.owned ? `<span class="dp-pill" title="You have ${r.owned} compan${r.owned === 1 ? 'y' : 'ies'} making this">×${r.owned}</span>` : '')}</td>
        <td><strong>${num(r.mg.perPP, 3)}</strong></td>
        <td>${money(r.maxEngines)}</td>
        <td>${r.maxEmployees < 0 ? signedMoney(r.maxEmployees) : money(r.maxEmployees)}</td>
        <td>${money(r.maxSelf)}</td>
        <td><strong class="${r.totalWithoutSelf > 0 ? 'pp-pos' : r.totalWithoutSelf < 0 ? 'pp-neg' : ''}">${money(r.totalWithoutSelf)}</strong></td>
        <td><strong>${money(r.totalWithSelf)}</strong></td>
        <td>${r.actual == null ? muted('–') : money(r.actual)}</td>
        <td>${payOffHtml(r.payOff)}</td>
      </tr>`).join('')}</tbody>`;
    bindSorting($prodTable, PRODUCT_COLS, sort, value => { sort = value; }, renderProducts);
    $prodCard.classList.remove('hidden');
  }

  const COMPANY_COLS = [
    { key: 'company', label: 'Product / company', l: true, dir: 1 },
    { key: 'bonus', label: 'Employee bonus', l: true },
    { key: 'manager', label: 'Manager', l: true, dir: 1 },
    { key: 'engine', label: 'Engine PP' },
    { key: 'employee', label: 'Employee PP' },
    { key: 'payOff', label: 'Employees pay off', title: 'Highest wage expectation at which an employee still makes money on the current product, with this company’s bonuses' },
    { key: 'wages', label: 'Wages' },
    { key: 'profit', label: 'Profit / day' },
    { key: 'best', label: 'Highest margin', l: true, dir: 1 },
    { key: 'gain', label: 'Potential gain / day' },
    { key: 'cost', label: 'Switch cost' },
  ];

  function companySortValue({ c, plan }, key) {
    const switching = plan.gain != null && !plan.isBest;
    switch (key) {
      case 'company': return c.company.name || ITEMS[c.company.itemCode]?.name || c.company.itemCode;
      case 'bonus': return c.empPP ? employeeBonusPct(model, c) : null;
      case 'manager': return c.manager ? c.managerName || 'Unknown' : null;
      case 'engine': return c.aePP;
      case 'employee': return c.statsMissing ? null : c.empPP;
      case 'payOff': return c.empPP ? payOffLimit(model, c.company.itemCode, employeeBonusPct(model, c)) : null;
      case 'wages': return costDay(c) > 0 ? costDay(c) : null;
      case 'profit': return plan.profitNow;
      case 'best': return plan.best ? ITEMS[plan.best.code]?.name || plan.best.code : null;
      case 'gain': return switching ? plan.gain : null;
      case 'cost': return switching ? plan.cost : null;
    }
  }

  function renderCompanies() {
    const rows = model.companies.map(c => ({ c, plan: companyPlan(model, c) }));
    const byProductAndName = (a, b, dir = 1) => {
      const product = c => ITEMS[c.company.itemCode]?.name || c.company.itemCode;
      return product(a.c).localeCompare(product(b.c)) * dir
        || companySortValue(a, 'company').localeCompare(companySortValue(b, 'company'), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    };
    rows.sort((a, b) => companySort.key === 'company'
      ? byProductAndName(a, b, companySort.dir)
      : compareValues(companySortValue(a, companySort.key), companySortValue(b, companySort.key), companySort.dir) || byProductAndName(a, b));
    $compTable.innerHTML = `
      ${sortableHead(COMPANY_COLS, companySort)}
      <tbody>${rows.map(({ c, plan }, index) => {
        const { company } = c;
        const itemName = ITEMS[company.itemCode]?.name;
        const label = company.name && company.name !== itemName ? `<span class="dp-cat">${escapeHtml(company.name)}</span>` : '';
        const switching = plan.gain != null && !plan.isBest;
        const groupStart = companySort.key === 'company' && index > 0 && rows[index - 1].c.company.itemCode !== company.itemCode;
        return `<tr${groupStart ? ' class="pp-company-group-start"' : ''}>
          <td class="dp-l"><a href="${companyUrlFor(company._id)}" target="_blank" rel="noopener">${productCell(company.itemCode, label)}</a>${statusTags(c)}${specialisationsHtml(c)}</td>
          <td class="dp-l">${bonusChips(c)}</td>
          <td class="dp-l">${managerHtml(c)}</td>
          <td>${num(c.aePP, 0)}</td>
          <td>${c.statsMissing ? muted('–') : num(c.empPP, 1)}</td>
          <td>${c.empPP ? payOffHtml(payOffLimit(model, company.itemCode, employeeBonusPct(model, c))) : muted('–')}</td>
          <td>${costDay(c) > 0 ? money(costDay(c)) : muted('–')}</td>
          <td>${money(plan.profitNow)}</td>
          <td class="dp-l">${!plan.best ? muted('–') : plan.isBest ? pill('✓ Already making it', 'ok') : productCell(plan.best.code)}</td>
          <td>${switching ? signedMoney(plan.gain) : muted('–')}</td>
          <td>${switching ? money(plan.cost) : muted('–')}</td>
        </tr>`;
      }).join('')}</tbody>`;
    bindSorting($compTable, COMPANY_COLS, companySort, value => { companySort = value; }, renderCompanies);
    $compCard.classList.remove('hidden');
  }

  function specialisationsHtml(c) {
    if (!c.employees) return '<div class="pp-spec-status">Specialisations unavailable</div>';
    if (!c.employees.length) return '<div class="pp-spec-status">No employees</div>';
    const current = c.company.itemCode;
    return `<details class="pp-spec"><summary>Specialisations · ${c.employees.length} employee${c.employees.length === 1 ? '' : 's'}</summary>
      <ul>${c.employees.map(emp => {
        const saved = emp.specializations;
        const currentBonus = emp.productionBonus?.contributions?.find(b => b.source === 'specialization')?.percent;
        const products = [...new Set([current, ...Object.keys(saved || {})])];
        return `<li><strong>${escapeHtml(emp.name || 'Unnamed employee')}</strong>
          <div class="pp-spec-products">${products.map(code => {
            const progress = code === current && Number.isFinite(currentBonus) ? currentBonus : saved ? saved[code] ?? 0 : null;
            const bonus = Number.isFinite(progress) ? `+${num(Math.min(20, progress), 0)}%` : 'unavailable';
            return `<span${code === current ? ' class="pp-spec-current"' : ''}>${escapeHtml(ITEMS[code]?.name || code)} ${bonus}${code === current ? ' · current' : ''}</span>`;
          }).join('')}</div>
          ${!saved ? '<div class="pp-spec-status">Saved progress unavailable</div>' : ''}
        </li>`;
      }).join('')}</ul>
    </details>`;
  }

  /* ── Phone layout ──────────────────────────────────────────
   *  Below 720px the desktop cards are hidden (styles.css) and this shows
   *  instead: income tiles, the best product, a ranked product list
   *  and one card per company. It has no what-if fields. */
  const MOBILE_PRODUCTS = 8;

  function mobileManagerLine(c) {
    if (c.manager) return `${escapeHtml(c.managerName || 'Unknown')} · +${num(c.manager.productionBonusPercent, 0)}% · ${money(c.managerDay)}/day${c.manager.isInactive ? ' · inactive' : ''}`;
    if (c.offer) return `Hiring · up to ₿${num(c.offer.maxHourlyWage, 3)}/h`;
    return 'None';
  }

  function renderMobile() {
    const name = code => escapeHtml(ITEMS[code]?.name || code);
    const priced = productRows(model, overrides).rows.filter(r => r.mg);
    const { best } = bestSummary();
    const plans = model.companies.map(c => ({ c, plan: companyPlan(model, c) }));
    const { t, costs, engines, employees } = incomeSummary(model, overrides);
    const total = engines + employees - costs;
    const tile = (label, value, sub, cls = '') => `<div class="pp-m-tile ${cls}"><span>${label}</span><b>${value}</b><span>${sub}</span></div>`;

    const bestCard = best ? `
      <div class="pp-m-card pp-m-best section-help-card">${help('best')}
        <div class="pp-m-sub">Highest margin right now</div>
        <div class="pp-m-best-name">${iconBox(best.code)}<span>${name(best.code)}</span></div>
        <div class="pp-m-sub">${num(best.mg.perPP, 3)} per production point${best.owned ? ` · you make ×${best.owned}` : ''} · employees pay off: ${payOffHtml(best.payOff)}</div>
      </div>` : '';

    const incomeCard = `
      <div class="pp-m-card section-help-card">${help('income')}
        <h3>Projected income</h3>
        <div class="pp-m-tiles">
          ${tile('Engines', money(engines), `${num(t.aePP, 0)} PP`, incomeTone(engines))}
          ${tile('Employees', money(employees), `${num(t.empPP, 0)} PP`, incomeTone(employees))}
          ${tile('Wages + managers', `<span class="pp-neg">−${money(costs)}</span>`, 'last full day', 'pp-m-cost')}
          ${tile('Total / day', `<span class="${total < 0 ? 'pp-neg' : 'pp-pos'}">${incomeTotalValue(total)}</span>`, incomeTotalNote(total), `pp-m-total${total < 0 ? ' neg' : ''}`)}
        </div>
      </div>`;

    const productRow = (r, i) => `
      <div class="pp-m-row">
        <span class="pp-m-rank">${i + 1}</span>${iconBox(r.code)}
        <div class="pp-m-grow">
          <div class="pp-m-name">${name(r.code)}</div>
          <div class="pp-m-sub">${r.owned ? `<span class="pp-m-mine">you make ×${r.owned}</span> · ` : ''}<span class="${r.totalWithoutSelf > 0 ? 'pp-pos' : r.totalWithoutSelf < 0 ? 'pp-neg' : ''}">${money(r.totalWithoutSelf)}/day</span> without self-work</div>
          <div class="pp-m-sub">${money(r.totalWithSelf)}/day with self-work</div>
        </div>
        <div class="pp-m-right"><strong>${num(r.mg.perPP, 3)}</strong>${payOffHtml(r.payOff)}</div>
      </div>`;
    const productsCard = `
      <div class="pp-m-card section-help-card">${help('products')}
        <h3>Best products</h3>
        <div class="pp-m-list">${priced.slice(0, MOBILE_PRODUCTS).map(productRow).join('')}</div>
        ${priced.length > MOBILE_PRODUCTS ? `<details class="pp-m-more"><summary>Show all ${priced.length}</summary>
          <div class="pp-m-list">${priced.slice(MOBILE_PRODUCTS).map((r, i) => productRow(r, i + MOBILE_PRODUCTS)).join('')}</div></details>` : ''}
      </div>`;

    const companyCard = ({ c, plan }) => {
      const code = c.company.itemCode;
      return `
      <div class="pp-m-card section-help-card pp-m-company">${help('companies')}
        <div class="pp-m-row pp-m-head">${iconBox(code)}
          <div class="pp-m-grow">
            <a class="pp-m-name" href="${companyUrlFor(c.company._id)}" target="_blank" rel="noopener">${escapeHtml(c.company.name || ITEMS[code]?.name || code)}</a>
            <div class="pp-m-sub">${name(code)}</div>
          </div>
          <div class="pp-m-right"><b class="pp-m-profit">${signedMoney(plan.profitNow)}</b><span class="pp-m-sub">per day</span></div>
        </div>
        ${statusTags(c)}
        <div class="pp-m-kv">
          <div><span>Engine</span>${num(c.aePP, 0)} PP</div>
          <div><span>Employees</span>${c.statsMissing ? '–' : `${num(c.empPP, 1)} PP`}</div>
          <div><span>Wages</span>${costDay(c) > 0 ? money(costDay(c)) : '–'}</div>
          <div class="pp-m-wide"><span>Manager</span>${mobileManagerLine(c)}</div>
          <div><span>Employees pay off</span>${c.empPP ? payOffHtml(payOffLimit(model, code, employeeBonusPct(model, c))) : '–'}</div>
        </div>
        ${specialisationsHtml(c)}
        ${plan.gain != null && !plan.isBest ? `<div class="pp-m-switch">At current prices, <strong>${name(plan.best.code)}</strong>: ${signedMoney(plan.gain)}/day at unchanged output · switch costs ${money(plan.cost)}</div>` : ''}
      </div>`;
    };

    $mobile.innerHTML = `${incomeCard}${bestCard}${productsCard}
      <h3 class="pp-m-heading">Your companies</h3>
      ${plans.map(companyCard).join('')}`;
    $mobile.classList.remove('hidden');
  }

  function render() {
    const missing = model.companies.filter(c => c.statsMissing).length;
    const cause = model.statsNeedPremium
      ? 'The game only serves it to Premium API keys, and the data proxy has none right now.'
      : 'Try again in a minute.';
    setStatus(missing
      ? `Couldn't load output history for ${missing} of ${model.companies.length} companies, so their employee output, self-work and wages are missing and their profit is overstated. ${cause}`
      : '');
    renderBest();
    renderIncome();
    renderProducts();
    renderCompanies();
    renderMobile();
    [[$incomeCard, 'income'], [$bestCard, 'best'], [$prodCard, 'products'], [$compCard, 'companies']].forEach(([card, key]) => {
      card.classList.add('section-help-card');
      card.querySelector('.section-help')?.remove();
      card.insertAdjacentHTML('afterbegin', help(key));
    });
  }

  async function run() {
    const username = $username.value.trim();
    if (!username) { $username.focus(); return; }

    const params = hashParams();
    params.set('u', username);
    writeHash('products', params);

    $go.disabled = true;
    $hint.classList.add('hidden');
    [$bestCard, $incomeCard, $prodCard, $compCard, $mobile].forEach(el => el.classList.add('hidden'));
    setStatus('');
    steps.reset();
    try {
      steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
      const user = await resolveUser(username);
      enforceIrishOnly(user.country, user.username);
      steps.setStep(1, 'done', { count: `→ ${user.username}` });
      model = await loadModel(user, steps.setStep, { includeSpecialisations: true });
      overrides = {};
      sort = { key: 'totalWithoutSelf', dir: -1 };
      companySort = { key: 'company', dir: 1 };
      rememberLoadedAccount(model.username);
      steps.fadeOut(400);
      render();
    } catch (e) {
      steps.hide();
      setStatus(isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`, true);
    } finally {
      $go.disabled = false;
    }
  }

  $go.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  return {
    ITEMS, loadModel, productRows, companyPlan, incomeSummary, selfWorkProjection,
    /**
     * Called by the router (or the home shell) whenever the view becomes
     * active. Re-runs only when ?u= differs from the loaded name.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    },
  };
})();
