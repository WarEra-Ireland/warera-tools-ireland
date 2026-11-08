/*
 *  EMPLOYEE CORE  (training card values, no DOM)
 *  Scores a training card as the money it adds over the employee's
 *  remaining working life. Config numbers come from the game bundle.
 *  Runs in the browser and the planner worker (global EmployeeCore) and in
 *  Node (module.exports).
 *
 *  Money unit: everything is per "point" of production valued at the
 *  market value of a point (V). Output and wage both scale with V, so
 *  rankings don't depend on it; only the toolbox value does.
 *
 *  Model, per worked hour:
 *    output = (P + T + extra)/4 × (1 + bonus) × sellRatio × V
 *    wage   = P/4 × wageExpectation × V
 *  P is hired plus trained Production (the API's `base`). T is the flat
 *  Production of the employee's own traits (Laborer, Expat, Early Bloomer…)
 *  and `extra` the rest (Rival, Mentor and coworkers' effects); neither is
 *  paid for, as every employee's wage shows. v0.27.4
 *  briefly paid T too; CFG.traitProductionPaid turns that back on. So a
 *  Production drill earns only its margin over the wage it adds, and a
 *  trait's Production earns its full output.
 *  sellRatio is what your product earns per point ÷ V (1 = an average product).
 *  Specialization adds +1% bonus a day on the same product, up to +20%; the
 *  bonus typed in is today's, and it keeps climbing while specialization does.
 *
 *  The rules live in the employee model crate (wasm/src/rules.rs,
 *  hourly.rs, fresh.rs), loaded by js/employee-model.js. This file keeps
 *  the EmployeeCore API over it: it hands the plain objects over (the
 *  module decodes them with the defaults, wasm/src/model.rs) and adds
 *  display text (trait names in js/employee-traits.js).
 *  Input shaping that reads the API (currentTraits, ownTraitProduction,
 *  tradePrice, the situation helpers) stays JS. Tables and calls
 *  that need no shaping (CFG, NUMERIC_CARDS, toolboxRate, …) are the
 *  module's own, EmployeeModel.CFG and EmployeeModel.api; this file exposes
 *  them too, for the tests and the harness.
 *
 *  Handles: EC.subject(e, ctx) decodes an employee in a context once. Pass
 *  it as `e` to any function below that takes (e, ctx) and its ctx argument
 *  is ignored; work shared between calls is kept while it lives. Free it
 *  with .free() when done (garbage collection frees it too). A plain e and
 *  ctx are decoded for that one call.
 *
 *  Nothing here may run before EmployeeModel.ready: the router waits for
 *  it, the planner worker queues on it, and the differential harness
 *  awaits it. The tables are read on first use.
 */
