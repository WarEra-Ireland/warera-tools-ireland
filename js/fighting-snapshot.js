/*
 *  FIGHTING INPUT SNAPSHOT  (the fighting build optimiser's only fetcher)
 *  load(username) fetches the profile, game config, country taxes, the
 *  player's companies with their employees and managers, and market
 *  prices; buildSnapshot(raw) turns those raw responses into
 *  one frozen snapshot with fetch timestamps. fighting-core.js evaluates
 *  builds against the snapshot and never fetches during a run.
 *
 *  Currently equipped gear is no baseline for the search: it turns over
 *  often and isn't what a build should buy. The profile keeps it only so
 *  Your build can start from what the player fights with today.
 */
const FightingSnapshot = (() => {
  const inNode = typeof module !== 'undefined' && module.exports;
  // Employee output and the manager market are Employee Training's rules.
  const Employees = inNode ? require('./employee-core.js') : EmployeeCore;
  const Managers = inNode ? require('./manager-core.js') : ManagerCore;

  const DEFAULT_SETTINGS = {
    // Shared battle conditions, applied alike to every candidate.
    battleBonus: 0.60,
    rankDamagePct: null,     // military rank damage %; null = the profile's
    bountyPer1000: 0,        // coins per 1,000 damage
    muHelpHealthPerDay: 0,   // the player's own estimate; adds health only above zero
    incomeToggles: { production: true, employees: true, manager: true, bounty: true, cases: true, scrap: true },
    // A manager job's pay per Management point an hour; null = the market average.
    managerRate: null,
    freshnessHours: 24,      // market prices older than this are stale
    // Search: role-pick targets (coins a day), pills, budget and locks.
    savingsTarget: 100,
    lossAllowance: 200,
    includeStale: false,     // stale-priced builds stay out of role picks
    pillMode: 'both',        // 'both' | 'unpilled' | 'pilled'
    sameGearBothPhases: false,
    equipmentBudget: null,   // optional soft target for the full-loadout price
    skillLocks: {},          // { [skill]: final effective level }
  };
  // Battle loot valued at market as estimated sale proceeds.
  const LOOT_CODES = ['case1', 'case2', 'scraps'];
  const TRADE_SAMPLES = 100;   // recent sales per equipment code, as the Gear Softcap tool reads

  const iso = (t) => t == null ? null : new Date(t).toISOString();
  const listOf = (data) => Array.isArray(data) ? data : (data?.items || []);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.values(o).forEach(deepFreeze);
    }
    return o;
  }

  const isEquipment = (it) => it.type === 'weapon' || it.type === 'equipment';
  const isFood = (it) => typeof it.flatStats?.healthRegenPercent === 'number';
  const isAmmo = (it) => it.usage === 'ammo';
  const isPill = (it) => typeof it.flatStats?.buffDurationHours === 'number';

  // The parts of gameConfig the core reads: skill value tables (with any
  // soft cap), regeneration, health cost, and equipment/consumable effects.
  function configOf(g) {
    const skills = {};
    for (const [name, s] of Object.entries(g.skills || {})) {
      const levels = Object.entries(s.levels || {}).sort((a, b) => +a[0] - +b[0]).map(([, l]) => l);
      skills[name] = { values: levels.map(l => l.value), unlockAtLevel: levels.map(l => l.unlockAtLevel ?? 1) };
      if (typeof s.softCap === 'number') skills[name].softCap = s.softCap;
    }
    const items = {};
    for (const [code, it] of Object.entries(g.items || {})) {
      if (isEquipment(it)) {
        items[code] = { code, slot: it.usage, rarity: it.rarity };
        // The range each stat rolls in, for entering a roll by hand.
        if (it.dynamicStats) items[code].ranges = Object.fromEntries(Object.entries(it.dynamicStats).map(([k, [lo, hi]]) => [k, [lo, hi]]));
        // Every weapon but the knife needs ammunition to attack, and any
        // ammunition fits any gun (your confirmation).
        if (it.type === 'weapon') items[code].usesAmmo = code !== 'knife';
      } else if (isFood(it)) {
        items[code] = { code, healthRegenPercent: it.flatStats.healthRegenPercent };
      } else if (isPill(it)) {
        items[code] = { code, percentAttack: it.flatStats.percentAttack || 0,
                        buffHours: it.flatStats.buffDurationHours, debuffHours: it.flatStats.debuffDurationHours ?? 0 };
      } else if (isAmmo(it)) {
        items[code] = { code, percentAttack: it.flatStats?.percentAttack || 0 };
      }
    }
    // Every item's rarity, consumables and loot included, for the page's tiles.
    const rarities = Object.fromEntries(Object.entries(g.items || {}).filter(([, it]) => it.rarity).map(([code, it]) => [code, it.rarity]));
    return { regenDividedBy: g.user?.regenDividedBy, healthCost: g.battle?.healthCost,
             energyCostPerAction: g.user?.energyCostPerAction ?? null,
             managerJobLevel: g.user?.featureUnlockLevels?.managerJob ?? null,
             prestigeSkillBonusLevels: g.user?.prestige?.skillBonusLevels ?? 1, skills, items, rarities,
             upgradesConfig: { automatedEngine: g.upgradesConfig?.automatedEngine || { levels: {} } } };
  }

  // The equipped loadout as a strategy's: { slot: { code, stats } } and
  // the ammunition, or null when it couldn't be fetched.
  function equippedOf(data) {
    if (!data || typeof data !== 'object') return null;
    const gear = (e) => e?.code ? { code: e.code, stats: Object.fromEntries(Object.entries(e.skills || {})
      .filter(([, v]) => typeof v === 'number' && v > 0)) } : null;
    return {
      equipment: Object.fromEntries(['weapon', 'helmet', 'chest', 'gloves', 'pants', 'boots'].map(slot => [slot, gear(data[slot])])),
      ammo: typeof data.ammo === 'string' ? data.ammo : null,
    };
  }

  function profileOf(u, skillNames, equipped) {
    const perSkill = (field) => Object.fromEntries(skillNames.map(k => [k, u.skills?.[k]?.[field] || 0]));
    return {
      userId: u._id, username: u.username, countryId: u.country ?? null,
      level: u.leveling?.level ?? null,
      militaryRank: u.militaryRank ?? null,
      rankDamagePct: u.skills?.attack?.militaryRankPercent || 0,
      // The real spendable total, not level × 4.
      ordinarySkillBudget: u.leveling?.totalSkillPoints ?? 0,
      prestigeBoosts: perSkill('prestige'),
      // Flat skill bonuses from the country's strategic resources, which
      // the game adds to a skill's value whatever its level.
      strategicBoosts: perSkill('strategic'),
      currentSkills: perSkill('level'),
      equipped: equippedOf(equipped?.data),
    };
  }

  const AVERAGE = 'market average';
  // Order-book prices are the untaxed ones that aren't averages.
  const fromBook = (p) => p.taxBasis === 'untaxed' && p.source !== AVERAGE;
  // A price refresh re-fetches both: averages are priced from the books too,
  // falling back to the game's price when a book is empty.
  const refreshable = (p) => fromBook(p) || p.source === AVERAGE;

  // Lowest ask, else the highest bid — the same rule as Daily Profit.
  // Trading orders carry no market tax: a buy of 1,000 light ammo at 0.202
  // took exactly 202 from the balance (tested 2026-10-19).
  const orderPrices = (orders) => (orders || []).map(o => o?.price).filter(p => typeof p === 'number');
  function orderPrice(d) {
    const asks = orderPrices(d?.sellOrders), bids = orderPrices(d?.buyOrders);
    if (asks.length) return Math.min(...asks);
    return bids.length ? Math.max(...bids) : null;
  }
  const bookPrice = (book) => {
    const value = orderPrice(book?.data);
    return value == null ? null
      : { value, fetchedAt: iso(book.fetchedAt), tradeDate: null, taxBasis: 'untaxed', source: 'market' };
  };
  function pricesOf(orderBooks) {
    const prices = {};
    for (const [code, book] of Object.entries(orderBooks || {})) {
      const price = bookPrice(book);
      if (price) prices[code] = price;
    }
    return prices;
  }

  // Priced stat targets: recent full-condition single sales grouped by
  // their exact roll, priced at the median so one odd sale can't move it.
  // Sale money is the listed price, before the buyer's market tax: the
  // game adds the tax on top for the buyer and the seller receives the price.
  function equipmentOf(equipmentTrades) {
    const out = {};
    for (const [code, page] of Object.entries(equipmentTrades || {})) out[code] = targetsOf(page);
    return out;
  }
  function targetsOf(page) {
    const groups = new Map();
    for (const tx of listOf(page?.data)) {
      const item = tx?.item;
      if (!item?.skills || tx.quantity !== 1 || !(tx.money > 0)) continue;
      if (!(item.maxState > 0) || item.state !== item.maxState) continue;
      const stats = Object.fromEntries(Object.entries(item.skills).sort(([a], [b]) => a.localeCompare(b)));
      const key = JSON.stringify([stats, item.maxState]);
      if (!groups.has(key)) groups.set(key, { stats, maxState: item.maxState, sales: [] });
      groups.get(key).sales.push(tx);
    }
    return [...groups.values()].map(g => ({
      stats: g.stats, maxState: g.maxState, price: median(g.sales.map(t => t.money)), samples: g.sales.length,
      tradeDate: iso(g.sales.reduce((m, t) => (t.createdAt > m ? t.createdAt : m), '')),
      fetchedAt: iso(page.fetchedAt), taxBasis: 'pre-buyer-tax', source: 'market',
    })).sort((a, b) => a.price - b.price);
  }

  const finite = (x) => typeof x === 'number' && Number.isFinite(x);

  // An employee as the build's Management can change them: output an hour
  // before bonuses, the bonus without the owner's Management or the
  // manager (happiness, tool, specialization, traits, events, core
  // region), and the hourly wage. Output an hour is Production ÷ 4 ×
  // (1 + bonus), Production being hired, trained and trait points together
  // (Employee Training's model; the API's estimate matches it).
  function employeeOf(e) {
    const contributions = e?.productionBonus?.contributions || [];
    const owned = contributions.filter(c => c.source === 'management' || c.source === 'manager')
      .reduce((sum, c) => sum + (c.percent || 0), 0);
    const total = e?.productionBonus?.total;
    const production = e?.breakdown?.production?.total;
    const baseOutput = finite(production) ? production / Employees.CFG.outputDivisor
      : finite(e?.estimate?.production) && finite(total) ? e.estimate.production / (1 + total / 100) : null;
    return { id: e?._id ?? null, name: e?.name ?? null, baseOutput,
             otherBonusPct: finite(total) ? total - owned : null, wage: finite(e?.wage) ? e.wage : null };
  }

  // A hired manager: the bonus they give each employee and their pay. An
  // inactive manager (offline for days) gives neither (manager-core.js).
  function managerOf(contract) {
    if (!contract?._id && !contract?.user) return null;
    return { bonusPct: finite(contract.productionBonusPercent) ? contract.productionBonusPercent : 0,
             hourlyWage: finite(contract.hourlyWage) ? contract.hourlyWage : 0, inactive: !!contract.isInactive };
  }

  // Products and their inputs at Employee Training's price, the average of
  // their latest trades (EmployeeCore.tradePrice), as of each fetch.
  function productPricesOf(trades) {
    const out = {};
    for (const [code, page] of Object.entries(trades || {})) {
      const list = listOf(page?.data);
      const value = Employees.tradePrice(list, Date.parse(page.fetchedAt));
      if (value == null) continue;
      out[code] = { value, fetchedAt: iso(page.fetchedAt),
        tradeDate: iso(list.reduce((m, t) => (t?.createdAt > m ? t.createdAt : m), '') || null),
        taxBasis: 'untaxed', source: 'recent trades' };
    }
    return out;
  }

  // Company income inputs: what every item needs to make and sells for
  // (for margins), each of the player's companies as it runs today, and
  // what a manager job pays a point. A company whose roster didn't load
  // has employees null.
  function productionOf(raw, gameConfig) {
    if (!raw.companies?.data) return null;
    const items = {};
    for (const [code, it] of Object.entries(gameConfig.items || {})) {
      if (it?.productionPoints > 0) items[code] = { productionPoints: it.productionPoints, productionNeeds: { ...(it.productionNeeds || {}) } };
    }
    const companies = listOf(raw.companies.data).filter(r => r?.company?._id).map(({ company: c, employees, manager }) => ({
      id: c._id, name: c.name || null, item: c.itemCode || null, disabled: !!c.disabledAt,
      engineLevel: c.activeUpgradeLevels?.automatedEngine ?? 0,
      // Break Room level n holds n employees; a company without it has level 1.
      breakRoom: c.activeUpgradeLevels?.breakRoom ?? 1,
      employees: Array.isArray(employees) ? employees.filter(e => e && !e.leftAt).map(employeeOf) : null,
      manager: managerOf(manager),
    }));
    return {
      fetchedAt: iso(raw.companies.fetchedAt), items, prices: productPricesOf(raw.productTrades), companies,
      managerRate: Managers.rateBand(raw.managerWageStats?.data, gameConfig.skills?.management?.levels)?.average ?? null,
    };
  }

  /**
   * raw: { profile, gameConfig, countries, equipped?, companies?, managerWageStats?,
   *        gamePrices?, orderBooks: { [code]: r }, productTrades?: { [code]: r },
   *        equipmentTrades: { [code]: r } }
   * where each r is { data, fetchedAt } (equipped and the company inputs may
   * be null), companies.data is [{ company, employees, manager }] per owned
   * company (company.getById, employee.getCompanyEmployees and
   * manager.getByCompanyId), managerWageStats.data is
   * managerOffer.getWageStats, gamePrices.data itemTrading.getPrices and
   * productTrades a product's latest trades (transaction.getPaginatedTransactions).
   */
  function buildSnapshot(raw, settings = {}) {
    const config = configOf(raw.gameConfig.data);
    const countries = {};
    for (const c of listOf(raw.countries.data)) {
      const t = c.taxes || {};
      countries[c._id] = { name: c.name, taxes: { income: t.income ?? 0, market: t.market ?? 0, manager: t.manager ?? 0 } };
    }
    // The game's price averages fill gaps in the order books. They sit
    // between the best bid and ask, so they're untaxed order-book prices too.
    const prices = pricesOf(raw.orderBooks);
    for (const [code, value] of Object.entries(raw.gamePrices?.data || {})) {
      if (!prices[code] && typeof value === 'number') {
        prices[code] = { value, fetchedAt: iso(raw.gamePrices.fetchedAt), tradeDate: null, taxBasis: 'untaxed', source: AVERAGE };
      }
    }
    const fetchTimes = [raw.profile, raw.gameConfig, raw.countries, raw.companies, raw.managerWageStats, raw.gamePrices,
      ...Object.values(raw.orderBooks || {}), ...Object.values(raw.productTrades || {}), ...Object.values(raw.equipmentTrades || {})]
      .map(r => r?.fetchedAt).filter(Boolean).map(iso).sort();
    return deepFreeze({
      // The clock prices are judged fresh or stale against.
      asOf: iso(raw.asOf) ?? fetchTimes[fetchTimes.length - 1] ?? null,
      fetchedAt: {
        profile: iso(raw.profile.fetchedAt), gameConfig: iso(raw.gameConfig.fetchedAt),
        countries: iso(raw.countries.fetchedAt), companies: iso(raw.companies?.fetchedAt),
      },
      profile: profileOf(raw.profile.data, Object.keys(config.skills), raw.equipped),
      config,
      countries,
      prices,
      equipment: equipmentOf(raw.equipmentTrades),
      production: productionOf(raw, raw.gameConfig.data),
      settings: mergeSettings(DEFAULT_SETTINGS, settings),
    });
  }

  const mergeSettings = (base, patch) => ({
    ...base, ...patch,
    incomeToggles: { ...base.incomeToggles, ...(patch.incomeToggles || {}) },
  });

  // The same frozen inputs under changed settings (toggles, locks…).
  function withSettings(snapshot, patch) {
    return Object.freeze({ ...snapshot, settings: deepFreeze(mergeSettings(snapshot.settings, patch)) });
  }

  // Fold re-fetched order books, game prices and equipment sales into a
  // snapshot at time asOf. A code that didn't come back keeps its old price,
  // flagged with the failed refresh so it reads as stale.
  function applyRefresh(snapshot, raw, asOf) {
    const at = iso(asOf);
    const prices = {};
    for (const [code, old] of Object.entries(snapshot.prices)) {
      if (!refreshable(old)) { prices[code] = old; continue; }
      const book = bookPrice(raw.orderBooks?.[code]);
      const game = old.source === AVERAGE ? raw.gamePrices?.data?.[code] : null;
      const fresh = old.source === AVERAGE
        ? book ? { ...book, source: AVERAGE } : game != null ? { ...old, value: game, fetchedAt: iso(raw.gamePrices.fetchedAt) } : null
        : book;
      prices[code] = fresh || { ...old, refreshFailedAt: at };
    }
    for (const [code, book] of Object.entries(raw.orderBooks || {})) {
      if (!prices[code]) { const p = bookPrice(book); if (p) prices[code] = p; }
    }
    const equipment = {};
    for (const [code, old] of Object.entries(snapshot.equipment)) {
      const page = raw.equipmentTrades?.[code];
      // A roll missing from the new sales sample keeps its old price, stale.
      const fresh = page ? targetsOf(page) : [];
      const key = (t) => JSON.stringify([t.stats, t.maxState]);
      const kept = old.filter(t => !fresh.some(f => key(f) === key(t))).map(t => ({ ...t, refreshFailedAt: at }));
      equipment[code] = [...fresh, ...kept].sort((a, b) => a.price - b.price);
    }
    return deepFreeze({ ...snapshot, asOf: at, prices, equipment });
  }

  const fs_trpc = (ep, input) => trpc(ep, input, { retry: true });
  const stamped = (data) => ({ data, fetchedAt: new Date().toISOString() });
  // { [key]: stamped value } for a batch's keys and results, skipping failures.
  const stampedBy = (keys, values) => Object.fromEntries(keys
    .map((key, i) => [key, values[i]]).filter(([, v]) => v != null).map(([key, v]) => [key, stamped(v)]));

  // Fetch everything a run needs for a resolved player (resolveUsername's
  // result), then freeze it. step(n, state, info) drives a makeSteps()
  // panel: 2 profile & config, 3 companies, employees & managers, 4 market
  // prices (consumables and loot), product and equipment sales.
  async function load(player, { step = () => {} } = {}) {
    step(2, 'active', { sub: 'Profile, equipped gear, game config and country taxes' });
    const [profile, gameConfig, countries, equipped] = await Promise.all([
      fs_trpc('user.getUserById', { userId: player._id }).then(stamped),
      fs_trpc('gameConfig.getGameConfig', {}).then(stamped),
      fs_trpc('country.getAllCountries', {}).then(stamped),
      fs_trpc('inventory.fetchCurrentEquipment', { userId: player._id }).then(stamped).catch(() => null),
    ]);
    step(2, 'done');

    step(3, 'active', { sub: 'Your companies, their employees and managers, and manager pay' });
    const list = await fs_trpc('company.getCompanies', { userId: player._id, perPage: 100 }).catch(() => null);
    const ids = list ? listOf(list) : null;
    let companies = null;
    if (ids) {
      const byCompany = ids.map(companyId => ({ companyId }));
      const [records, rosters, managers] = await Promise.all([
        trpcManyValues('company.getById', byCompany),
        trpcManyValues('employee.getCompanyEmployees', byCompany),
        trpcManyValues('manager.getByCompanyId', byCompany),
      ]);
      // A company that didn't load at all is left out; a missing roster
      // leaves its employees unknown.
      companies = stamped(records.map((company, i) => company && { company, employees: rosters[i], manager: managers[i] }).filter(Boolean));
    }
    const managerWageStats = await fs_trpc('managerOffer.getWageStats', {}).then(stamped).catch(() => null);
    step(3, 'done', { count: companies ? `${companies.data.length} companies` : 'unavailable' });

    const items = Object.entries(gameConfig.data?.items || {});
    const orderBookCodes = items.filter(([code, it]) => isFood(it) || isAmmo(it) || isPill(it) || LOOT_CODES.includes(code)).map(([code]) => code);
    const productCodes = items.filter(([, it]) => it.productionPoints > 0).map(([code]) => code);
    const gear = items.filter(([, it]) => isEquipment(it)).map(([code]) => code);
    step(4, 'active', { sub: 'Consumable and loot order books, recent product and equipment sales' });
    const [books, sales, gamePrices, trades] = await Promise.all([
      trpcManyValues('tradingOrder.getTopOrders', orderBookCodes.map(itemCode => ({ itemCode }))),
      trpcManyValues('transaction.getPaginatedTransactions',
        productCodes.map(itemCode => ({ transactionType: 'trading', itemCode, limit: Employees.PRICE_TRADES.sample }))),
      fs_trpc('itemTrading.getPrices', {}).then(stamped).catch(() => null),
      trpcManyValues('transaction.getPaginatedTransactions',
        gear.map(itemCode => ({ transactionType: 'itemMarket', itemCode, limit: TRADE_SAMPLES }))),
    ]);
    step(4, 'done', { count: `${new Set([...orderBookCodes, ...productCodes, ...gear]).size} items` });

    return buildSnapshot({
      profile, gameConfig, countries, equipped, companies, managerWageStats, gamePrices,
      orderBooks: stampedBy(orderBookCodes, books),
      productTrades: stampedBy(productCodes, sales),
      equipmentTrades: stampedBy(gear, trades),
    });
  }

  // Re-fetch the market prices of a loaded snapshot: the order books behind
  // its untaxed prices and averages, the game's prices for empty books, and
  // its equipment sales. Nothing else changes; failures keep the old price,
  // flagged stale.
  async function refreshPrices(snapshot) {
    const bookCodes = Object.entries(snapshot.prices).filter(([, p]) => refreshable(p)).map(([c]) => c);
    const gear = Object.keys(snapshot.equipment);
    const [books, gamePrices, trades] = await Promise.all([
      trpcManyValues('tradingOrder.getTopOrders', bookCodes.map(itemCode => ({ itemCode }))),
      fs_trpc('itemTrading.getPrices', {}).then(stamped).catch(() => null),
      trpcManyValues('transaction.getPaginatedTransactions',
        gear.map(itemCode => ({ transactionType: 'itemMarket', itemCode, limit: TRADE_SAMPLES }))),
    ]);
    return applyRefresh(snapshot, { orderBooks: stampedBy(bookCodes, books), gamePrices, equipmentTrades: stampedBy(gear, trades) },
      new Date().toISOString());
  }

  return { buildSnapshot, withSettings, applyRefresh, load, refreshPrices };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingSnapshot;
