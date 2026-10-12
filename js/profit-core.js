/* ═══════════════════════════════════════════════════════════════════
 *  PROFIT CORE  (shared by DailyProfitTool and DashboardTool)
 *  The profit model with no DOM: loads a player's companies, staff,
 *  prices and bonuses into a `model`, and turns it into per-product rows.
 *  Each tool renders the model its own way; keep formulas here so the
 *  dashboard preview and the full tool can't drift apart.
 * ═══════════════════════════════════════════════════════════════════ */
const ProfitCore = (() => {
  // Works/day per energy point: 10%/hr recovery × 24h ÷ 10 energy-per-work = 0.24.
  // Verified against the sheet: Pintman 31×100×0.24×1.10(fid) = 818.4 PP/day.
  const WORK_FACTOR = 0.24;
  // "Profitable worker" column: the reference hire we test each product
  // against. Defined by SKILL LEVELS, resolved to values from gameConfig at
  // load (energy lvl 4 = 70, production lvl 8 = 34 → 70 × 0.24 × 34 = 571.2
  // PP/day), per R00ted's spec.
  //
  // Note this is NOT a day-1 worker: those levels cost 46 skill points
  // (10 + 36). A genuine level-0 account makes 30 × 0.24 × 10 = 72 PP/day.
  // It's a mid-game hire — comparable to a real employee at ~43 points.
  //
  // The value only scales the ₿/day figure, which isn't rendered: profit is
  // basePP × (margin per PP), so basePP factors out of both the sign (the
  // ✅/🟡/❌ verdict) and the ordering (every row shares it). Don't "correct"
  // it expecting the verdicts to move — only the margin can do that.
  const GENERIC_WORKER_SKILL_LEVELS = { energy: 4, production: 8 };
  const GENERIC_BASE_PP_FALLBACK = 571.2;   // if gameConfig is unavailable

  function genericWorkerFromConfig(gameConfig) {
    const lvl = (skill, level) => gameConfig?.skills?.[skill]?.levels?.[level]?.value;
    const energy     = lvl('energy',     GENERIC_WORKER_SKILL_LEVELS.energy);
    const production = lvl('production', GENERIC_WORKER_SKILL_LEVELS.production);
    if (typeof energy !== 'number' || typeof production !== 'number') {
      return { energy: 70, production: 34, basePP: GENERIC_BASE_PP_FALLBACK };
    }
    return { energy, production, basePP: energy * WORK_FACTOR * production };
  }

  // Target gross wage is benchmarked against the live job market rather than a frozen
  // constant (it used to be 0.121, a stale snapshot of the then-top offer).
  // workOffer.getWorkOffersPaginated returns offers already sorted by
  // wageAfterTax descending, so we only need the head of the book.
  const WAGE_RANK_FROM_TOP    = 5;    // skip outliers at the very top
  const MARKET_OFFER_PAGE     = 200;  // ~66 KB; yields ~120 attainable offers
  const MARKET_COMPANY_PROBE  = 40;   // how far down we check company.isFull

  // Highest value any player can reach in a skill (level 10 in gameConfig):
  // energy 130, production 40.
  function maxSkillValue(gameConfig, skill) {
    const levels = gameConfig?.skills?.[skill]?.levels;
    if (!levels) return null;
    const vals = Object.values(levels).map(l => l?.value).filter(v => typeof v === 'number');
    return vals.length ? Math.max(...vals) : null;
  }

  async function fetchMarketNetWage(gameConfig) {
    const maxEnergy     = maxSkillValue(gameConfig, 'energy');
    const maxProduction = maxSkillValue(gameConfig, 'production');
    const res = await pc_trpc('workOffer.getWorkOffersPaginated',
      { limit: MARKET_OFFER_PAGE }).catch(() => null);
    const offers = res?.items || [];
    if (!offers.length) return null;

    // Drop offers nobody could ever qualify for. createWorkOffer validates
    // minEnergy/minProduction as min(0) with NO upper bound, so employers
    // routinely post requirements above the level-10 caps — usually a PP/day
    // figure typed into a skill field (minProduction 450, 5050, 39852 are all
    // live right now). These dominate the head of the book: 19 of the top 20
    // by net wage, which is exactly the skew that ranking by wage would
    // otherwise inherit.
    const attainable = offers.filter(o =>
      (maxEnergy     == null || o.minEnergy     == null || o.minEnergy     <= maxEnergy) &&
      (maxProduction == null || o.minProduction == null || o.minProduction <= maxProduction));

    // A company at storage capacity can't absorb more production, so its offer
    // isn't a real alternative for a worker. isFull lives on the company, not
    // the offer, so only probe the head of the (already sorted) list rather
    // than resolving all ~3000. A lookup that fails leaves the offer in: we
    // can't prove it's full, and dropping it would understate the market.
    const probe = attainable.slice(0, MARKET_COMPANY_PROBE);
    const ids = [...new Set(probe.map(o => o.company).filter(Boolean))];
    const companies = await trpcManyValues('company.getById',
      ids.map(companyId => ({ companyId }))).catch(() => []);
    const full = new Map(ids.map((id, i) => [id, companies[i]?.isFull === true]));
    const open = probe.filter(o => !full.get(o.company));

    const net = open[WAGE_RANK_FROM_TOP - 1]?.wageAfterTax;
    return typeof net === 'number' && net > 0 ? net : null;
  }


  // The net wage every Target gross wage figure is grossed up from. wageOverride is
  // the manual "what if I posted this instead" input; null falls back to the
  // market rank-5. Null overall means the market lookup failed, which blanks
  // the Target gross wage and Profitable worker columns.
  function netWageRate(model) {
    return model.wageOverride != null ? model.wageOverride : model.marketNetWage;
  }


  // Display name + category, matching the in-game / spreadsheet labels.
  const META = {
    iron:      { name: 'Iron',        cat: 'Construction' },
    steel:     { name: 'Steel',       cat: 'Construction' },
    limestone: { name: 'Limestone',   cat: 'Construction' },
    concrete:  { name: 'Concrete',    cat: 'Construction' },
    paper:     { name: 'Paper',       cat: 'Construction' },
    wood:      { name: 'Wood',        cat: 'Construction' },
    oil:       { name: 'Oil',         cat: 'Construction' },
    petroleum: { name: 'Petroleum',   cat: 'Construction' },
    fish:      { name: 'Fish',        cat: 'Food' },
    steak:     { name: 'Steak',       cat: 'Food' },
    grain:     { name: 'Grain',       cat: 'Food' },
    cookedFish:{ name: 'Cooked Fish', cat: 'Food' },
    livestock: { name: 'Cow',         cat: 'Food' },
    bread:     { name: 'Bread',       cat: 'Food' },
    lead:      { name: 'Lead',        cat: 'War' },
    coca:      { name: 'Plant',       cat: 'War' },
    lightAmmo: { name: 'Light Ammo',  cat: 'War' },
    ammo:      { name: 'Ammo',        cat: 'War' },
    cocain:    { name: 'Pill',        cat: 'War' },
    heavyAmmo: { name: 'Heavy Ammo',  cat: 'War' },
  };
  const ICON_FILE = {
    paper:'paper.png',iron:'iron.png',steel:'steel.png',limestone:'limestone.png',concrete:'concrete.png',
    wood:'wood.png',oil:'oil.png',petroleum:'petroleum.png',fish:'fish.png',steak:'steak.png',grain:'grain.png',
    cookedFish:'cookedFish.png',livestock:'livestock.png',bread:'bread.png',lead:'lead.png',
    coca:'coca.png',lightAmmo:'lightAmmo.png',ammo:'ammo.png',cocain:'cocain.png',heavyAmmo:'heavyAmmo.png',
  };

  const pc_trpc = (ep, input) => trpc(ep, input, { retry: true });

  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;
    const res = await pc_trpc('search.searchAnything', { searchText: username });
    const ids = (res?.userIds || []).slice(0, 10);
    if (!ids.length) return null;
    const profiles = await trpcManyValues('user.getUserLite', ids.map(userId => ({ userId })));
    return profiles.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle) || null;
  }

  function skill(u, name) {
    const sk = u?.skills?.[name];
    if (!sk || typeof sk !== 'object') return 0;
    for (const k of ['total','value','level']) { const n = sk[k]; if (typeof n === 'number' && isFinite(n)) return n; }
    return 0;
  }

  // Representative price from an order book: midpoint of best bid/ask
  // (falls back to whichever side exists).
  function orderMid(d) {
    const bo = d?.buyOrders || [], so = d?.sellOrders || [];
    let bid = -Infinity, ask = Infinity;
    for (const o of bo) if (typeof o.price === 'number' && o.price > bid) bid = o.price;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    const hasBid = isFinite(bid), hasAsk = isFinite(ask);
    if (hasBid && hasAsk) return (bid + ask) / 2;
    if (hasAsk) return ask;
    if (hasBid) return bid;
    return null;
  }

  // Lowest live sell offer (best ask) — the "buy it now" price the game shows.
  function orderLowestOffer(d) {
    const so = d?.sellOrders || [];
    let ask = Infinity;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    return isFinite(ask) ? ask : null;
  }

  // Salary = wages the user RECEIVED in the last 24h. Wage transactions are
  // trades: sellerId is the worker (sold labour), buyerId the employer. So we
  // sum `money` for wage txns where sellerId === the user. (Same source as
  // the Clock-In tool.) Paginates back until older than 24h.
  async function dailySalary(userId) {
    const cutoff = Date.now() - 86400000;
    let cursor = null, pages = 0, total = 0, count = 0, older = false;
    while (pages < 6 && !older) {
      const input = { userId, transactionType: 'wage', limit: 100 };
      if (cursor) input.cursor = cursor;
      const page = await pc_trpc('transaction.getPaginatedTransactions', input).catch(() => null);
      if (!page) break;
      const items = page.items || page.data || [];
      for (const tx of items) {
        if (new Date(tx.createdAt).getTime() < cutoff) { older = true; continue; }
        if (tx.sellerId === userId) { total += (tx.money || 0); count++; }
      }
      cursor = page.nextCursor ?? null;
      pages++;
      if (!cursor || !items.length) break;
    }
    return { total, count };
  }

  // Everything the Daily Profit view needs for one player. `opts` lets a
  // caller that already holds some of the inputs skip refetching them:
  //   companyList / workersData — company.getCompanies / worker.getWorkers
  //                               results (or promises of them)
  //   fullUser                  — user.getUserById result (buddy detection)
  //   step(n, state, info)      — progress hook, makeSteps().setStep-shaped
  async function loadModel(user, opts = {}) {
    const step = opts.step || (() => {});
    // Step 2: companies + workers
    step(2, 'active', { sub: 'Fetching companies' });
    const [companyList, workersData, salaryInfo] = await Promise.all([
      opts.companyList ?? pc_trpc('company.getCompanies', { userId: user._id, perPage: 100 }),
      opts.workersData ?? pc_trpc('worker.getWorkers', { userId: user._id }).catch(() => null),
      dailySalary(user._id),
    ]);
    const companyIds = companyList?.items || [];
    step(2, 'active', { sub: 'Loading company details', count: `0/${companyIds.length}` });
    const allCompanies = (await trpcManyValues('company.getById',
      companyIds.map(companyId => ({ companyId })),
      { onProgress: (done, total) => {
        step(2, 'active', { count: `${done}/${total}` });
      } })).filter(Boolean);
    // Disabled companies (those with a `disabledAt` timestamp) produce nothing
    // and aren't worked — exclude them from every calculation.
    const companies   = allCompanies.filter(c => !c.disabledAt);
    const disabledCount = allCompanies.length - companies.length;

    const workerEntries = [];
    (workersData?.workersPerCompany || []).forEach(({ company, workers }) => {
      (workers || []).forEach(w => { if (w && w.user) workerEntries.push({ companyId: company?._id, userId: w.user, wage: w.wage, fidelity: w.fidelity }); });
    });
    const uniqueWorkerIds = [...new Set(workerEntries.map(w => w.userId).filter(id => id !== user._id))];
    const workerProfiles = {};
    const workerLites = await trpcManyValues('user.getUserLite',
      uniqueWorkerIds.map(userId => ({ userId })));
    workerLites.forEach((lite, index) => {
      if (lite) workerProfiles[uniqueWorkerIds[index]] = lite;
    });

    // Buddy detection: the owner's energy "job" is user.company. If that
    // company belongs to one of the owner's own employees, they're a buddy
    // (reciprocal hire). Buddies' wages are floored at 0.106 in Max Employee.
    let buddyId = null;
    try {
      const full = opts.fullUser || await pc_trpc('user.getUserById', { userId: user._id }).catch(() => null);
      const jobCompanyId = full?.company;
      if (jobCompanyId && !companyIds.includes(jobCompanyId)) {
        const jobCo = await pc_trpc('company.getById', { companyId: jobCompanyId }).catch(() => null);
        buddyId = jobCo?.user || jobCo?.owner || null;
      }
    } catch {}
    step(2, 'done', { count: `${companies.length} active${disabledCount ? ` · ${disabledCount} disabled` : ''}` });

    // Step 3: market + bonuses
    step(3, 'active', { sub: 'Loading market, regions & countries' });
    const [fallbackPrices, gameConfig, regionsObj, allCountriesRaw] = await Promise.all([
      pc_trpc('itemTrading.getPrices', {}).catch(() => ({})),
      pc_trpc('gameConfig.getGameConfig', {}).catch(() => null),
      pc_trpc('region.getRegionsObject', {}),
      pc_trpc('country.getAllCountries', {}),
    ]);
    const gameItems = gameConfig?.items || {};
    // Reference hire for the Profitable-worker column, plus the live market
    // wage its Target gross wage benchmark is drawn from. A market miss leaves
    // marketNetWage null, which blanks both columns rather than falling back
    // to a stale guess.
    const genericWorker = genericWorkerFromConfig(gameConfig);
    const marketNetWage = await fetchMarketNetWage(gameConfig);
    // Price from the live order book — the LOWEST OFFER (best ask), i.e. the
    // "buy it now" value the game shows — falling back to the book midpoint,
    // then to the live game's calculated price when a book is empty/thin.
    const prices = {};
    // Mission cases need a sale price, but aren't producible goods in META.
    const priceCodes = [...Object.keys(META).filter(c => gameItems[c]), 'case1'];
    step(3, 'active', { sub: 'Pricing items from the live market', count: `0/${priceCodes.length}` });
    const books = await trpcManyValues('tradingOrder.getTopOrders',
      priceCodes.map(itemCode => ({ itemCode })),
      { onProgress: (done, total) => {
        step(3, 'active', { count: `${done}/${total}` });
      } });
    books.forEach((ob, index) => {
      const code = priceCodes[index];
      const p = orderLowestOffer(ob) ?? orderMid(ob) ?? fallbackPrices?.[code];
      if (p != null) prices[code] = p;
    });
    const aeLevels = gameConfig?.upgradesConfig?.automatedEngine?.levels || {};
    const aeDailyProd = (lvl) => aeLevels[lvl]?.stats?.dailyProd || 0;
    // Moving a company or changing its production each costs concrete
    // (company.moveCost / changeItemCost — both 5). Used for the Deductions line.
    const moveCost = gameConfig?.company?.moveCost ?? gameConfig?.company?.changeItemCost ?? 5;
    // Recurring mission rewards. Daily is counted as-is; weekly and monthly
    // Daily is counted per day; Weekly's full reward is counted in the daily
    // total too (once-a-week reward you bank that day) — the weekly projection
    // then counts it ×1 rather than ×7. Both are tickable. Mission cases
    // (daily + weekly, full) flow into the Case-sales line.
    const mr = gameConfig?.mission?.reward || {};
    const missionMoney       = (mr.daily?.money  || 0);
    const missionMoneyWeekly = (mr.weekly?.money || 0);   // full weekly reward (once/week)
    const missionCasesDaily  = (mr.daily?.cases  || 0);
    const missionCasesWeekly = (mr.weekly?.cases || 0);   // full weekly cases

    const allCountries = Array.isArray(allCountriesRaw) ? allCountriesRaw : (allCountriesRaw?.items || []);
    step(3, 'active', { sub: 'Loading country bonuses', count: `0/${allCountries.length}` });
    const countryById = {};
    const fullCountries = await trpcManyValues('country.getCountryById',
      allCountries.map(c => ({ countryId: c._id })),
      { onProgress: (done, total) => {
        step(3, 'active', { count: `${done}/${total}` });
      } });
    fullCountries.forEach((full, index) => {
      if (full) countryById[allCountries[index]._id] = full;
    });
    await enrichCountriesWithIndustrialism(countryById);
    step(3, 'done', { count: `${Object.keys(countryById).length} countries` });

    // Best region bonus per item (across all regions) → "max" framing.
    const regionsByCountry = {};
    Object.values(regionsObj).forEach(r => { if (r?.country) (regionsByCountry[r.country] = regionsByCountry[r.country] || []).push(r); });
    const bestBonus = {};
    for (const code in META) {
      let best = { total: 0, region: null, country: null };
      for (const cid in countryById) {
        const country = countryById[cid];
        for (const region of (regionsByCountry[cid] || [])) {
          const b = computeProductionBonus(country, region, code);
          if (b && b.total > best.total) best = b;
        }
      }
      bestBonus[code] = best;
    }

    // Per-company: region bonus, automated-engine PP/day (from upgrade
    // config — NOT the `production` field, which is the uncollected
    // buffer), plus workers' manual production and wage cost.
    workerProfiles[user._id] = user;   // self counts as a worker where they work
    // Profit per production point for a company's item (after raw materials &
    // region bonus, before wages). Used for self-work targeting and for each
    // employee's profitability. null when the item/recipe isn't priced.
    const companyNetPP = (c) => {
      const it = gameItems[c.itemCode]; const pp = it?.productionPoints || 0;
      const sale = prices[c.itemCode]; if (!pp || sale == null) return null;
      let rc = 0; const needs = it.productionNeeds || {};
      for (const k in needs) { if (prices[k] == null) return null; rc += needs[k] * prices[k]; }
      const bonus = c._bonus ? c._bonus.total : 0;
      return (sale - rc) * (1 + bonus / 100) / pp;
    };
    const companyById = {};
    companies.forEach(c => {
      companyById[c._id] = c;
      const region = regionsObj[c.region];
      const country = region ? countryById[region.country] : null;
      c._region = region;
      c._bonus = computeProductionBonus(country, region, c.itemCode);
      c._netPP = companyNetPP(c);                 // bonus-applied (self-work target + employee panel)
      c._dailyAE = aeDailyProd(c.activeUpgradeLevels?.automatedEngine);   // raw AE (shown in Companies table)
      c._aeBonus = c._dailyAE * (1 + (c._bonus ? c._bonus.total : 0) / 100); // AE with bonus (#3) — throughput
      c._workersManual = 0;
      c._wageCost = 0;
    });
    // Hired employees only — worker.getWorkers never includes the owner.
    // Each produces production × energy × WORK_FACTOR × (1 + fidelity/100),
    // and is paid a wage on the pre-fidelity base. Collected for the
    // profitability panel: an employee makes you money when their output's
    // value (netPP × outputPP) beats their wage (wage × basePP).
    const employees = [];
    workerEntries.forEach(w => {
      const c = companyById[w.companyId]; if (!c) return;
      const prof = workerProfiles[w.userId]; if (!prof) return;
      const prod = skill(prof, 'production');
      const energy = skill(prof, 'energy');
      const fid  = typeof w.fidelity === 'number' ? w.fidelity : 0;
      const wage = typeof w.wage === 'number' ? w.wage : 0;
      const bonus = c._bonus ? c._bonus.total : 0;
      const basePP   = prod * energy * WORK_FACTOR;         // pre-fidelity/bonus; wages paid on this
      // Output PP carries fidelity + region bonus ADDITIVELY (sheet model).
      c._workersManual += basePP * (1 + (fid + bonus) / 100);
      c._wageCost += basePP * wage;
      employees.push({ name: prof.username || '—', company: c.name || META[c.itemCode]?.name || c.itemCode,
                       item: c.itemCode, prod, bonus: c._bonus ? c._bonus.total : 0,
                       basePP, netPP: c._netPP, wage, fidelity: fid,
                       buddy: (w.userId === buddyId) });
    });

    // The owner ALSO self-works in their OWN companies via the entrepreneurship
    // pool — a separate stream from their energy "job" (which may be in someone
    // else's company). worker.getWorkers never lists the owner, so add it here:
    //   production × entrepreneurship × WORK_FACTOR   (no fidelity, no wage).
    // It's one self-work stream; attribute it to the owner's most profitable
    // company (the rational target) so the profit column reflects it.
    // Snapshot hired-only staff so self-work can be re-assigned later (picker).
    companies.forEach(c => { c._workersHired = c._workersManual; });
    const selfPP = skill(user, 'production') * skill(user, 'entrepreneurship') * WORK_FACTOR;
    // Default self-work target: the owner's most profitable company.
    let selfWorkCompany = null;
    { let bestv = -Infinity;
      for (const c of companies) { const v = (c._netPP == null ? -Infinity : c._netPP); if (v > bestv) { bestv = v; selfWorkCompany = c; } } }
    let selfContribution = 0;
    if (selfWorkCompany && selfPP > 0) {
      const b = selfWorkCompany._bonus ? selfWorkCompany._bonus.total : 0;
      selfContribution = selfPP * (1 + b / 100);   // self: no fidelity, + region bonus
      selfWorkCompany._workersManual += selfContribution;
      selfWorkCompany._selfWork = true;
    }
    // Daily throughput per company carries the bonus: AE-with-bonus + bonused staff.
    companies.forEach(c => { c._dailyPP = c._aeBonus + c._workersManual; });

    const enginesPP = Math.round(companies.reduce((s, c) => s + c._aeBonus, 0));
    const staffPP   = Math.round(companies.reduce((s, c) => s + c._workersManual, 0));

    // Salary, modeled over a full 24h rather than the lumpy actual sum:
    // daily work capacity (energy × WORK_FACTOR works/day) × the average NET
    // wage per work payment (taken straight from recent wage transactions, so
    // tax is already baked in and we needn't reconcile the wage rate).
    const salaryWorksPerDay = skill(user, 'energy') * WORK_FACTOR;
    const salaryAvgPerWork  = salaryInfo.count ? salaryInfo.total / salaryInfo.count : 0;
    const salaryModeled     = salaryWorksPerDay * salaryAvgPerWork;

    return { user, prices, gameItems, bestBonus, companies, disabledCount, employees,
             countryById, regionsObj, regionsByCountry, workerEntries,
              missionMoney, missionMoneyWeekly,
              missionCasesDaily, missionCasesWeekly,
              missionsDone: { daily: true, weekly: false }, // opt in on the day weekly rewards are claimed
              casesManual: null,   // manual "cases sold today" override; null = use modeled
              movesManual: null,   // manual count of company moves / production changes
              moveCost, concretePrice: (prices['concrete'] ?? null),
              casePrice: (prices['case1'] ?? null),
              salaryDaily: salaryModeled, salaryActual: salaryInfo.total, salaryCount: salaryInfo.count,
              salaryWorksPerDay, salaryAvgPerWork,
              enginesPP, staffPP, priceOverrides: {},
              genericWorker, marketNetWage,
              wageOverride: null,   // manual net-wage override; null = use market
              selfPP: Math.round(selfContribution),
              selfWorkItem: selfWorkCompany ? (META[selfWorkCompany.itemCode]?.name || selfWorkCompany.itemCode) : null,
              selfPPbase: selfPP,   // self base PP (no fidelity/bonus); for Max Employee + picker
              selfWorkCompanyId: selfWorkCompany ? selfWorkCompany._id : null,
              realEnginesPP: enginesPP, realStaffPP: staffPP,   // baseline for the what-if scale
              totalCompanyAE: companies.reduce((s, c) => s + (c._dailyAE || 0), 0),  // raw AE (Max Company)
              assumptions: { enginesPP, staffPP } };   // editable; throughput = sum
  }

  function price(model, code) {
    const o = model.priceOverrides[code];
    if (o != null && o !== '' && isFinite(+o)) return +o;
    return model.prices[code] != null ? model.prices[code] : null;
  }
  function rawCostOf(model, code) {
    const needs = model.gameItems[code]?.productionNeeds;
    if (!needs) return 0;
    let cost = 0;
    for (const r in needs) { const p = price(model, r); if (p == null) return null; cost += needs[r] * p; }
    return cost;
  }
  // Net profit per production point for an item at a given bonus %.
  function netPerPP(model, code, bonusPct) {
    const it = model.gameItems[code];
    const pp = it?.productionPoints || 0;
    if (!pp) return null;
    const sale = price(model, code);
    if (sale == null) return null;
    const rc = rawCostOf(model, code);
    if (rc == null) return null;
    return (sale - rc) * (1 + bonusPct / 100) / pp;
  }

  function throughputScales(model) {
    const eng = model.realEnginesPP > 0 ? (model.assumptions.enginesPP || 0) / model.realEnginesPP : 0;
    const stf = model.realStaffPP   > 0 ? (model.assumptions.staffPP   || 0) / model.realStaffPP   : 0;
    return { eng, stf };
  }

  // A generic hire's value-add for this product: gross PP they'd generate at
  // the lowest viable wage, converted to items made, valued at the product's
  // net profit/item, minus what they'd cost to hire.
  // Fidelity is a free rider on top of that: it grows 1%/day (day 1 → 1%,
  // day 5 → 5%) and lifts OUTPUT only — the wage is still paid on the
  // pre-fidelity base PP (same model as the Employees panel), so day 5 is
  // strictly more profitable than day 1 for the same hire.
  const FIDELITY_DAY1_PCT = 1;
  const FIDELITY_DAY5_PCT = 5;
  function workerProfitability(model, code, it, bonusPct, lowWage) {
    const ppPerItem = it?.productionPoints || 0;
    if (!ppPerItem || lowWage == null) return { day1: null, day5: null };
    const basePP = model.genericWorker?.basePP ?? GENERIC_BASE_PP_FALLBACK;
    const sale = price(model, code);
    const rc = rawCostOf(model, code);
    if (sale == null || rc == null) return { day1: null, day5: null };
    const netProfitPerItem = sale - rc;
    // basePP is pre-fidelity and pre-bonus (energy × WORK_FACTOR ×
    // production), so it is what the wage is charged on — same convention as
    // a real employee's basePP.
    const wageCost = basePP * lowWage;   // fidelity doesn't change what you pay
    // Output carries fidelity + region bonus additively, matching empAdjPP.
    const outputPP = (fidPct) => basePP * (1 + (fidPct + (bonusPct || 0)) / 100);
    const profitAt = (fidPct) => (outputPP(fidPct) / ppPerItem) * netProfitPerItem - wageCost;
    return { day1: profitAt(FIDELITY_DAY1_PCT), day5: profitAt(FIDELITY_DAY5_PCT) };
  }

  function buildRows(model) {
    const rows = [];
    const { eng: engScale, stf: stfScale } = throughputScales(model);
    for (const code in META) {
      const it = model.gameItems[code];
      if (!it) continue;
      const bb = model.bestBonus[code] || { total: 0 };
      const npp = netPerPP(model, code, 0);            // Net/PP = net profit ÷ PP (bonus-free)
      const bonusMult = 1 + (bb.total || 0) / 100;
      const tax = bb.tax ?? 0;
      // Lowest viable wage: gross the market net rate up for this country's
      // income tax, so the worker still nets what they could earn elsewhere.
      // null when the market lookup failed — the column then renders as "–".
      const rate = netWageRate(model);
      const lowWage = rate == null ? null : rate / (1 - tax / 100);

      // Actual = bonus-free Net/PP × the company's bonused throughput (AE-with-bonus
      // + bonused staff) − wages. Engine & staff parts scale with the what-if fields.
      let actual = 0, makesIt = false;
      for (const c of model.companies) {
        if (c.itemCode !== code) continue;
        makesIt = true;
        const effPP   = (c._aeBonus || 0) * engScale + (c._workersManual || 0) * stfScale;
        const effWage = (c._wageCost || 0) * stfScale;
        if (npp != null) actual += npp * effPP - effWage;
      }

      // Max Company: all company AE → this product at its bonus.
      const maxCompany = (npp != null) ? npp * model.totalCompanyAE * bonusMult * engScale : null;

      // Max Employee: gross = Σ(basePP × (1 + fid% + bonus%)) × Net/PP;
      // wage cost = Σ(basePP × effWage), effWage = 0 for self, 0.106 for a buddy,
      // else max(their wage, lowest viable wage). Scales with the staff what-if.
      // Fidelity and the region bonus stack ADDITIVELY, not multiplicatively —
      // the game's own hire preview computes 1 + (bonus% + fidelity%)/100, and
      // wages are paid on the raw base PP (verified against wage transactions:
      // money/quantity is exactly the wage rate, and quantity tracks the
      // worker's production skill, un-lifted by fidelity or bonus).
      let maxEmployee = null;
      if (npp != null) {
        let grossPP = (model.selfPPbase || 0) * bonusMult;   // self (Me): fidelity 0
        let wageCost = 0;                                     // self pays no wage
        for (const e of model.employees) {
          grossPP += e.basePP * (1 + (e.fidelity + (bb.total || 0)) / 100);
          wageCost += e.basePP * (e.buddy ? 0.106 : Math.max(e.wage, lowWage));
        }
        maxEmployee = (grossPP * npp - wageCost) * stfScale;
      }
      // Total Max = company + employee, but a negative employee contribution is
      // floored at 0 (don't let unprofitable employees drag the company ceiling).
      const totalMax = (maxCompany != null && maxEmployee != null) ? maxCompany + Math.max(maxEmployee, 0) : null;
      const empAssigned = model.employees.filter(e => e.item === code).length;
      const { day1: employeeProfitDay1, day5: employeeProfitDay5 } = workerProfitability(model, code, it, bb.total, lowWage);

      rows.push({ code, name: META[code].name, cat: META[code].cat, type: it.type,
                  netPP: npp, bonus: bb.total, region: bb.region, country: bb.country,
                  tax: bb.tax, deposit: bb.depositInfo,
                  maxCompany, maxEmployee, totalMax, empAssigned, lowWage,
                  employeeProfitDay1, employeeProfitDay5,
                  makesIt, actual: makesIt ? actual : null });
    }
    return rows;
  }

  return {
    WAGE_RANK_FROM_TOP, FIDELITY_DAY1_PCT, FIDELITY_DAY5_PCT, META, ICON_FILE,
    skill, resolveUsername, loadModel,
    price, rawCostOf, netPerPP, netWageRate, throughputScales, buildRows,
  };
})();