const EmployeeCore = (() => {
  const node = typeof module !== 'undefined' && typeof require === 'function';
  const M = typeof EmployeeModel !== 'undefined' ? EmployeeModel : node ? require('./employee-model.js') : null;
  const TEXT = typeof EMPLOYEE_TRAIT_TEXT !== 'undefined' ? EMPLOYEE_TRAIT_TEXT : node ? require('./employee-traits.js') : {};
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  const api = () => {
    if (!M?.api) throw Error('The employee model is not ready: wait for EmployeeModel.ready.');
    return M.api;
  };

  // --- Tables: the module's rules with this file's display text ---

  let T = null;
  function tables() {
    if (T) return T;
    const t = M.TABLES ?? api().tables();
    const missing = [...M.TRAIT_RULES.filter(r => !TEXT[r.code]).map(r => `${r.code} (no text)`),
      ...Object.keys(TEXT).filter(code => !M.TRAIT_RULES.some(r => r.code === code)).map(code => `${code} (no rules)`)];
    if (missing.length) console.error(`[model] Trait tables disagree: ${missing.join(', ')}`);
    // The UI's trait rows: the rules, name and when, and the note as
    // `unpriced` or `partial` by how much the model prices.
    const TRAITS = M.TRAIT_RULES.map(({ priced, ...rules }) => {
      const text = TEXT[rules.code] || {};
      const note = priced === 'unpriced' ? { unpriced: text.note } : priced === 'partial' ? { partial: text.note } : {};
      return { ...rules, name: text.name ?? rules.code, when: text.when ?? '', ...note };
    });
    T = {
      TRAITS, TRAIT: Object.fromEntries(TRAITS.map(r => [r.code, r])),
      DEFAULT_EMPLOYEE: t.defaultEmployee, DEFAULT_CONTEXT: t.defaultContext, DEFAULT_SITUATION: t.defaultSituation,
    };
    return T;
  }
  // --- Input shaping that stays JS ---

  function drill(stat, delta) { return { card: 'drill', stat, delta }; }
  function neg(drop) { return { card: 'negotiation', drop }; }
  function wind(gain) { return { card: 'secondWind', gain }; }

  // Days left to retirement: from retireInDays, else the age; NaN with neither.
  const workingDays = e => api().workingDays(e) ?? NaN;
  // The Production the wage is paid on. Assumed never below 1, like the
  // stat; NaN when the Production is unknown.
  const paidProduction = e => api().paidProduction(e) ?? NaN;
  // Traits whose Production isn't paid: they compare the employee with coworkers.
  const UNPAID_PRODUCTION = new Set(['rival', 'mentor']);
  // Retired codes and what the game turned them into.
  const RENAMED_TRAITS = { sprinter: 'earlyBloomer' };
  const currentTraits = traits => (traits || []).map(t => RENAMED_TRAITS[t.code] ? { ...t, code: RENAMED_TRAITS[t.code] } : t);
  // An API employee's own trait Production: the flat Production entries in
  // breakdown.production.contributions from traits they hold, but not Rival
  // or Mentor. Coworkers' Mentor bonus carries the code 'mentor' too.
  function ownTraitProduction(emp) {
    const held = new Set(currentTraits(emp?.traits).map(t => t.code));
    return (emp?.breakdown?.production?.contributions || []).reduce((a, c) => {
      const code = RENAMED_TRAITS[c.code] || c.code;
      return !c.percent && held.has(code) && !UNPAID_PRODUCTION.has(code) && Number.isFinite(c.delta) ? a + c.delta : a;
    }, 0);
  }
  function nationalitySituation(nationality, coworkers) {
    return {
      sameNationalityCoworkers: coworkers.filter(e => e.nationality === nationality).length,
      otherNationalities: new Set(coworkers.map(e => e.nationality).filter(n => n && n !== nationality)).size,
    };
  }
  function locationSituation(country, coreCountry, nationality) {
    return { place: country !== nationality ? 'abroad' : coreCountry === nationality ? 'homeCore' : 'home',
      homeCore: coreCountry === nationality };
  }
  function productionStanding(own, peers) {
    const weakerCount = peers.filter(p => p < own).length;
    return { strongerCoworker: peers.some(p => p > own), weakerCoworker: weakerCount > 0, weakerCount };
  }
  // The game's own money per PP of each product, as its UI prices profit:
  // `values` (gameStat.getPpMoneyValueByItem) is money per embodied PP, so a
  // unit is worth value × (its PP plus its inputs' PP), less what its inputs
  // are worth. No market tax. An item without a value takes `ppValue`
  // (gameStat.getPpMoneyValue); a product with an input that has none counts
  // no input cost. { code: money per PP }.
  // In the module (gameMargins).
  const gameMargins = (items, values, ppValue) => api().gameMargins(items, values || {}, Number(ppValue));

  // A product's market price: the volume-weighted average of its latest
  // trades (transaction.getPaginatedTransactions with transactionType
  // 'trading' and limit PRICE_TRADES.sample), leaving out any older than
  // PRICE_TRADES.maxAgeHours before `now`. null with none left.
  const PRICE_TRADES = Object.freeze({ sample: 100, maxAgeHours: 24 });
  function tradePrice(trades, now = Date.now()) {
    const cutoff = now - PRICE_TRADES.maxAgeHours * 3600 * 1000;
    let money = 0, qty = 0;
    for (const tx of trades || []) {
      if (!(tx?.quantity > 0) || typeof tx.money !== 'number' || new Date(tx.createdAt).getTime() < cutoff) continue;
      money += tx.money; qty += tx.quantity;
    }
    return qty > 0 ? money / qty : null;
  }

  const str = v => typeof v === 'string' && v ? v : null;
  const orNull = v => v === undefined ? null : v;

  const HANDLE = Symbol('EmployeeCore.subject');
  // An employee in a context, decoded once (see the header).
  function subject(e, ctx = {}) {
    const h = new (api().Subject)(e, ctx);
    return { [HANDLE]: h, e, ctx, free: () => h.free() };
  }
  // Runs f(handle, e) on a subject, or on a plain e and ctx for this call.
  function via(e, ctx, f) {
    if (e?.[HANDLE]) return f(e[HANDLE], e.e);
    const h = new (api().Subject)(e, ctx);
    try { return f(h, e); } finally { h.free(); }
  }
  // The employee after a card: { ...e } with the traits (held ones kept as
  // they are) and the fields the card set, in the order it set them.
  function employeeAfter(e, o) {
    const next = { ...e };
    if (o.traits) {
      const held = e.traits || [];
      next.traits = o.traits.map(x => typeof x === 'number' ? held[x] : x[1] ? { code: x[0], arg: x[1] } : { code: x[0] });
    }
    return Object.assign(next, o.set);
  }
  // A trait value's note, as text.
  function withNote(code, r) {
    if (r.note) r.note = r.note === 'unpriced' ? tables().TRAIT[code]?.unpriced : tables().TRAIT[code]?.partial;
    return r;
  }

  // --- The rules ---

  const toolboxRate = luck => api().toolboxRate(luck);
  const rarityOdds = (luck, management) => api().rarityOdds(luck, management);
  const canNegotiate = (e, c) => via(e, {}, h => h.canNegotiate(Number(c.drop)));
  const careerBonus = (e, rate = 1) => via(e, {}, h => h.careerBonus(rate));
  const marginPerPoint = (e, ctx) => via(e, ctx, h => h.marginPerPoint());
  const hourlyProfit = (e, ctx) => via(e, ctx, h => h.hourlyProfit());

  const cardValue = (e, c, ctx, depth = 1) => via(e, ctx, h => orNull(h.cardValue(c, depth)));
  const cardOutcomes = (e, c, ctx = {}) => via(e, ctx, (h, e) => h.cardOutcomes(c).map(o => ({ p: o.p, arg: o.arg, employee: employeeAfter(e, o) })));
  const gameDailyProfit = (e, c, ctx, margin, ppValue) => via(e, ctx, h => orNull(h.gameDailyProfit(c, margin, ppValue)));
  const traitValue = (code, e, ctx = {}, { arg = null, held = false } = {}) =>
    via(e, ctx, h => withNote(code, h.traitValue(String(code), str(arg), !!held)));
  const wildCardOutcomes = (e, ctx = {}) => via(e, ctx, h => h.wildCardOutcomes());
  const cardPool = (e, ctx = {}, { price = null, depth = 1 } = {}) => via(e, ctx, h => h.cardPool(price, depth));
  const trainingOutlook = (e, ctx = {}, { price = null, depth = 1 } = {}) => via(e, ctx, h => h.trainingOutlook(price, depth));
  const secondWindValue = (e, c, ctx, depth, price = null) => via(e, ctx, h => h.secondWindValue(Number(c.gain), depth, price));
  const futureLuckValue = (e, delta, ctx = {}) => via(e, ctx, h => h.futureLuckValue(delta));
  const expectedTrainingValue = (e, ctx, depth = 0, price = null) => via(e, ctx, h => h.expectedTrainingValue(depth, price));
  const potentialValue = (e, ctx, potential, alt, trainingValue) => via(e, ctx, h => h.potentialValue(potential, alt, trainingValue ?? undefined));
  const rolledTraitValue = (e, ctx, genders = ['male', 'female']) => via(e, ctx, h => h.rolledTraitValue(genders.map(String)));
  // On this situation, whatever context a subject was made with.
  const comparisonProduction = (e, situation = {}, day = 0) => via(e?.[HANDLE] ? e.e : e, { situation }, h => h.comparisonProduction(day));

  const traitsById = ids => Array.from(ids, id => tables().TRAITS[id]);
  const genderIn = g => typeof g === 'string' ? g : undefined;
  // Traits a Habit (positive) or Wild Card (any) could give.
  const eligibleTraits = (heldCodes, gender, polarities) => traitsById(api().eligibleTraits(heldCodes.map(String), genderIn(gender), polarities));
  const wildCardRisk = (heldCodes, gender) => orNull(api().wildCardRisk(heldCodes.map(String), genderIn(gender)));
  // Rows { production, rival, mentor }: Production after peer effects.
  const peerProduction = rows => Array.from(api().peerProduction(rows));
  // What 10 energy earns elsewhere `day` days from now: ctx.energyValue,
  // a number or a list by day (the last entry holds after it).
  const energyOn = (ctx, day) => api().energyOn(ctx, day);

  // --- Recruiting ---

  // A typed-in candidate over their working life, in PP. cand: { age,
  // gender, wagePP (hourly wage ÷ V), expectation (the card's wage against
  // the market, 1 = market), production, responsibility, luck }: either
  // wage will do (see wasm/src/fresh.rs). { value, output, trait,
  // potential, happiness, wageExpectation, reading (the wage against the
  // market, as read), odds: { greedy, modest }, spread }.
  // The module checks the candidate and fills in the options' defaults
  // (bonus 0, happinessLoss DEFAULT_EMPLOYEE's, alt 0).
  const candidateValue = (cand, ctx = {}, options = {}) => api().candidateValue(cand, { ...options, ctx });
  // A fresh set of candidates (see wasm/src/fresh.rs). groups: [{ weight,
  // ctx, bonus, happinessLoss, coworkers }]; groups in one setting (ctx,
  // bonus, happinessLoss) share a newcomer. options: { alt, slots, draws,
  // seed, rate: 'slot' | PP a slot-day }. { best, gross, days, rate,
  // average, coworkers, beat(bar) }.
  const groupsOf = groups => Array.isArray(groups) ? groups : [groups || {}];
  function freshSetValue(groups, options = {}) {
    const set = api().freshSetValue(groupsOf(groups), options);
    const out = set.summary();
    out.beat = bar => set.beat(bar);
    return out;
  }
  // For the planner's career: the employee after an outcome.
  const inputs = Object.freeze({ after: employeeAfter });

  const EC = {
    toolboxRate, RARITIES, currentTraits, ownTraitProduction, paidProduction, subject, inputs,
    cardPool, cardOutcomes, gameDailyProfit, gameMargins, tradePrice, PRICE_TRADES, wildCardOutcomes, secondWindValue, energyOn, trainingOutlook, rolledTraitValue, futureLuckValue,
    potentialValue, candidateValue, freshSetValue,
    comparisonProduction, productionStanding, peerProduction, nationalitySituation, locationSituation, eligibleTraits, wildCardRisk, canNegotiate, traitValue,
    drill, neg, wind, cardValue, rarityOdds,
    expectedTrainingValue, marginPerPoint, hourlyProfit, careerBonus, workingDays,
  };
  // The module's tables, read once it is ready.
  for (const k of ['CFG', 'NUMERIC_CARDS', 'EXCLUSIVE']) Object.defineProperty(EC, k, { enumerable: true, get: () => M[k] });
  for (const k of ['TRAITS', 'TRAIT', 'DEFAULT_EMPLOYEE', 'DEFAULT_CONTEXT', 'DEFAULT_SITUATION']) {
    Object.defineProperty(EC, k, { enumerable: true, get: () => tables()[k] });
  }
  return EC;
})();

if (typeof module !== 'undefined') module.exports = EmployeeCore;
