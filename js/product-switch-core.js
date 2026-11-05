/* Product switching: a company re-tooled onto another good, on the planner's
 * snapshot shape (EmployeeAssignments.snapshotOf). DOM-free; Node can
 * require it. Money is in game currency per PP; bonuses are fractions.
 *
 * Game rules (research, 2026-11-04):
 * - Switching costs company.changeItemCost (5) concrete. No cooldown, and no
 *   other resets: employees stay, so tenure, Creature of Habit and the
 *   recently-moved happiness stay as they are. Stored company.production is
 *   PP and carries over to the new good.
 * - Saved specialisation is stored per good in days and never decays; the
 *   game reads it as min(days × percentPerDay, maxPercent). Only the current
 *   good gains a day. Switching back resumes from the saved days.
 * - Held tools stay equipped when the new good takes the same tool type,
 *   otherwise they go back to inventory as spares.
 * - The regional bonus (computeProductionBonus) is per good and boosts the
 *   automated engine only. It is 0 everywhere while deposits are disabled.
 * - Specialist's good is its trait arg; Craftsman and Laborer follow the
 *   item type. The planner reads both from the company, so they follow a
 *   switch with no change to the employees. */
const ProductSwitchCore = (() => {
  const EP = typeof module !== 'undefined' ? require('./employee-planner.js') : EmployeePlanner;
  const SPECIALIZATION = { percentPerDay: 1, maxPercent: 20 };
  const CHANGE_ITEM_COST = 5;
  // Live margin over the game's average margin above which a good's price
  // is treated as a spike that may soon drop. Tuned in the joint search.
  const SPIKE_RATIO = 1.25;

  const toolTypeOf = product => Object.keys(EP.TOOL_TYPES).find(k => EP.TOOL_TYPES[k].includes(product)) || null;

  // Saved specialisation on `product`, as a percentage.
  const savedSpecialization = (e, product) =>
    Math.min(SPECIALIZATION.maxPercent, Math.max(0, (e.specializations?.[product] || 0) * SPECIALIZATION.percentPerDay));

  /* The two price sets, built once per load: `live` from the market list
   * (order-book margin after tax and inputs, market.list[].perPP) and `game`
   * from EmployeeCore.gameMargins (the game's slow multi-day average). Both
   * are { code: money per PP }. worse(code) is the lower of the two, or the
   * one known; spike(code) flags a live margin far above the game's. */
  function priceSets({ list = [], gameMargin = {} } = {}, spikeRatio = SPIKE_RATIO) {
    const live = Object.fromEntries(list.filter(p => Number.isFinite(p.perPP)).map(p => [p.code, p.perPP]));
    const game = Object.fromEntries(Object.entries(gameMargin || {}).filter(([, v]) => Number.isFinite(v)));
    const known = code => [live[code], game[code]].filter(Number.isFinite);
    const worse = code => known(code).length ? Math.min(...known(code)) : null;
    // live / game, or null without both; a loss in the game's prices against
    // a live profit counts as a spike.
    const ratio = code => Number.isFinite(live[code]) && game[code] > 0 ? live[code] / game[code] : null;
    const spike = code => {
      if (!Number.isFinite(live[code]) || !Number.isFinite(game[code])) return false;
      return game[code] > 0 ? live[code] / game[code] > spikeRatio : live[code] > 0;
    };
    const worseSet = Object.fromEntries([...new Set([...Object.keys(live), ...Object.keys(game)])].map(code => [code, worse(code)]));
    return { live, game, worse, worseSet, ratio, spike, spikeRatio };
  }

  /* `company` (a snapshot company) on `product`. ctx:
   *   types        { code: 'raw' | 'product' | 'weapon' } (market.types)
   *   margins      { code: money per PP }, one price set (priceSets().live …)
   *   concretePrice  unit price of concrete, for the switch cost
   *   changeItemCost concrete per switch (gameConfig company.changeItemCost)
   *   country, region  the company's raw API records, for the regional bonus
   *   productionBonus  computeProductionBonus(country, region, itemCode);
   *                    defaults to the page's global from shared.js
   * Returns the company re-tooled, with `switch`: { from, to, cost, concrete,
   * toolTypeChanges, engineDaily } (engineDaily: engine PP a day). The same
   * product is no switch and costs nothing. */
  function retool(company, product, ctx = {}) {
    const same = product === company.product;
    const margin = Number.isFinite(ctx.margins?.[product]) ? ctx.margins[product] : same ? company.margin : NaN;
    const type = ctx.types?.[product] ?? (same ? company.type : undefined);
    const bonusOf = ctx.productionBonus || (typeof computeProductionBonus === 'function' ? computeProductionBonus : null);
    const regional = bonusOf && ctx.country ? bonusOf(ctx.country, ctx.region, product) : null;
    const engineBonus = regional ? (regional.total || 0) / 100 : same ? company.engineBonus || 0 : 0;
    const concrete = same ? 0 : ctx.changeItemCost ?? CHANGE_ITEM_COST;
    const cost = !concrete ? 0 : Number.isFinite(ctx.concretePrice) ? concrete * ctx.concretePrice : null;
    const next = { ...company, product, type, margin, engineBonus };
    next.switch = { from: company.switch?.from ?? company.product, fromType: company.switch?.fromType ?? company.type, to: product, cost, concrete,
      toolTypeChanges: toolTypeOf(company.product) !== toolTypeOf(product),
      engineDaily: (company.engineDailyProd || 0) * (1 + engineBonus) };
    return next;
  }

  /* The snapshot with company `companyId` re-tooled onto `product`. Its
   * employees read their saved days on the new good, capped. A held tool
   * that no longer fits comes off and stays in `tools` as an unheld spare;
   * `spares` lists those tool IDs. */
  function retoolSnapshot(snapshot, companyId, product, ctx = {}) {
    const old = snapshot.companies.find(c => c.id === companyId);
    if (!old) throw new Error(`Unknown company ${companyId}`);
    const company = retool(old, product, ctx);
    const fits = type => !!EP.TOOL_TYPES[type]?.includes(product);
    const spares = [];
    const employees = snapshot.employees.map(e => {
      if (e.company !== companyId) return e;
      const next = { ...e, specializations: { ...e.specializations, [product]: savedSpecialization(e, product) } };
      if (e.equipped && !fits(e.equipped.type)) { spares.push(e.equipped.id); next.equipped = null; }
      return next;
    });
    const off = new Set(spares);
    const tools = snapshot.tools.map(t => off.has(t.id) ? (({ holder, ...rest }) => rest)(t) : t);
    return { snapshot: { ...snapshot, companies: snapshot.companies.map(c => c.id === companyId ? company : c), employees, tools }, company, spares };
  }

  /* Each company's best switch on its own (product-switch 05, Top
   * Products): the company re-tooled alone (retoolSnapshot) and the whole
   * snapshot evaluated at both price sets, against the snapshot as it is.
   * Same candidates (EmployeePlanner.switchContext: every other good with a
   * margin), minimum gain and verdict names as the Products tab's joint
   * search: each good alone, and with free fitting tools for members left
   * without one, but without the joint search's follow-up moves, swaps and
   * tool exchanges. Free tools are shared, so they are handed out greedily:
   * the switch that gains most at the worse price takes its tools first,
   * and later companies are judged without them. `opts` is the snapshot's `switches`
   * (EmployeeAssignments.snapshotOf adds it when concrete has a price).
   * Returns null without options, { errors } if the snapshot doesn't
   * validate, else { days, floor, rows } with one row per company in
   * snapshot order: { id, product, verdict, to, tools and toolIds (the free
   * tools it equips), gain: { live, game } a day net of the concrete, spike, ratio,
   * cost, concrete, payback (days),
   * excluded (reason), candidates (every good tried, best worse-of-two
   * first) }. Verdicts as EmployeeProducts: switch | spike | hold | stay | off. */
  function singleSwitches(snapshot, opts = snapshot.switches) {
    const sw = EP.switchContext(opts);
    if (!sw) return null;
    const s0 = EP.withExclusions(snapshot);
    const base = EP.evaluate(s0);
    if (!base.valid) return { errors: base.errors };
    const days = (s0.hours ?? s0.days * 24) / 24;
    const floor = Math.max(EP.CHURN.floorMin, EP.CHURN.floorShare * base.value);
    // Value at the game's margins: each company's PP repriced.
    const gameValue = (s, r) => {
      const byId = new Map(s.companies.map(c => [c.id, c]));
      return r.byCompany.reduce((sum, x) => { const c = byId.get(x.id); return sum + x.value + (sw.gameMargin(c) - c.margin) * x.pp; }, 0);
    };
    const baseGame = gameValue(s0, base);
    const ctx = { types: opts.market.types || {}, margins: sw.sets.live, concretePrice: opts.concretePrice, changeItemCost: opts.changeItemCost };
    const rows = s0.companies.map(c => {
      const row = { id: c.id, product: c.product, verdict: 'stay', to: null, tools: 0, toolIds: [], gain: null, spike: false, ratio: null, cost: null, concrete: 0, payback: null, excluded: c.excluded || null, candidates: [] };
      if (c.excluded) return { ...row, verdict: 'off' };
      if (c.disabled) return row;
      const need = floor * (c.switchedAgeHours < EP.CHURN.recentHours ? EP.CHURN.recentFactor : 1);
      for (const product of sw.products(c)) {
        const { snapshot: s, company } = retoolSnapshot(s0, c.id, product, { ...ctx, ...(opts.regions?.[c.id] || {}) });
        if (!Number.isFinite(company.margin)) continue;
        // As the planner's ':tools' variant: those left without a tool take
        // a free one that fits, best first.
        const asIs = s.employees.map(e => ({ employee: e.id, company: e.company, tool: e.equipped?.id || null }));
        const free = s.tools.filter(t => t.hours > 0 && !t.holder && EP.TOOL_TYPES[t.type]?.includes(product))
          .sort((a, b) => b.bonus - a.bonus || b.hours - a.hours || (a.id < b.id ? -1 : 1));
        const bare = s.employees.filter(e => e.company === c.id && !e.equipped)
          .sort((a, b) => b.production - a.production || (a.id < b.id ? -1 : 1)).slice(0, free.length).map(e => e.id);
        const variants = [[asIs, false]];
        if (bare.length) variants.push([asIs.map(a => bare.includes(a.employee) ? { ...a, tool: free[bare.indexOf(a.employee)].id } : a), true]);
        for (const [arrangement, tools] of variants) {
          const r = EP.evaluate(s, arrangement);
          if (!r.valid) continue;
          const live = r.value - base.value, game = gameValue(s, r) - baseGame, worse = Math.min(live, game);
          const cost = company.switch.cost, gross = (worse + (cost || 0)) / days;
          row.candidates.push({ to: product, tools: tools ? bare.length : 0, toolIds: tools ? free.slice(0, bare.length).map(t => t.id) : [], live, game, worse, need, cost, concrete: company.switch.concrete,
            spike: sw.sets.spike(product), ratio: sw.sets.ratio(product),
            payback: !cost ? 0 : gross > 0 ? cost / gross : Infinity });
        }
      }
      row.candidates.sort((a, b) => b.worse - a.worse || a.tools - b.tools || (a.to < b.to ? -1 : 1));
      return row;
    });
    const eps = 1e-9, pays = x => x.worse > x.need + eps;
    // A company's best switch among those whose tools are still free, else
    // its best hold (by today's gain).
    const pick = (row, free) => {
      const open = row.candidates.filter(x => x.toolIds.every(id => free.has(id)));
      return open.find(pays) || open.filter(x => x.live > x.need + eps).sort((a, b) => b.live - a.live || a.tools - b.tools || (a.to < b.to ? -1 : 1))[0] || null;
    };
    const free = new Set(s0.tools.filter(t => !t.holder).map(t => t.id)), picked = new Map();
    for (;;) {
      // The best switch that takes free tools goes first; ties on company ID.
      const next = rows.filter(r => !picked.has(r.id) && r.verdict === 'stay')
        .map(r => ({ r, x: pick(r, free) })).filter(({ x }) => x && pays(x) && x.tools)
        .sort((a, b) => b.x.worse - a.x.worse || (a.r.id < b.r.id ? -1 : 1))[0];
      if (!next) break;
      picked.set(next.r.id, next.x);
      for (const id of next.x.toolIds) free.delete(id);
    }
    return { days, floor, rows: rows.map(row => {
      if (row.verdict !== 'stay') return row;
      const x = picked.get(row.id) || pick(row, free);
      if (!x) return row;
      return { ...row, verdict: pays(x) ? 'switch' : x.spike ? 'spike' : 'hold', to: x.to, tools: x.tools, toolIds: x.toolIds,
        gain: { live: x.live / days, game: x.game / days }, spike: x.spike, ratio: x.ratio,
        cost: x.cost, concrete: x.concrete, payback: x.payback };
    }) };
  }

  return { SPECIALIZATION, CHANGE_ITEM_COST, SPIKE_RATIO, toolTypeOf, savedSpecialization, priceSets, retool, retoolSnapshot, singleSwitches };
})();

if (typeof module !== 'undefined') module.exports = ProductSwitchCore;
