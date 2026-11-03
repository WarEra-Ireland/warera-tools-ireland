/* ═══════════════════════════════════════════════════════════════════
 *  EMPLOYEE CORE  (training card values, no DOM)
 *  Scores a training card as the money it adds over the employee's
 *  remaining working life. Config numbers come from the game bundle.
 *  Runs in the browser (global EmployeeCore) and
 *  in Node (`node js/employee-core.js` prints the reference rankings).
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
 *  paid for. Checked against every employee's wage (2026-11-03). v0.27.4
 *  briefly paid T too; CFG.traitProductionPaid turns that back on. So a
 *  Production drill earns only its margin over the wage it adds, and a
 *  trait's Production earns its full output.
 *  sellRatio is what your product earns per point ÷ V (1 = an average product).
 *  Specialization adds +1% bonus a day on the same product, up to +20%; the
 *  bonus typed in is today's, and it keeps climbing while specialization does.
 * ═══════════════════════════════════════════════════════════════════ */
const EmployeeCore = (() => {
  const CFG = {
    retireAge: 65,
    outputDivisor: 4,
    wageFloor: 0.7,
    potentialMaxCap: 15,
    handSize: 3,
    wildCardStatGain: 2,            // a Wild Card's random stat gain (v0.27.4: 1 → 2)
    // Whether the wage is paid on the employee's own traits' flat Production
    // too. v0.27.4 paid it for a few hours on 2026-11-02, then the server
    // went back to base (hired + trained) Production only.
    traitProductionPaid: false,
    respHappiness: 3,               // happiness per point of Responsibility, always on
    happinessMax: 100,
    specializationMax: 20,          // % bonus, gained 1% a day on one product
    toolboxChancePerLuck: 0.001,
    maxToolboxChancePerHour: 0.02,
    rarityWeights: { common: 55, uncommon: 25, rare: 13, epic: 5, legendary: 2 },
    managementShift: { uncommon: 1, rare: 0.6, epic: 0.3, legendary: 0.1 },   // per owner Management level
    luckShift: { uncommon: 0.5, rare: 0.3, epic: 0.15, legendary: 0.05 },
  };
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  // Cards the model can price. Trait cards (Habit, Rehab, Wild Card) depend on
  // which trait, so they're ranked by hand in the reference, not here.
  const NUMERIC_CARDS = {
    common:    [drill('production', 1), drill('responsibility', 1), drill('luck', 1), neg(0.05)],
    uncommon:  [drill('production', 2), drill('responsibility', 2), drill('luck', 2), neg(0.10)],
    rare:      [neg(0.20), wind(2)],
    epic:      [drill('production', 3), drill('responsibility', 3), drill('luck', 3), wind(3)],
    legendary: [drill('production', 4), drill('responsibility', 4), drill('luck', 4), wind(4)],
  };
  // Trait cards that change Production can be priced: each point earns its
  // output (less the wage only if CFG.traitProductionPaid). They only count while the trait's condition
  // holds (product type, coworkers, region, age).
  const PROD_TRAIT_CARDS = {
    rare:      [traitProd(2, 'Rehab', '−2 Prod trait', 'Xenophobe, Homesick, Worn Out')],
    epic:      [traitProd(2, 'Habit', '+2 Prod trait', 'Patriot, Expat, Cosmopolitan')],
    legendary: [traitProd(4, 'Habit pair', '+4 Prod or more', 'two of Patriot, Expat, Cosmopolitan')],
  };
  function traitProd(delta, name, detail, examples) { return { card: 'traitProd', delta, name, detail, examples }; }
  function drill(stat, delta) { return { card: 'drill', stat, delta }; }
  function neg(drop) { return { card: 'negotiation', drop }; }
  function wind(gain) { return { card: 'secondWind', gain }; }

  const DEFAULT_EMPLOYEE = {
    age: 30, production: 3, responsibility: 2, luck: 2,
    traitProduction: 0,     // own traits' flat Production, today; paid like P only if CFG.traitProductionPaid
    extraProduction: 0,     // Rival, Mentor and coworkers' Production; produces but isn't paid
    bonus: 0.24,            // production bonus as a fraction (+24%), today
    productionEvents: [],   // included in bonus today: [{ delta: percent, hours: remaining }]
    specialization: 20,     // % of the bonus that is specialization; 20 = maxed, no further growth
    wageExpectation: 1,     // wage ÷ (paid Production/4 × V): 1 = market rate, Greedy/Modest folded in
    happinessLoss: 10,      // happiness points lost to tax, storage, moves… (Loyal halves them)
    happiness: null,        // today's happiness, 0 to 100; null = unknown, so gains aren't capped
    potentialLeft: 3,
    trainingsPerDay: 1,
  };
  const DEFAULT_CONTEXT = {
    sellRatio: 1,
    toolboxValue: 0,        // in points of production; unknown, so off by default
    management: 0,          // the owner's Management level, for training card rarity
    energyValue: 0,         // PP 10 energy earns elsewhere, or a list by day from today; Second Wind's trainings are net of it
  };

  const workingDays = e => Math.max(0, Number.isFinite(e.retireInDays) ? e.retireInDays : CFG.retireAge - e.age);
  const hoursLeft = e => workingDays(e) * 24;
  // The Production the wage is paid on. Assumed never below 1, like the stat.
  const paidProduction = e => Math.max(1, e.production + (CFG.traitProductionPaid ? e.traitProduction || 0 : 0));
  const pph = e => (e.production + (e.traitProduction || 0) + e.extraProduction) / CFG.outputDivisor;   // output points per hour before bonuses
  const paidPph = e => paidProduction(e) / CFG.outputDivisor;                                      // the points the wage is paid on
  // Traits whose Production isn't paid: they compare the employee with coworkers.
  const UNPAID_PRODUCTION = new Set(['rival', 'mentor']);

  // Average bonus over the working days left: today's, plus the
  // specialization still to come (+1% a day until the cap).
  // Quick Study doubles the growth (rate 2).
  function careerBonus(e, rate = 1) {
    const days = workingDays(e);
    // Today's bonus includes each event in full. Replace that part with its
    // share of the remaining career, including partial days and negative events.
    const bonus = e.bonus + (e.productionEvents || []).reduce((sum, event) => sum
      + event.delta / 100 * ((days ? Math.min(1, Math.max(0, event.hours) / (days * 24)) : 0) - 1), 0);
    const room = Math.max(0, CFG.specializationMax - e.specialization);
    if (!days || !room) return bonus;
    let extra = 0;
    for (let k = 0; k < days; k++) extra += Math.min(room, k * rate);
    return bonus + extra / days / 100;
  }

  // Margin per point of paid Production, per hour, averaged over the working
  // days left: its output after bonuses minus the wage it adds.
  const marginPerPoint = (e, ctx) => (1 + careerBonus(e)) * ctx.sellRatio - e.wageExpectation;

  // The wage expectation below which a Production drill beats the
  // Negotiation of the same rarity (margin > 5% × paid Production).
  const drillBeatsNegotiationBelow = (e, ctx) => (1 + careerBonus(e)) * ctx.sellRatio - 0.05 * paidProduction(e);

  // What the employee earns you per hour (output − wage), averaged over the
  // working days left, in PP.
  const hourlyProfit = (e, ctx) => pph(e) * (1 + careerBonus(e)) * ctx.sellRatio - paidPph(e) * e.wageExpectation;

  // Happiness gained, in points: at most what's left below the cap. Each
  // point adds 1% to the production bonus, so 1% of base output.
  const room = h => h == null ? Infinity : Math.max(0, CFG.happinessMax - h);
  const happyGain = (n, h) => n > 0 ? Math.min(n, room(h)) : n;

  function toolboxRate(luck) {
    return Math.min(CFG.maxToolboxChancePerHour, Math.max(0, luck) * CFG.toolboxChancePerLuck);
  }

  // Models store the effective wage multiplier; the game applies Negotiation
  // to base expectation, before Greedy/Modest and without Climber drift.
  const wageTraitMultiplier = e => (e.traits || []).some(t => t.code === 'greedy') ? 1.2
    : (e.traits || []).some(t => t.code === 'modest') ? 0.85 : 1;
  const canNegotiate = (e, c) => Math.round(1000 * ((e.negotiationExpectation ?? e.wageExpectation / wageTraitMultiplier(e)) - c.drop)) / 1000 >= CFG.wageFloor;

  // Money per hour each card adds, in points of production (× V for money).
  function hourlyGain(e, c, ctx) {
    if (c.card === 'negotiation') {
      if (!canNegotiate(e, c)) return null;   // card not offered
      return paidPph(e) * c.drop * wageTraitMultiplier(e);
    }
    if (c.card === 'traitProd') return c.delta / CFG.outputDivisor
      * (CFG.traitProductionPaid ? marginPerPoint(e, ctx) : (1 + careerBonus(e)) * ctx.sellRatio);
    if (c.card === 'drill') {
      if (c.stat === 'production') return (c.delta / CFG.outputDivisor) * marginPerPoint(e, ctx);
      if (c.stat === 'responsibility') {
        const extraHappiness = happyGain(CFG.respHappiness * c.delta, e.happiness);
        return pph(e) * ctx.sellRatio * extraHappiness * 0.01;
      }
      if (c.stat === 'luck') return (toolboxRate(e.luck + c.delta) - toolboxRate(e.luck)) * ctx.toolboxValue;
    }
    return 0;
  }

  // The card's daily profit as the game shows it: today's change in output
  // at the game's price, minus today's change in wage, over 24 hours, in
  // money. Not averaged over the career, so specialization growth, aging,
  // coworkers and future trainings are left out. `margin` is the game's money
  // per PP of this product (gameMargins); e.wage, when known, is the wage per
  // hour in money, otherwise it is worked out from `ppValue`. null for a card
  // whose outcome is random or a trait, or a Negotiation the game would not offer.
  function gameDailyProfit(e, c, ctx, margin, ppValue) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    if (!(margin > 0) || !['drill', 'negotiation', 'secondWind'].includes(c.card)) return null;
    if (!Number.isFinite(e.wage) && !(ppValue > 0)) return null;
    if (c.card === 'negotiation' && !canNegotiate(e, c)) return null;
    let output = 0;   // PP per hour
    if (c.card === 'drill' && c.stat === 'production') output = c.delta / CFG.outputDivisor * (1 + e.bonus);
    if (c.card === 'drill' && c.stat === 'responsibility') output = pph(e) * happyGain(CFG.respHappiness * c.delta, e.happiness) * 0.01;
    const next = cardOutcomes(e, c, ctx)[0]?.employee || e;
    const wage = x => Number.isFinite(e.wage) ? x.wage : paidPph(x) * x.wageExpectation * ppValue;
    return 24 * (output * margin - (wage(next) - wage(e)));
  }

  // The game's own money per PP of each product, as its UI prices profit:
  // `values` (gameStat.getPpMoneyValueByItem) is money per embodied PP, so a
  // unit is worth value × (its PP plus its inputs' PP), less what its inputs
  // are worth. No market tax. An item without a value takes `ppValue`
  // (gameStat.getPpMoneyValue); a product with an input that has none counts
  // no input cost. { code: money per PP }.
  function gameMargins(items, values, ppValue) {
    const valueOf = code => values?.[code] > 0 ? values[code] : ppValue;
    const embodied = {};
    const pp = code => embodied[code] ??= (items[code]?.productionPoints || 0)
      + Object.entries(items[code]?.productionNeeds || {}).reduce((sum, [need, n]) => sum + n * pp(need), 0);
    const out = {};
    for (const [code, it] of Object.entries(items)) {
      if (!(it?.productionPoints > 0)) continue;
      const needs = Object.entries(it.productionNeeds || {});
      if (needs.some(([need]) => !(values?.[need] > 0))) { out[code] = valueOf(code); continue; }
      const inputs = needs.reduce((sum, [need, n]) => sum + n * valueOf(need) * pp(need), 0);
      out[code] = (valueOf(code) * pp(code) - inputs) / it.productionPoints;
    }
    return out;
  }

  // Value of a card over the employee's remaining working life. `memo`
  // holds work shared by the cards of one pool (same employee and context).
  function cardValue(e, c, ctx, depth = 1, memo = {}) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    if (c.card === 'reroll') return trainingOutlook(e, ctx, { depth, memo }).value;
    if (c.card === 'secondWind') return secondWindValue(e, c, ctx, depth, null, memo);
    let v = traitCardValue(e, c, ctx, memo);
    if (v === undefined) {
      const h = hourlyGain(e, c, ctx);
      v = h === null ? null : h * hoursLeft(e);
    }
    if (v === null) return null;
    if (c.card === 'drill' && c.stat === 'luck') v += futureLuckValue(e, c.delta, ctx, memo);
    const after = afterCard(e, c);
    return after ? v + peerShift(e, after, ctx) : v;
  }

  /* ── Standing among coworkers ────────────────────────────────
   * Four traits compare the employee with their coworkers: Rival and
   * Mentor on Production after ordinary traits, before peer effects, Prima Donna and
   * Envious on wage. A card that changes Production or the wage can flip
   * them, the employee's own and their coworkers'. With the coworkers
   * known (situation.peers, and situation.coworkerModels for theirs),
   * a card's value includes that.
   */
  const PEER_TRAITS = ['rival', 'mentor', 'primaDonna', 'envious'];
  const wagePP = e => paidPph(e) * e.wageExpectation;   // hourly wage, in PP

  // The employee after a card, if it changes Production or the wage; else null.
  function afterCard(e, c) {
    if (c.card === 'wildCard') return null;
    const next = cardOutcomes(e, c)[0]?.employee;
    if (!next || next.production === e.production && next.wageExpectation === e.wageExpectation
      && JSON.stringify(next.traits) === JSON.stringify(e.traits)) return null;
    return next;
  }

  // What going from e to e2 does to the standing traits: the employee's own
  // (those kept), and each coworker's, with this employee's Production and
  // wage swapped into their peers.
  function peerShift(e, e2, ctx) {
    let total = 0;
    const kept = (e2.traits || []).filter(t => PEER_TRAITS.includes(t.code));
    for (const t of kept) {
      total += traitValue(t.code, e2, ctx, { held: true, arg: t.arg }).value - traitValue(t.code, e, ctx, { held: true, arg: t.arg }).value;
    }
    const me = { production: comparisonProduction(e2, ctx.situation), model: e2, situation: ctx.situation, wagePP: wagePP(e2), self: true };
    for (const cw of ctx.situation?.coworkerModels || []) {
      const theirs = (cw.e.traits || []).filter(t => PEER_TRAITS.includes(t.code));
      if (!theirs.length) continue;
      const cs = cw.ctx.situation;
      const moved = { ...cw.ctx, situation: { ...cs, peers: (cs.peers || []).map(p => p.self ? me : p) } };
      for (const t of theirs) {
        total += traitValue(t.code, cw.e, moved, { held: true, arg: t.arg }).value - traitValue(t.code, cw.e, cw.ctx, { held: true, arg: t.arg }).value;
      }
    }
    return total;
  }

  // Second Wind +gain is gain extra trainings: the draw spent a potential
  // whichever card is picked, so that cost is shared by the whole hand.
  // They come after the potential already left, so each is worth a training
  // made that many days later, when less working life remains.
  // potentialLeft counts sessions after this draw.
  // Each is priced like any training: the whole card pool, trait cards too.
  // Each also spends 10 energy that would earn ctx.energyValue elsewhere
  // on the day it happens, so it counts only what it adds over that, and 0
  // if it adds nothing.
  function secondWindValue(e, c, ctx, depth, price = null, memo = {}) {
    if (depth <= 0) return 0;
    const days = workingDays(e);
    if (!days) return 0;
    // Value if trained today: the same for every Second Wind in a pool.
    const outlooks = price ? null : memo.secondWind ??= new Map();
    let perTraining = outlooks?.get(depth);
    if (perTraining === undefined) {
      perTraining = trainingOutlook(e, ctx, { price, depth: depth - 1, memo }).value;
      outlooks?.set(depth, perTraining);
    }
    let total = 0;
    for (let j = 1; j <= c.gain; j++) {
      const daysUntil = (e.potentialLeft + j) / e.trainingsPerDay;
      total += Math.max(0, perTraining * Math.max(0, days - daysUntil) / days - energyOn(ctx, daysUntil));
    }
    return total;
  }

  // What 10 energy earns elsewhere `day` days from now: ctx.energyValue,
  // a number or a list by day (the last entry holds after it).
  function energyOn(ctx, day) {
    const v = ctx.energyValue;
    if (!Array.isArray(v)) return v || 0;
    return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.floor(day)))] || 0 : 0;
  }

  function rarityOdds(luck, management) {
    const w = { ...CFG.rarityWeights };
    let moved = 0;
    for (const r of RARITIES.slice(1)) {
      const s = CFG.managementShift[r] * Math.max(0, management) + CFG.luckShift[r] * Math.max(0, luck);
      w[r] += s; moved += s;
    }
    w.common = Math.max(0, w.common - moved);
    const total = RARITIES.reduce((a, r) => a + w[r], 0);
    return Object.fromEntries(RARITIES.map(r => [r, w[r] / total]));
  }

  // A one-step forecast: extra Luck changes the rarity of the remaining draws.
  // Their values exclude further Luck forecasts and Second Wind recursion.
  // The pool is the same for every Luck card in a pool, so `memo` keeps it.
  // A fresh hand is worth what Reroll is, which itself moves with Luck, so
  // each Luck re-solves it from the other cards.
  function futureLuckValue(e, delta, ctx = {}, memo = {}) {
    if (ctx.futureTraining === false || !delta) return 0;
    const days = workingDays(e), count = Math.max(0, e.potentialLeft || 0);
    if (days <= 0 || !count) return 0;
    // Trait values don't depend on futureTraining, so the pool's carry over.
    const pool = memo.luckPool ??= (p => ({ ...p, uncommon: p.uncommon.filter(c => c.card !== 'reroll') }))(
      cardPool(e, { ...ctx, futureTraining: false }, { depth: 0, memo: { traits: traitsOf(memo) } }));
    const mean = luck => rerollValue(pool, { luck }, { management: ctx.management || 0 });
    const gain = mean(e.luck + delta) - mean(e.luck);
    let total = 0;
    for (let k = 1; k <= count; k++) total += gain * Math.max(0, days - k / (e.trainingsPerDay || 1)) / days;
    return total;
  }

  // Expected value of one training: rarity roll, then the best of a random
  // hand of 3 from that rarity's priced cards (exact over all hands).
  function expectedTrainingValue(e, ctx, depth = 0, price = null) {
    const odds = rarityOdds(e.luck, ctx.management);
    let total = 0;
    for (const r of RARITIES) {
      const vals = NUMERIC_CARDS[r].map(c => price ? price(c) : cardValue(e, c, ctx, depth)).filter(v => v !== null);
      total += odds[r] * expectedBestOfHand(vals, CFG.handSize);
    }
    return total;
  }

  function expectedBestOfHand(vals, k) {
    if (!vals.length) return 0;
    if (vals.length <= k) return Math.max(...vals);
    let sum = 0, n = 0;
    const pick = (start, chosen) => {
      if (chosen.length === k) { sum += Math.max(...chosen); n++; return; }
      for (let i = start; i < vals.length; i++) pick(i + 1, [...chosen, vals[i]]);
    };
    pick(0, []);
    return sum / n;
  }

  function cardLabel(c) {
    if (c.card === 'reroll') return `Reroll: new hand, worth ~${Math.round(c.value)} PP`;
    if (c.card === 'traitProd') return `${c.name} (${c.detail})`;
    if (c.card === 'drill') return `${c.stat} +${c.delta}`;
    if (c.card === 'negotiation') return `negotiation −${Math.round(c.drop * 100)}%`;
    return `second wind +${c.gain}`;
  }

  // Ranked priced cards for one rarity, best first.
  function rankTier(rarity, e, ctx) {
    return NUMERIC_CARDS[rarity]
      .map(c => ({ ...c, label: cardLabel(c), value: cardValue(e, c, ctx) }))
      .filter(c => c.value !== null)
      .sort((a, b) => b.value - a.value);
  }

  // Ranks an actual hand (any priced cards), best first.
  function rankHand(cards, e, ctx) {
    return cards
      .map(c => {
        const value = c.trait ? null : cardValue(e, c, ctx);
        return { ...c, label: c.trait ? `${c.name} (${c.detail})` : cardLabel({ ...c, value }), value };
      })
      .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  }

  // Trait cards depend on which trait, so they can't be priced. They sit at
  // a fixed place in their tier: before the card named in `before`, or last.
  const TRAIT_CARDS = {
    rare:      [trait('rehab', 'Rehab', 'other negative trait', 'secondWind'),
                trait('wildCard', 'Wild Card', 'random trait, +2 stat', null)],
    epic:      [trait('habit', 'Habit', 'other positive trait', 'responsibility')],
    legendary: [trait('habitPair', 'Habit pair', 'other positive traits', 'responsibility'),
                trait('rehabAll', 'Rehab All', 'every negative trait', 'responsibility')],
  };
  function trait(card, name, detail, before) { return { card, name, detail, before, trait: true }; }
  const isRehab = c => c.card === 'rehab' || c.card === 'rehabAll';
  const anchorKey = c => c.card === 'drill' ? c.stat : c.card;

  // The quick reference's scenarios. Each flag swaps in an employee for whom
  // that warning holds, and the model re-ranks the priced cards.
  const LADDER_FLAGS = {
    thinMargin: { wageExpectation: 1.18 },          // bonus +24% − expectation +18% = 6%, below 5% × Production 3
    retiring:   { age: 60, potentialLeft: 5 },      // potential outlasts the 5 working days left
    badTrait:   {},                                 // Rehab first; no change to the priced cards
  };

  // Ranked cards per rarity for a set of flags, best first. A card is
  // `skip` when it's worth nothing (Second Wind past retirement) and `moved`
  // when a flag lifted it above its place in the unflagged ladder.
  function ladder(flags = []) {
    const e = Object.assign({}, ...flags.map(f => LADDER_FLAGS[f]));
    const base = flags.length ? ladder([]) : null;
    const out = {};
    for (const r of RARITIES) {
      let cards = [...(PROD_TRAIT_CARDS[r] || []), ...NUMERIC_CARDS[r]]
        .map(c => ({ ...c, label: cardLabel(c), value: cardValue(e, c, {}) }))
        .filter(c => c.value !== null)
        .sort((a, b) => b.value - a.value);
      for (const t of TRAIT_CARDS[r] || []) {
        const at = flags.includes('badTrait') && isRehab(t) ? 0
          : t.before ? cards.findIndex(c => anchorKey(c) === t.before) : -1;
        cards.splice(at < 0 ? cards.length : at, 0, { ...t, label: `${t.name} (${t.detail})` });
      }
      cards.forEach(c => { c.skip = c.card === 'secondWind' && c.value === 0; });
      cards = [...cards.filter(c => !c.skip), ...cards.filter(c => c.skip)];
      if (base) {
        // Compare the priced cards without the newly skipped ones, so cards
        // that only rose because a skipped one sank, or because a trait card
        // kept its fixed place, don't count as moved. Of the trait cards,
        // only Rehab moves, when a bad trait lifts it.
        const sunk = new Set(cards.filter(c => c.skip).map(c => c.label));
        const was = base[r].filter(c => !c.trait && !sunk.has(c.label)).map(c => c.label);
        const now = cards.filter(c => !c.trait && !c.skip);
        cards.forEach(c => { c.moved = c.trait ? flags.includes('badTrait') && isRehab(c) : now.indexOf(c) < was.indexOf(c.label); });
      }
      out[r] = cards;
    }
    return out;
  }

  /* ── Traits ────────────────────────────────────────────────
   * Each trait is priced like a card: the PP it adds (or costs) over the
   * working life, for this employee in this situation. `hourly(x)` is its
   * effect on one hour of one working day; x has the helpers below and that
   * day's age and tenure. Effects are the game's trait table.
   * Percent effects add to the production bonus.
   * Coworker effects count every coworker, each assumed to make what this
   * employee makes.
   */
  const DEFAULT_SITUATION = {
    gender: 'male',
    engineDailyProd: 0,         // raw Automated Engine PP/day
    engineBonus: 0,             // company production bonus, as a fraction
    coworkers: 2,               // Break Room level 3, the top, holds 3 employees
    femaleCoworkers: 1,         // of the coworkers
    sameNationalityCoworkers: null,
    homeCore: null,
    otherNationalities: 0,      // distinct coworker nationalities other than the employee's
    strongerCoworker: true,     // a coworker with more Production after ordinary traits
    weakerCoworker: true,
    peers: null,                // the coworkers, if known: [{ production, wagePP }] (after ordinary traits,
                                // hourly wage in PP); then they decide stronger, weaker and betterPaid
    coworkerModels: null,       // each coworker as { e, ctx }, their peers marking this employee self: true
    coworkerIds: [],
    betterPaid: 0,              // coworkers paid more
    coworkerHappiness: null,    // their average happiness today; null = unknown, so gains aren't capped
    place: 'homeCore',          // 'homeCore' | 'home' (home country, not core) | 'abroad'
    itemType: 'product',        // what the company makes: 'raw' | 'product'
    product: null,              // its item code, for Specialist
    incomeTax: 0,               // %
    tenureDays: 0,              // days in this company
    employedDays: 0,            // days since hired; moves don't reset it
    hasTool: false,
    smallStorage: false,        // storage level ≤ 2
    storageFull: false,
  };

  // A capped "n × each" (cap has the sign of each).
  const per = (n, each, cap) => cap < 0 ? Math.max(cap, n * each) : Math.min(cap, n * each);
  const STAT_ARGS = ['production', 'responsibility', 'luck'];

  // [code, name, polarity, roll weight, when, hourly, extra]. `arg`: the
  // trait takes a stat or good when gained. Diamond rolls its stat;
  // Specialist takes the company's good. `unpriced`: its payoff isn't output or wages.
  const TRAITS = [
    ['handy', 'Handy', 'positive', 5, '+40% output while holding a tool', x => x.s.hasTool ? x.pct(40) : 0],
    ['improviser', 'Improviser', 'positive', 5, '+25% output without a tool', x => x.s.hasTool ? 0 : x.pct(25)],
    ['nationalist', 'Nationalist', 'positive', 10, '+6 and +5 happiness with a coworker of the same nationality', x => (x.s.sameNationalityCoworkers ?? (x.s.coworkers && !x.s.otherNationalities)) ? x.resp(2) + x.happy(5) : 0],
    ['xenophobe', 'Xenophobe', 'negative', 10, '−2 Production and −5 happiness with a coworker of another nationality', x => x.s.otherNationalities ? x.prod(-2) + x.happy(-5) : 0],
    ['cosmopolitan', 'Cosmopolitan', 'positive', 10, '+2 Prod per other nationality, cap +4', x => x.prod(per(x.s.otherNationalities, 2, 4))],
    ['talksToMachines', 'Talks to Machines', 'positive', 5, 'Doubles Automated Engine output while the holder is the only employee', x => x.s.coworkers === 0 ? x.engine() : 0],
    ['loner', 'Loner', 'positive', 5, '+100% output and +5 happiness as the sole employee', x => x.s.coworkers ? 0 : x.pct(100) + x.happy(5)],
    ['sociable', 'Sociable', 'mixed', 10, '+25% output per coworker, capped at +50%; −10 happiness alone', x => x.s.coworkers ? x.pct(per(x.s.coworkers, 25, 50)) : x.happy(-10)],
    ['comic', 'Comic', 'mixed', 10, '−1 Prod, coworkers +10 happiness; multiple Comics do not stack', x => x.s.coworkers ? x.prod(-1) + x.teamHappy(10) : 0],
    ['mentor', 'Mentor', 'mixed', 2, 'a coworker with lower Production before peer effects gains +2 Production; self −1 Production', x => x.s.weakerCoworker ? x.teamProd(2) + x.prod(-1) : 0],
    ['foreman', 'Foreman', 'positive', 5, 'coworkers +9 happiness', x => x.s.coworkers ? x.teamResp(3) : 0],
    ['rival', 'Rival', 'mixed', 5, '+3 Production with a stronger coworker before peer effects; −1 otherwise; no effect alone', x => x.s.coworkers ? x.prod(x.s.strongerCoworker ? 3 : -1) : 0],
    ['primaDonna', 'Prima Donna', 'mixed', 5, '+20% output if highest paid; otherwise −10 happiness; no effect alone', x => x.s.coworkers ? (x.s.betterPaid ? x.happy(-10) : x.pct(20)) : 0],
    ['bully', 'Bully', 'negative', 5, '+2 Prod, coworkers −10 happiness', x => x.s.coworkers ? x.prod(2) + x.teamHappy(-10) : 0],
    ['envious', 'Envious', 'negative', 10, '−5 happiness per better-paid coworker', x => x.happy(per(x.s.betterPaid, -5, -10))],
    ['oldFriends', 'Old Friends', 'positive', 2, '+15% output while the linked employee is present', x => x.pct(15), { partner: true }],
    ['nemesis', 'Nemesis', 'negative', 2, '−15% output while the linked employee is present', x => x.pct(-15), { partner: true }],
    ['sweethearts', 'Sweethearts', 'positive', 0, '+20% output while the linked employee is present', x => x.pct(20), { partner: true }],
    ['girlPower', 'Girl Power', 'positive', 5, '+15% output per female coworker, capped at +30%', x => x.pct(per(x.s.femaleCoworkers, 15, 30)), { gender: 'female' }],
    ['bandOfBrothers', 'Band of Brothers', 'positive', 5, '+15% output per male coworker, capped at +30%', x => x.pct(per(x.male, 15, 30)), { gender: 'male' }],
    ['manHater', 'Man Hater', 'negative', 5, '−15% output per male coworker, capped at −30%', x => x.pct(per(x.male, -15, -30)), { gender: 'female' }],
    ['misogynist', 'Misogynist', 'negative', 5, '−15% output per female coworker, capped at −30%', x => x.pct(per(x.s.femaleCoworkers, -15, -30)), { gender: 'male' }],
    ['specialist', 'Specialist', 'positive', 10, "+3 Production and +5 happiness when producing its good; takes the company's good when gained", x => x.arg === 'match' || (x.arg && x.arg === x.s.product) ? x.prod(3) + x.happy(5) : 0, { arg: 'good' }],
    ['craftsman', 'Craftsman', 'mixed', 10, '+3 Prod on products, −1 on raw', x => x.prod(x.s.itemType === 'raw' ? -1 : 3)],
    ['laborer', 'Laborer', 'mixed', 10, '+3 Prod on raw, −1 on products', x => x.prod(x.s.itemType === 'raw' ? 3 : -1)],
    ['quickStudy', 'Quick Study', 'positive', 10, 'specialization grows 2× as fast', x => x.quickStudy],
    ['stockpiler', 'Stockpiler', 'positive', 10, 'ignores the storage-full penalty', x => x.s.storageFull ? x.happy(10) : 0],
    ['claustrophobe', 'Claustrophobe', 'negative', 5, '−20% output at storage level 2 or below', x => x.s.smallStorage ? x.pct(-20) : 0],
    ['veteran', 'Veteran', 'positive', 5, '+20% output after 30 days in the company', x => x.tenure >= 30 ? x.pct(20) : 0],
    ['creatureOfHabit', 'Creature of Habit', 'negative', 10, '−30% output for 3 days after a move', () => 0],
    ['diamondInTheRough', 'Diamond in the Rough', 'positive', 2, '+1 to its randomly assigned stat per 10 days in the same company, capped at +4',
      x => x.stat(x.arg, Math.min(4, Math.floor(x.tenure / 10))), { arg: 'stat' }],
    ['burnout', 'Burnout', 'negative', 2, '−1 all stats per 20 days, cap −3',
      x => { const k = -Math.min(3, Math.floor(x.tenure / 20)); return x.prod(k) + x.resp(k) + x.luck(k); }],
    ['lateBloomer', 'Late Bloomer', 'positive', 5, '+2 Production per 10 years over age 40, capped at +6', x => x.prod(Math.min(6, 2 * Math.floor(Math.max(0, x.age - 40) / 10)))],
    ['earlyBloomer', 'Early Bloomer', 'positive', 5, '+6 Production below age 40, then −2 per 10 years, none from 60', x => x.prod(Math.max(0, 6 - 2 * Math.floor(Math.max(0, x.age - 30) / 10)))],
    ['wornOut', 'Worn Out', 'negative', 10, '−2 Production per 10 years over age 50, capped at −6', x => x.prod(-Math.min(6, 2 * Math.floor(Math.max(0, x.age - 50) / 10)))],
    ['patriot', 'Patriot', 'positive', 10, '+2 Production and +10 happiness in a core region of their home country', x => (x.s.homeCore ?? x.s.place === 'homeCore') ? x.prod(2) + x.happy(10) : 0],
    ['homesick', 'Homesick', 'negative', 10, '−2 Production and −10 happiness outside their home country', x => x.s.place === 'abroad' && !x.s.homeCore ? x.prod(-2) + x.happy(-10) : 0],
    ['expat', 'Expat', 'positive', 10, '+2 Production outside their home country', x => x.s.place === 'abroad' ? x.prod(2) : 0],
    ['taxShy', 'Tax Shy', 'negative', 10, '−1% output per income tax percentage point, capped at −30%', x => x.pct(-Math.min(30, x.s.incomeTax))],
    ['statist', 'Statist', 'positive', 10, '+6 happiness when income tax is at least 20%', x => x.s.incomeTax >= 20 ? x.resp(2) : 0],
    // Held, the wage already includes it; gained, it applies on top.
    ['greedy', 'Greedy', 'negative', 10, 'wage +20%', x => x.wage(x.held ? 1 - 1 / 1.2 : 0.2)],
    ['modest', 'Modest', 'positive', 10, 'wage −15%', x => x.wage(x.held ? 1 - 1 / 0.85 : -0.15)],
    ['climber', 'Climber', 'negative', 10, 'wage expectation +0.02 per week employed', x => x.raise(Math.floor(x.employed / 7) - Math.floor(x.s.employedDays / 7))],
    ['loyal', 'Loyal', 'positive', 5, 'halves happiness losses', x => -x.happy(-x.loss / 2)],
    ['flightRisk', 'Flight Risk', 'negative', 10, 'quits below 50 happiness, not 30', null, { unpriced: 'raises the chance of losing the employee' }],
    ['anchor', 'Anchor', 'mixed', 5, 'never quits; −50% output while unhappy', null, { partial: 'protection against quitting is not priced' }],
    ['scavenger', 'Scavenger', 'mixed', 2, '2× toolbox chance, −25% output', x => x.pct(-25) + x.boxes(toolboxRate(x.e.luck))],
    ['salvager', 'Salvager', 'positive', 5, 'loots with storage full', x => x.s.storageFull ? x.boxes(toolboxRate(x.e.luck)) : 0],
    ['gambler', 'Gambler', 'mixed', 10, '+3 Luck, −15% output', x => x.luck(3) + x.pct(-15)],
    ['luckyCharm', 'Lucky Charm', 'positive', 5, 'coworkers +3 Luck', x => x.s.coworkers * x.luck(3)],
    ['jinx', 'Jinx', 'negative', 10, 'coworkers −2 Luck', x => x.s.coworkers * x.luck(-2)],
    ['recruiter', 'Recruiter', 'positive', 2, '+1 candidate slot', null, { unpriced: 'more candidates to hire from' }],
    ['trainer', 'Trainer', 'positive', 5, 'coworkers +2 trainings a day', null, { unpriced: 'additional coworker training requires a roster and energy budget' }],
  ].map(([code, name, polarity, weight, when, hourly, extra]) => ({ code, name, polarity, weight, when, hourly, ...extra }));
  const TRAIT = Object.fromEntries(TRAITS.map(t => [t.code, t]));
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

  // An employee can't hold both of a pair.
  const EXCLUSIVE = [
    ['handy', 'improviser'],
    ['talksToMachines', 'sociable'],
    ['talksToMachines', 'comic'],
    ['talksToMachines', 'foreman'],
    ['talksToMachines', 'mentor'],
    ['talksToMachines', 'trainer'],
    ['talksToMachines', 'luckyCharm'],
    ['loner', 'sociable'],
    ['cosmopolitan', 'xenophobe'],
    ['comic', 'bully'],
    ['craftsman', 'laborer'],
    ['expat', 'homesick'],
    ['statist', 'taxShy'],
    ['diamondInTheRough', 'burnout'],
    ['greedy', 'modest'],
    ['flightRisk', 'anchor'],
    ['luckyCharm', 'jinx'],
    ['scavenger', 'handy'],
    ['nationalist', 'cosmopolitan'],
    ['loyal', 'flightRisk'],
    ['lateBloomer', 'wornOut'],
    ['earlyBloomer', 'lateBloomer'],
    ['veteran', 'burnout'],
    ['foreman', 'bully'],
    ['mentor', 'bully'],
    ['primaDonna', 'modest'],
    ['climber', 'modest'],
    ['envious', 'modest'],
    ['patriot', 'expat'],
    ['xenophobe', 'expat'],
    ['stockpiler', 'claustrophobe'],
    ['loner', 'comic'],
    ['loner', 'foreman'],
    ['loner', 'mentor'],
    ['loner', 'trainer'],
    ['loner', 'luckyCharm'],
  ];
  const conflicts = (a, b) => EXCLUSIVE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  // Traits a Habit (positive) or Wild Card (any) could give.
  function eligibleTraits(heldCodes, gender, polarities) {
    return TRAITS.filter(t => !t.partner && polarities.includes(t.polarity) && !heldCodes.includes(t.code)
      && !heldCodes.some(h => conflicts(h, t.code)) && (!t.gender || t.gender === gender));
  }
  function wildCardRisk(heldCodes, gender) {
    const pool = eligibleTraits(heldCodes, gender, ['positive', 'mixed', 'negative']);
    return pool.length ? pool.filter(t => t.polarity === 'negative').length / pool.length : null;
  }
  const HABIT_POLARITY = { epic: 'positive', legendary: 'positive' };

  // Known arguments stay fixed. Diamond rolls each stat equally; a gained
  // Specialist takes the company's good, or a match if the product is unknown.
  function traitArgs(t, arg, s, held = false) {
    if (!t.arg || arg) return [{ arg, p: 1 }];
    if (t.arg === 'stat') return STAT_ARGS.map(a => ({ arg: a, p: 1 / 3 }));
    return [{ arg: held ? null : s.product || 'match', p: 1 }];
  }

  // { value, outcomes: [{ arg, p, value }], wageBase } over the working life;
  // value is the expected PP, null if unpriced. `held` prices having it now
  // (Rehab is minus that). With CFG.traitProductionPaid the trait's own flat
  // Production is paid (never Rival's or Mentor's), so value includes that
  // wage at e.wageExpectation;
  // wageBase is the paid Production it adds, in output points over the
  // working life, so the value at another expectation w is
  // value + (e.wageExpectation − w) × wageBase.
  function traitValue(code, e, ctx = {}, { arg = null, held = false } = {}) {
    const t = TRAIT[code];
    if (!t || t.unpriced) return { value: null, outcomes: [], wageBase: 0, note: t?.unpriced };
    if (code === 'anchor') {
      const loss = (e.happiness ?? 50) < 30 ? -0.5 * pph({ ...DEFAULT_EMPLOYEE, ...e }) * (ctx.sellRatio ?? 1) * hoursLeft(e) : 0;
      return { value: loss, outcomes: [], wageBase: 0, note: t.partial };
    }
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    if (t.partner && !s.coworkerIds.includes(arg)) return { value: 0, outcomes: [], wageBase: 0 };
    if (s.peers) {
      const own = wagePP(e);
      s.betterPaid = s.peers.filter(p => p.wagePP > own + 1e-9).length;
    }
    const B = careerBonus(e), sr = ctx.sellRatio;
    // A coworker's output before bonuses, the base their happiness scales;
    // they work in the same company, so with about the same bonus.
    const coworkerBase = ctx.coworkerOutput != null ? ctx.coworkerOutput / (1 + B) : pph(e) * sr;
    // Held, the happiness is already in today's value, so none of it is capped.
    const gain = (n, h) => held ? n : happyGain(n, h);
    let productionBase = e.production;
    let happyRecipients = s.coworkers;
    const paid = CFG.traitProductionPaid && !UNPAID_PRODUCTION.has(code);
    let paidToday = 0;
    const base = {
      e, s, held, male: Math.max(0, s.coworkers - s.femaleCoworkers), loss: e.happinessLoss,
      // Production never drops below 1, so a loss only counts down to it.
      // The wage is assumed to follow the same floor.
      prod: d => {
        const points = (Math.max(1, productionBase + d) - Math.max(1, productionBase)) / CFG.outputDivisor;
        if (!paid) return points * (1 + B) * sr;
        paidToday += points;
        return points * ((1 + B) * sr - e.wageExpectation);
      },
      engine: () => s.engineDailyProd / 24 * (1 + s.engineBonus) * sr,
      pct: p => pph(e) * p / 100 * sr,
      happy: h => pph(e) * sr * gain(h, e.happiness) / 100,
      resp: d => pph(e) * sr * gain(CFG.respHappiness * d, e.happiness) / 100,
      luck: d => (toolboxRate(e.luck + d) - toolboxRate(e.luck)) * ctx.toolboxValue,
      boxes: rate => rate * ctx.toolboxValue,
      wage: f => -paidPph(e) * e.wageExpectation * f,
      raise: k => -paidPph(e) * 0.02 * k * wageTraitMultiplier(e),   // k × +0.02 wage expectation
      teamHappy: h => happyRecipients * coworkerBase * gain(h, s.coworkerHappiness) / 100,
      teamProd: d => (s.peers ? s.weakerCount : Number(s.weakerCoworker))
        * d / CFG.outputDivisor * (1 + B) * sr,
      teamResp: d => s.coworkers * coworkerBase * gain(CFG.respHappiness * d, s.coworkerHappiness) / 100,
      quickStudy: pph(e) * (careerBonus(e, 2) - B) * sr,
    };
    base.stat = (stat, k) => stat === 'production' ? base.prod(k) : stat === 'responsibility' ? base.resp(k) : base.luck(k);
    // A day's ordinary Production and standing among the coworkers. They only
    // change on the days peerSteps finds, so each stretch is worked out once,
    // and kept for other trait values of the same employee in the same
    // situation (a card pool asks for dozens).
    const days = workingDays(e);
    const steps = peerSteps(e, s, days);
    const others = e.traits ? { ...e, traits: e.traits.filter(t => t.code !== code) } : e;
    // A day's state depends on the trait only when the employee holds it
    // (it is left out of their ordinary Production) or for the three that
    // patch it below; other traits share one set of stretches.
    const own = code === 'comic' || code === 'rival' || code === 'mentor' || (e.traits || []).some(t => t.code === code);
    const prefix = `${own ? code : '*'}|${JSON.stringify([e.production, e.age, e.nationality, e.traits])}|${
      JSON.stringify(s, (k, v) => k === 'coworkerModels' ? undefined : v)}|`;
    let stretches = DAY_STATES.get(prefix);
    if (!stretches) {
      if (DAY_STATES.size >= 4000) DAY_STATES.delete(DAY_STATES.keys().next().value);
      DAY_STATES.set(prefix, stretches = new Map());
    }
    const dayState = d => {
      let st = stretches.get(steps[d]);
      if (st) return st;
      st = { productionBase: ordinaryProduction(others, s, d), happyRecipients: null, patch: null, peerProduction: null };
      if (s.peers) {
        const own = comparisonProduction(e, s, d);
        const activePeers = s.peers.filter(p => !p.model || d < workingDays(p.model));
        const peers = activePeers.map(p => p.model ? comparisonProduction(p.model, p.situation, d) : p.production);
        st.happyRecipients = code === 'comic' && activePeers.every(p => p.model?.traits)
          ? activePeers.filter(recipient => !activePeers.some(other => other !== recipient
            && other.model.traits.some(t => t.code === 'comic'))).length : activePeers.length;
        st.patch = { coworkers: peers.length };
        const nationality = e.nationality || s.nationality;
        if (nationality && activePeers.every(p => p.model?.nationality)) {
          Object.assign(st.patch, nationalitySituation(nationality, activePeers.map(p => p.model)));
        }
        Object.assign(st.patch, productionStanding(own, peers));
        if (code === 'rival' || code === 'mentor') {
          // Settled with the day's standing in place, as the hourly pass sees it.
          const saved = { ...s };
          Object.assign(s, st.patch);
          const row = (model, situation, production) => ({
            production: model ? ordinaryProduction(model, situation, d) : production,
            rival: model?.traits?.some(t => t.code === 'rival') || false,
            mentor: model?.traits?.some(t => t.code === 'mentor') || false,
          });
          const subject = row(e, s);
          const coworkers = activePeers.map(p => row(p.model, p.situation, p.production));
          const without = peerProduction([{ ...subject, [code]: false }, ...coworkers]);
          const withTrait = peerProduction([{ ...subject, [code]: true }, ...coworkers]);
          // Production only: the stretch is shared by employees and markets
          // that differ in career bonus and sell ratio, applied on use.
          st.peerProduction = withTrait.reduce((v, production, i) => v + production - without[i], 0);
          Object.assign(s, saved);
        }
      }
      stretches.set(steps[d], st);
      return st;
    };
    const outcomes = traitArgs(t, arg, s, held).map(({ arg: a, p }) => {
      let total = 0, wageBase = 0;
      // The trait rules only read what they are handed: one record, its
      // day fields set afresh.
      const x = { ...base, arg: a, age: 0, tenure: 0, employed: 0 };
      for (let d = 0; d < days; d++) {
        const st = dayState(d);
        productionBase = st.productionBase;
        if (st.patch) {
          happyRecipients = st.happyRecipients;
          Object.assign(s, st.patch);
          if (st.peerProduction != null) { total += st.peerProduction / CFG.outputDivisor * (1 + B) * sr * 24; continue; }
        }
        x.age = e.age + d; x.tenure = s.tenureDays + d; x.employed = s.employedDays + d;
        paidToday = 0;
        total += t.hourly(x) * 24;
        wageBase += paidToday * 24;
      }
      return { arg: a, p, value: total, wageBase };
    });
    return { value: outcomes.reduce((a, o) => a + o.p * o.value, 0), outcomes: outcomes.length > 1 ? outcomes : [],
      wageBase: outcomes.reduce((a, o) => a + o.p * o.wageBase, 0) };
  }

  // For each working day, the first day of its stretch: a day on which
  // ordinaryProduction or the peer standing can change. Those depend on day
  // d only through who has retired and each model's age and tenure in whole
  // decades (age and tenure traits step at multiples of 10), so a stretch
  // starts wherever one of those moves. Computed with the same arithmetic
  // the traits use.
  function peerSteps(e, s, days) {
    const decades = [], retire = [];
    const tenureOf = sit => sit && Object.hasOwn(sit, 'tenureDays') ? sit.tenureDays : DEFAULT_SITUATION.tenureDays;
    decades.push(e.age, s.tenureDays + 1e-9);
    for (const p of s.peers || []) {
      if (!p.model) continue;
      retire.push(workingDays(p.model));
      decades.push(p.model.age, tenureOf(p.situation) + 1e-9);
      for (const q of p.situation?.peers || []) if (q.model) retire.push(workingDays(q.model));
    }
    const steps = new Array(days);
    let start = 0;
    for (let d = 0; d < days; d++) {
      if (d && (decades.some(x => Math.floor((x + d) / 10) !== Math.floor((x + d - 1) / 10))
        || retire.some(a => (d < a) !== (d - 1 < a)))) start = d;
      steps[d] = start;
    }
    return steps;
  }
  // Day states by trait, employee and situation, then by stretch (see traitValue).
  const DAY_STATES = new Map();

  // Rival and Mentor compare a frozen pass of ordinary stat effects. Neither
  // their self effects nor incoming Mentor bonuses participate in this pass.
  function comparisonProduction(e, situation = {}, day = 0) {
    return Math.max(1, ordinaryProduction(e, situation, day));
  }

  // Preserve the raw sum when pricing a stat change. Flooring this baseline
  // early would overvalue positive effects on employees below Production 1.
  function ordinaryProduction(e, situation = {}, day = 0) {
    const s = { ...DEFAULT_SITUATION, ...situation };
    if (s.peers) {
      const active = s.peers.filter(p => !p.model || day < workingDays(p.model));
      s.coworkers = active.length;
      const nationality = e.nationality || s.nationality;
      if (nationality && active.every(p => p.model?.nationality)) {
        Object.assign(s, nationalitySituation(nationality, active.map(p => p.model)));
      }
    }
    let production = e.production;
    const noop = () => 0;
    const prod = n => { production += n; return 0; };
    const x = { e, s, age: e.age + day, tenure: s.tenureDays + day + 1e-9, held: true,
      male: s.coworkers - s.femaleCoworkers, prod, pct: noop, happy: noop, resp: noop,
      luck: noop, boxes: noop, wage: noop, raise: noop, teamHappy: noop, teamProd: noop,
      engine: noop, teamResp: noop, quickStudy: 0, loss: 0 };
    x.stat = (stat, n) => stat === 'production' ? prod(n) : 0;
    for (const t of e.traits || []) {
      if (['rival', 'mentor'].includes(t.code)) continue;
      TRAIT[t.code]?.hourly?.({ ...x, arg: t.arg });
    }
    return production;
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

  // Inputs are raw ordinary stat sums, before either peer trait. Freeze the
  // comparisons, apply all self and teammate effects, then floor final output.
  function peerProduction(rows) {
    const basis = rows.map(r => Math.max(1, r.production));
    return rows.map((row, i) => {
      let stronger = false, weaker = false, mentors = 0;
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue;
        if (basis[j] > basis[i]) { stronger = true; if (rows[j].mentor) mentors++; }
        else if (basis[j] < basis[i]) weaker = true;
      }
      const rival = row.rival && rows.length > 1 ? stronger ? 3 : -1 : 0;
      const mentor = row.mentor && weaker ? -1 : 0;
      return Math.max(1, row.production + rival + mentor + 2 * mentors);
    });
  }

  // Values for the trait cards. e.traits is what the employee holds:
  // [{ code, arg }]. removeTrait is the chart's hypothetical removal, not a dealt card.
  // A pool's cards share the employee and context: each gained trait's
  // value is worked out once (memo.traits).
  const traitsOf = memo => memo.traits ??= new Map();
  const gainedTrait = (code, e, ctx, memo) => {
    const known = memo && traitsOf(memo);
    if (known?.has(code)) return known.get(code);
    const value = traitValue(code, e, ctx).value;
    known?.set(code, value);
    return value;
  };
  function traitCardValue(e, c, ctx, memo = null) {
    const held = e.traits || [];
    const s = { ...DEFAULT_SITUATION, ...ctx?.situation };
    const v = (code, opts) => opts ? traitValue(code, e, ctx, opts).value : gainedTrait(code, e, ctx, memo);
    if (c.card === 'habit') return c.code ? v(c.code) : null;
    if (c.card === 'rehab' || c.card === 'removeTrait') {
      if (!c.code || c.card === 'rehab' && TRAIT[c.code]?.polarity !== 'negative') return null;
      const x = v(c.code, { held: true, arg: held.find(h => h.code === c.code)?.arg });
      return x === null ? null : -x;
    }
    if (c.card === 'mentoring') {
      // One held trait moved up its ladder: the next step, valued without
      // the trait it replaces, less the held trait.
      if (!c.code || !c.to) return null;
      const from = v(c.code, { held: true, arg: held.find(h => h.code === c.code)?.arg });
      const to = traitValue(c.to, { ...e, traits: held.filter(h => h.code !== c.code) }, ctx).value;
      return from === null || to === null ? null : to - from;
    }
    if (c.card === 'habitPair') {
      const xs = (c.codes || []).map(code => v(code));
      return xs.length === 2 && xs.every(x => x !== null) ? xs[0] + xs[1] : null;
    }
    if (c.card === 'rehabAll') {
      return held.filter(h => TRAIT[h.code]?.polarity === 'negative')
        .reduce((a, h) => a - (v(h.code, { held: true, arg: h.arg }) ?? 0), 0);
    }
    if (c.card === 'wildCard') {
      // A random eligible trait, good or bad (unpriced ones count as 0), and
      // +2 to a random stat.
      const pool = eligibleTraits(held.map(h => h.code), s.gender, ['positive', 'mixed', 'negative']);
      const traitAvg = pool.reduce((a, t) => a + (v(t.code) ?? 0), 0) / (pool.length || 1);
      const statAvg = STAT_ARGS.reduce((a, st) => a + cardValue(e, drill(st, CFG.wildCardStatGain), ctx), 0) / 3;
      return traitAvg + statAvg;
    }
    return undefined;
  }

  // A Wild Card's outcomes, the trait and the stat priced apart (as its
  // value is): [{ p, value, arg, unpriced }]. Unpriced traits count as 0.
  function wildCardOutcomes(e, ctx = {}) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    const pool = eligibleTraits((e.traits || []).map(h => h.code), s.gender, ['positive', 'mixed', 'negative']);
    const stats = STAT_ARGS.map(st => cardValue(e, drill(st, CFG.wildCardStatGain), ctx));
    return pool.flatMap(t => {
      const v = traitValue(t.code, e, ctx).value;
      return stats.map(x => ({ p: 1 / (3 * pool.length), value: (v ?? 0) + x, arg: t.code, unpriced: v === null }));
    });
  }

  // Resolved transitions, shared by projected hands and outlooks. Each roll
  // applies all changes together before its placement is valued. The wage
  // follows paid Production: a Production gain, or a trait's flat Production
  // in ctx.situation, moves it; wageExpectation (per paid point) stays.
  function cardOutcomes(e, c, ctx = {}) {
    if (c.card === 'reroll') return [];
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    const held = e.traits || [];
    if (c.card === 'rehab' && TRAIT[c.code]?.polarity !== 'negative') return [];
    const gain = c.card === 'habit' ? [c.code] : c.card === 'habitPair' ? c.codes || [] : c.card === 'mentoring' ? [c.to] : [];
    const remove = c.card === 'rehab' || c.card === 'removeTrait' || c.card === 'mentoring' ? [c.code] : c.card === 'rehabAll'
      ? held.filter(t => TRAIT[t.code]?.polarity === 'negative').map(t => t.code) : [];
    let rolls = [{ p: 1, traits: held.filter(t => !remove.includes(t.code)), arg: null }];
    const add = (rows, code) => rows.flatMap(row => {
      if (!TRAIT[code] || row.traits.some(t => t.code === code)) return [row];
      const t = TRAIT[code];
      const args = traitArgs(t, c.arg, s);
      return args.map(a => ({ p: row.p * a.p, arg: a.arg || code,
        traits: [...row.traits, { code, ...(a.arg ? { arg: a.arg } : {}) }] }));
    });
    for (const code of gain) rolls = add(rolls, code);
    if (c.card === 'wildCard') {
      const pool = eligibleTraits(held.map(t => t.code), s.gender, ['positive', 'mixed', 'negative']);
      rolls = pool.flatMap(t => add(rolls, t.code).map(r => ({ ...r, p: r.p / pool.length })));
    }
    // The flat Production the employee's ordinary traits give today.
    const ownProduction = traits => ordinaryProduction({ ...e, traits }, s) - e.production;
    const heldProduction = ownProduction(held);
    return rolls.flatMap(r => (c.card === 'wildCard' ? STAT_ARGS : [c.stat]).map(stat => {
      const next = { ...e, traits: r.traits };
      const delta = c.card === 'wildCard' ? CFG.wildCardStatGain : c.card === 'drill' ? c.delta : 0;
      if (delta) next[stat] = (e[stat] || 0) + delta;
      next.traitProduction = (e.traitProduction || 0) + ownProduction(r.traits) - heldProduction;
      const paidRatio = paidProduction(next) / paidProduction(e);
      let factor = 1;
      for (const [code, m] of [['greedy', 1.2], ['modest', 0.85]]) {
        if (!held.some(t => t.code === code) && r.traits.some(t => t.code === code)) factor *= m;
        if (held.some(t => t.code === code) && !r.traits.some(t => t.code === code)) factor /= m;
      }
      const raiseFactor = factor * paidRatio;
      if (c.card === 'negotiation') factor *= Math.max(0, e.wageExpectation - c.drop * wageTraitMultiplier(e)) / e.wageExpectation;
      if (Number.isFinite(e.wage)) next.wage = e.wage * factor * paidRatio;
      next.wageExpectation = e.wageExpectation * factor;
      if (c.card === 'negotiation' && e.negotiationExpectation != null) next.negotiationExpectation = Math.round(1000 * (e.negotiationExpectation - c.drop)) / 1000;
      const climbs = r.traits.some(t => t.code === 'climber');
      const wageTrait = r.traits.some(t => t.code === 'greedy') ? 1.2 : r.traits.some(t => t.code === 'modest') ? 0.85 : 1;
      next.climberRaise = !climbs ? 0 : e.climberRaise ? e.climberRaise * raiseFactor
        : paidProduction(next) / 4 * (ctx.ppValue || 1) * 0.02 * wageTrait;
      return { p: r.p / (c.card === 'wildCard' ? 3 : 1), arg: r.arg, employee: next };
    }));
  }

  // Each trait's value for this employee, best first. `unit` is +1 trait
  // Production over the working life (its margin over the wage when paid),
  // for scaling tiers; no ratio when that margin isn't positive.
  function traitChart(e, ctx = {}) {
    const held = e.traits || [];
    const unit = traitUnit(e, ctx);
    return TRAITS.filter(t => t.weight > 0 || held.some(h => h.code === t.code)).map(t => {
      const h = held.find(x => x.code === t.code);
      const r = traitValue(t.code, e, ctx, { held: !!h, arg: h?.arg });
      return { ...t, ...r, held: !!h, ratio: r.value === null || !(unit > 0) ? null : r.value / unit };
    }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }
  function traitUnit(e, ctx) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    return hourlyGain(e, { card: 'traitProd', delta: 1 }, ctx) * hoursLeft(e);
  }

  /* ── Energy: one training against one hire ───────────────────
   * Both cost 10 energy, so the feed ranks them on what each adds over
   * the working life, in PP.
   */

  // Every card a training could deal this employee now, priced, by rarity
  // (the game's training card pool). Unpriced traits count as 0.
  // e.potentialMax, if given, keeps Second Wind within the cap.
  function cardPool(e, ctx = {}, { price = null, depth = 1, memo = {} } = {}) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    const held = e.traits || [];
    const codes = held.map(h => h.code);
    const value = c => (price ? price(c) : cardValue(e, c, ctx, depth, memo)) ?? 0;
    const traitV = {};
    const tv = code => (traitV[code] ??= (price ? price({ card: 'habit', code }) : gainedTrait(code, e, ctx, memo)) ?? 0);
    const pool = Object.fromEntries(RARITIES.map(r => [r, []]));
    for (const r of RARITIES) {
      for (const c of NUMERIC_CARDS[r]) {
        if (c.card === 'secondWind' && e.potentialMax != null && e.potentialMax + c.gain > CFG.potentialMaxCap) continue;
        const v = price ? price(c) : cardValue(e, c, ctx, depth, memo);
        if (v !== null) pool[r].push({ ...c, value: v });
      }
    }
    for (const h of held) {
      const pol = TRAIT[h.code]?.polarity;
      if (pol === 'negative') {
        const c = { card: 'rehab', code: h.code };
        pool.rare.push({ ...c, value: value(c) });
      }
    }
    if (held.filter(h => TRAIT[h.code]?.polarity === 'negative').length >= 2) {
      pool.legendary.push({ card: 'rehabAll', value: value({ card: 'rehabAll' }) });
    }
    const positives = eligibleTraits(codes, s.gender, ['positive']);
    for (const t of positives) pool.epic.push({ card: 'habit', code: t.code, value: tv(t.code) });
    for (let i = 0; i < positives.length; i++) {
      for (let j = i + 1; j < positives.length; j++) {
        const a = positives[i].code, b = positives[j].code;
        if (!conflicts(a, b)) pool.legendary.push({ card: 'habitPair', codes: [a, b], value: price ? price({ card: 'habitPair', codes: [a, b] }) ?? tv(a) + tv(b) : tv(a) + tv(b) });
      }
    }
    if (eligibleTraits(codes, s.gender, ['positive', 'mixed', 'negative']).length) {
      pool.rare.push({ card: 'wildCard', value: value({ card: 'wildCard' }) });
    }
    pool.uncommon.push({ card: 'reroll', value: rerollValue(pool, e, ctx) });
    return pool;
  }

  // On each interval between Uncommon card values, E[new hand] = a + bR.
  // Hands containing Reroll contribute max(R, best of the other k-1 cards).
  function rerollValue(pool, e, ctx) {
    const odds = rarityOdds(e.luck, ctx.management);
    const k = CFG.handSize;
    const open = RARITIES.filter(r => pool[r].length + (r === 'uncommon' ? 1 : 0) >= k);
    const norm = open.reduce((sum, r) => sum + odds[r], 0);
    if (!norm) return 0;
    const p = open.includes('uncommon') ? odds.uncommon / norm : 0;
    const vals = pool.uncommon.map(c => c.value).sort((a, b) => a - b);
    const n = vals.length + 1;
    const choose = (n, k) => {
      let v = 1;
      for (let i = 0; i < k; i++) v *= (n - i) / (i + 1);
      return v;
    };
    let a = open.filter(r => r !== 'uncommon').reduce((sum, r) =>
      sum + odds[r] / norm * expectedMax(pool[r].map(c => c.value), k), 0)
      + p * (n - k) / n * expectedMax(vals, k);
    const maxima = vals.slice(k - 2).map((value, j) => ({ value,
      p: p * choose(j + k - 2, k - 2) / choose(n, k) }));
    a += maxima.reduce((sum, x) => sum + x.p * x.value, 0);
    let b = 0;
    for (const x of maxima) {
      const value = a / (1 - b);
      if (value <= x.value) return value;
      a -= x.p * x.value;
      b += x.p;
    }
    // Every hand holds Reroll (Uncommon alone, 3 cards): rerolling gains nothing.
    return b < 1 - 1e-12 ? a / (1 - b) : vals[vals.length - 1];
  }

  // Expected best of k cards dealt from vals without replacement: sorted
  // ascending, the i-th is the best with probability C(i, k−1) / C(n, k).
  function expectedMax(vals, k) {
    const v = [...vals].sort((a, b) => a - b);
    const n = v.length;
    if (!n) return 0;
    if (n <= k) return v[n - 1];
    let w = 1, total = 0;   // w = C(i, k−1) / C(n, k), built up from i = k−1
    for (let i = 0; i < k; i++) w *= (k - i) / (n - i);
    for (let i = k - 1; i < n; i++) {
      total += w * v[i];
      w *= (i + 1) / (i + 2 - k);
    }
    return total;
  }

  // What the next training is worth on average: the rarity roll (only
  // among rarities with a full hand of cards), then the best of the hand
  // dealt. { value, rarities: [{ rarity, p, value, cards }] }.
  function trainingOutlook(e, ctx = {}, options = {}) {
    const full = { ...DEFAULT_EMPLOYEE, ...e };
    const pool = cardPool(full, ctx, options);
    const odds = rarityOdds(full.luck, ctx.management ?? DEFAULT_CONTEXT.management);
    const open = RARITIES.filter(r => pool[r].length >= CFG.handSize);
    const norm = open.reduce((a, r) => a + odds[r], 0) || 1;
    const rarities = open.map(r => ({
      rarity: r, p: odds[r] / norm, cards: pool[r].length,
      value: expectedMax(pool[r].map(c => c.value), CFG.handSize),
    }));
    return { value: rarities.reduce((a, x) => a + x.p * x.value, 0), rarities };
  }

  // The average value of one trait rolled at hire, by roll weight, priced
  // for e (partner traits count 0: no partner). Gendered traits only roll
  // for their gender; `genders` lists the ones possible, equally likely.
  // Held traits and those they rule out can't roll.
  function rolledTraitValue(e, ctx, genders = ['male', 'female']) {
    return genders.reduce((a, gender) => a + rolledTraits(e, ctx, gender).reduce((b, t) => b + t.p * t.value, 0) / genders.length, 0);
  }
  // Each trait that can roll for this gender: [{ code, p, value, wageBase }]
  // (traitValue's wageBase: value moves with the wage expectation).
  function rolledTraits(e, ctx, gender) {
    const held = (e.traits || []).map(t => t.code);
    const rollable = TRAITS.filter(t => t.weight && (!t.gender || t.gender === gender)
      && !held.includes(t.code) && !held.some(h => conflicts(h, t.code)));
    const gctx = { ...ctx, situation: { ...ctx.situation, gender } };
    const weights = rollable.reduce((a, t) => a + t.weight, 0);
    return rollable.map(t => {
      const v = t.partner ? null : traitValue(t.code, e, gctx);
      return { code: t.code, p: t.weight / weights, value: v?.value ?? 0, wageBase: v?.wageBase || 0 };
    });
  }
  // The paid flat Production a trait gained at hire gives on day one: it
  // shows in the wage on the candidate's card (0 unless CFG.traitProductionPaid).
  function hireProduction(code, age, situation) {
    const t = TRAIT[code];
    if (!CFG.traitProductionPaid || !t?.hourly || t.partner || UNPAID_PRODUCTION.has(code)) return 0;
    const s = { ...DEFAULT_SITUATION, ...situation };
    const arg = traitArgs(t, null, s)[0].arg;
    return ordinaryProduction({ age, nationality: s.nationality, production: 0, traits: [{ code, ...(arg ? { arg } : {}) }] }, s);
  }

  /* ── Recruiting ────────────────────────────────────────────
   * A candidate shows age, gender, nationality, all three stats and the
   * wage; the trait (always one) and potential only after hire.
   */
  const HIRE = { minStat: 1, maxStat: 4, minPotential: 3, maxPotential: 10, minAge: 18, maxAge: 45, avgStat: 2.5 };
  const WAGE_MULT = { greedy: 1.2, modest: 0.85 };
  // A hire's happiness: neutral 50, +3 a point of Responsibility, less the
  // company's lasting losses, within 0 to 100. The bonus a hire is given
  // leaves happiness out, so each point above 50 adds 1% to it.
  const hireHappiness = (responsibility, loss) =>
    Math.max(0, Math.min(CFG.happinessMax, 50 + CFG.respHappiness * responsibility - loss));
  const withHappiness = (bonus, happiness) => bonus + (happiness - 50) / 100;
  const wageMult = code => WAGE_MULT[code] || 1;

  // How likely a wage reading x = expectation × m is for a trait with wage
  // multiplier m: Greedy/Modest × paid ÷ shown Production (when the trait's
  // flat Production is paid). The expectation is uniform on 70% to 130%, so
  // x is uniform on m × that range, with density ∝ 1/m.
  function wageFit(x, m) {
    const ex = x / m;
    return ex >= CFG.wageFloor - 1e-6 && ex <= 2 - CFG.wageFloor + 1e-6 ? 1 / m : 0;
  }
  // The roll weights of a hidden trait given the wage reading x: Greedy,
  // Modest and flat Production traits move the wage, so the wage hints at
  // them (above 130% only those raising it fit). With no trait fitting,
  // the plain roll weights. [{ code, p, mult, … }].
  function traitsGivenWage(list, x) {
    const fit = list.map(t => t.p * wageFit(x, t.mult));
    const total = fit.reduce((a, v) => a + v, 0);
    return total ? list.map((t, i) => ({ ...t, p: fit[i] / total })).filter(t => t.p > 0) : list;
  }

  // The trainings an employee's potential holds, net of what the same
  // energy would earn elsewhere (`alt`, PP per 10 energy). Training k
  // happens k days in, when that much less working life is left. A
  // training worth less than alt counts 0: the energy goes elsewhere.
  function potentialValue(e, ctx, potential, alt, trainingValue) {
    const days = workingDays(e);
    if (!days || !potential) return 0;
    const o = trainingValue ?? trainingOutlook(e, ctx).value;
    let total = 0;
    for (let k = 0; k < potential; k++) {
      total += Math.max(0, o * Math.max(0, days - k / (e.trainingsPerDay || 1)) / days - alt);
    }
    return total;
  }
  const POTENTIALS = Array.from({ length: HIRE.maxPotential - HIRE.minPotential + 1 }, (_, i) => HIRE.minPotential + i);

  // A typed-in candidate over their working life, in PP. cand: { age,
  // gender, wagePP (hourly wage ÷ V), production, responsibility, luck }.
  // The trait and potential are hidden: one trait by roll weight, given
  // what the wage says about it (Greedy, Modest and flat Production move
  // the wage), and potential 3 to 10.
  // ctx.situation is the company seen from this candidate. `alt` prices
  // the energy a training uses; `bonus` is the company's, without
  // happiness. { value, output, trait, potential, happiness,
  // wageExpectation (per paid point, averaged over the trait), odds: { greedy,
  // modest }, spread }. spread is every way they could turn out, over the
  // trait and potential: [{ p, value }].
  function candidateValue(cand, ctx = {}, { bonus = 0, happinessLoss = DEFAULT_EMPLOYEE.happinessLoss, alt = 0 } = {}) {
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const production = cand.production ?? HIRE.avgStat;
    const gender = cand.gender === 'female' ? 'female' : 'male';
    // The wage reading: wage ÷ (Production/4 × V). When the hidden trait's
    // flat Production is paid too, the expectation per paid point (Greedy
    // and Modest folded in, as the model's is) depends on the trait.
    const reading = 4 * (cand.wagePP || 0) / production;
    const responsibility = cand.responsibility ?? HIRE.avgStat;
    const happiness = hireHappiness(responsibility, happinessLoss);
    const e = {
      ...DEFAULT_EMPLOYEE, age: cand.age, production, traitProduction: 0, extraProduction: 0,
      responsibility, luck: cand.luck ?? HIRE.avgStat, bonus: withHappiness(bonus, happiness), happiness,
      specialization: 0, wageExpectation: reading, happinessLoss, traits: [], trainingsPerDay: 1,
    };
    const hours = hoursLeft(e);
    const situation = { ...ctx.situation, gender };
    const rolls = traitsGivenWage(rolledTraits(e, ctx, gender).map(t => {
      const paid = Math.max(1, production + hireProduction(t.code, e.age, situation));
      return { ...t, paid, mult: wageMult(t.code) * paid / production };
    }), reading).map(t => {
      const w = reading * production / t.paid;
      // Its own output and wage; the trait priced at that expectation. Greedy
      // and Modest are already in the wage, so they add nothing more.
      const output = hourlyProfit({ ...e, wageExpectation: w }, ctx) * hours;
      const value = WAGE_MULT[t.code] ? 0 : t.value + (reading - w) * t.wageBase;
      return { ...t, w, output, value };
    });
    const mean = k => rolls.reduce((a, t) => a + t.p * t[k], 0);
    const output = mean('output'), trait = mean('value'), wageExpectation = mean('w');
    const pots = POTENTIALS.map(n => potentialValue({ ...e, wageExpectation }, ctx, n, alt));
    const potential = pots.reduce((a, v) => a + v, 0) / pots.length;
    const p = code => rolls.find(t => t.code === code)?.p || 0;
    // Each trait by its odds, each potential equally likely.
    const spread = rolls.flatMap(t => pots.map(v => ({ p: t.p / pots.length, value: t.output + t.value + v })));
    return { value: output + trait + potential, output, trait, potential, happiness, wageExpectation, odds: { greedy: p('greedy'), modest: p('modest') }, spread };
  }

  // What a fresh set of candidates is worth when the pick sees only what a
  // card shows: age, gender, nationality, Production, Responsibility and
  // wage, never the trait or potential. Each candidate is drawn at random:
  // a group by weight, either gender, Production and Responsibility 1 to 4
  // (Responsibility sets their happiness), expectation 70% to 130%, age
  // 18 to 45, potential 3 to 10, one trait by roll weight (Greedy ×1.2 and
  // Modest ×0.85 on the wage, and its flat Production if paid). Each is valued
  // twice: as the card reads (the trait by its odds given the wage,
  // potential averaged) and as they turn out. The pick
  // is the best-reading of `slots`, so a set is worth what its pick turns
  // out to be on average, and beat(bar) is how often that beats bar.
  // groups: [{ weight, ctx, bonus, happinessLoss, key, coworkers }], one per
  // nationality; groups sharing a `key` share the newcomer's own value.
  // coworkers(production, wagePP, gender) is what such a newcomer does to
  // the coworkers' traits. Traits are priced at age 31 and scaled by
  // working days, like the trainings.
  // A slot outlives whoever holds it: when they retire, the next hire
  // takes over. So a candidate is also charged `rate` PP for each working
  // day they hold the slot, what it earns anyway, and the pick is the best
  // surplus, not the longest working life. rate 'slot' solves for the
  // slot's own rate, where the pick earns its 10 energy (alt) and no more.
  // { best (the pick's surplus), gross (its value), days, rate, average,
  // coworkers, beat(bar) on the surplus }.
  const OWN_TABLES = new Map();
  const WAGE_GRID = Array.from({ length: 11 }, (_, i) => 0.6 + i * 0.1);   // expectation × Greedy/Modest
  // The newcomer's own tables for a company setting, apart from the
  // trainings' surplus over alt. A generator, so a page can build them a
  // few steps at a time (freshSetWarm); freshSetValue runs it to the end.
  const ownKey = g => JSON.stringify([{ ...DEFAULT_CONTEXT, ...g.ctx }, g.bonus || 0, g.happinessLoss ?? DEFAULT_EMPLOYEE.happinessLoss]);
  function* ownTables(g) {
    const ctx = { ...DEFAULT_CONTEXT, ...g.ctx };
    const hire = { ...DEFAULT_EMPLOYEE, extraProduction: 0, bonus: g.bonus || 0, specialization: 0, happinessLoss: g.happinessLoss ?? DEFAULT_EMPLOYEE.happinessLoss, traits: [], trainingsPerDay: 1 };
    const ages = HIRE.maxAge - HIRE.minAge + 1;
    const mid = { ...hire, age: 31, production: HIRE.avgStat, wageExpectation: 1 };
    const midDays = workingDays(mid);
    // Per age: output per paid point before wages (by Responsibility),
    // hours left, working days.
    const gross = [], hours = [], days = [];
    for (let R = HIRE.minStat; R <= HIRE.maxStat; R++) gross[R] = [];
    for (let a = 0; a < ages; a++) {
      const e = { ...hire, age: HIRE.minAge + a, production: CFG.outputDivisor, wageExpectation: 0 };
      for (let R = HIRE.minStat; R <= HIRE.maxStat; R++) {
        gross[R].push(hourlyProfit({ ...e, bonus: withHappiness(hire.bonus, hireHappiness(R, hire.happinessLoss)) }, ctx));
      }
      hours.push(hoursLeft(e)); days.push(workingDays(e));
    }
    // A training's value a day, by Production.
    const perDay = [];
    for (let P = HIRE.minStat; P <= HIRE.maxStat; P++) {
      perDay[P] = trainingOutlook({ ...mid, production: P }, ctx).value / midDays;
      yield;
    }
    // Rollable traits by gender, each priced by Production at age 31 at
    // expectation 1 (wageBase moves it to another), with the flat
    // Production it gives at each hiring age.
    const traits = {};
    for (const gender of ['male', 'female']) {
      const situation = { ...ctx.situation, gender };
      const gctx = { ...ctx, situation };
      const list = [];
      for (const t of TRAITS.filter(t => t.weight && (!t.gender || t.gender === gender))) {
        const priced = [0, 1, 2, 3, 4].map(P => !P || t.partner || WAGE_MULT[t.code] ? null
          : traitValue(t.code, { ...mid, production: P }, gctx));
        list.push({ code: t.code, weight: t.weight, mult: wageMult(t.code),
          value: priced.map(v => v?.value ?? 0), wageBase: priced.map(v => v?.wageBase || 0),
          production: Array.from({ length: ages }, (_, a) => hireProduction(t.code, HIRE.minAge + a, situation)) });
        yield;
      }
      const total = list.reduce((a, t) => a + t.weight, 0);
      // Traits that read alike on the card, by age and Production: the same
      // wage multiplier and paid Production. k = Production ÷ paid
      // Production; weight, value and wageBase are summed over the traits.
      const groups = Array.from({ length: ages }, (_, a) => [0, 1, 2, 3, 4].map(P => {
        if (!P) return [];
        const byKey = new Map();
        for (const t of list) {
          const paid = Math.max(1, P + t.production[a]);
          const key = `${t.mult}|${paid}`;
          let g = byKey.get(key);
          if (!g) byKey.set(key, g = { m: t.mult * paid / P, k: P / paid, weight: 0, value: 0, wageBase: 0 });
          g.weight += t.weight; g.value += t.weight * t.value[P]; g.wageBase += t.weight * t.wageBase[P];
        }
        return [...byKey.values()];
      }));
      traits[gender] = { list, total, groups };
    }
    const base = { gross, hours, days, perDay, traits, midDays };
    if (OWN_TABLES.size >= 200) OWN_TABLES.delete(OWN_TABLES.keys().next().value);
    OWN_TABLES.set(ownKey(g), base);
    return base;
  }
  const runToEnd = it => { for (;;) { const r = it.next(); if (r.done) return r.value; } };
  // Builds the tables a fresh set over these groups will need, yielding
  // between steps. With a memoised coworkers(), it warms that grid too.
  function* freshSetWarm(groups) {
    for (const g of Array.isArray(groups) ? groups : [groups || {}]) {
      if (!OWN_TABLES.has(ownKey(g))) yield* ownTables(g);
      if (!g.coworkers) continue;
      for (const gender of ['male', 'female']) for (let P = 1; P <= 4; P++) {
        for (const x of WAGE_GRID) g.coworkers(P, P / CFG.outputDivisor * x, gender);
        yield;
      }
    }
  }
  function freshSetValue(groups, { alt = 0, slots = 3, draws = 6000, seed = 1, rate = 0 } = {}) {
    if (!Array.isArray(groups)) groups = [groups || {}];
    const ages = HIRE.maxAge - HIRE.minAge + 1;
    const wageGrid = WAGE_GRID;
    const own = new Map();
    const tables = groups.map(g => {
      const key = g.key ?? own.size;
      // The newcomer's own tables, apart from the trainings' surplus over
      // alt, depend only on these, so sets priced for other employees in
      // the same setting reuse them.
      let base = !own.has(key) && OWN_TABLES.get(ownKey(g));
      if (!own.has(key) && !base) base = runToEnd(ownTables(g));
      if (!own.has(key)) {
        // Trainings by Production, age and potential, above what 10 energy earns.
        const pot = [];
        for (let P = HIRE.minStat; P <= HIRE.maxStat; P++) {
          pot[P] = base.days.map(d => {
            const byN = [0];
            for (let k = 0; k < HIRE.maxPotential; k++) byN.push(byN[k] + Math.max(0, base.perDay[P] * Math.max(0, d - k) - alt));
            return byN;
          });
        }
        own.set(key, { ...base, pot });
      }
      // What a newcomer does to the coworkers, by gender, Production and wage.
      const cw = {};
      for (const gender of ['male', 'female']) {
        cw[gender] = [0, 1, 2, 3, 4].map(P => P && g.coworkers
          ? wageGrid.map(x => g.coworkers(P, P / CFG.outputDivisor * x, gender)) : null);
      }
      return { weight: g.weight ?? 1, own: own.get(key), cw };
    });
    const coworkerAt = (row, x) => {
      if (!row) return 0;
      const f = Math.max(0, Math.min(wageGrid.length - 1, (x - wageGrid[0]) / 0.1));
      const i = Math.min(wageGrid.length - 2, Math.floor(f));
      return row[i] + (row[i + 1] - row[i]) * (f - i);
    };
    const weights = tables.reduce((a, t) => a + t.weight, 0);
    const pots = HIRE.maxPotential - HIRE.minPotential + 1;
    // A fixed seed: the same team always gets the same numbers.
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const cands = [];
    let coworkerSum = 0;
    for (let d = 0; d < draws; d++) {
      let r = rand() * weights, g = tables[0];
      for (const t of tables) { if ((r -= t.weight) < 0) { g = t; break; } }
      const { gross, hours, days, pot, traits, midDays } = g.own;
      const gender = rand() < 0.5 ? 'male' : 'female';
      const P = HIRE.minStat + Math.floor(rand() * (HIRE.maxStat - HIRE.minStat + 1));
      const R = HIRE.minStat + Math.floor(rand() * (HIRE.maxStat - HIRE.minStat + 1));
      const expectation = CFG.wageFloor + rand() * 0.6;
      const a = Math.floor(rand() * ages);
      const n = HIRE.minPotential + Math.floor(rand() * pots);
      const T = traits[gender];
      let tr = rand() * T.total, trait = T.list[0];
      for (const t of T.list) { if ((tr -= t.weight) < 0) { trait = t; break; } }
      const scale = days[a] / midDays;
      // w is the expectation per paid point; the card reads x, the wage
      // ÷ (Production/4 × V), which holds the trait's paid Production.
      const w = expectation * trait.mult;
      const x = w * Math.max(1, P + trait.production[a]) / P;
      const cw = coworkerAt(g.cw[gender][P], x);
      coworkerSum += cw;
      // Output and coworkers alike for every trait; then the wage on P, and
      // the trait with its own wage at w (its value is at expectation 1).
      const fixed = P / CFG.outputDivisor * gross[R][a] * hours[a] + cw;
      const own = (w, weight, value, wageBase) => -P / CFG.outputDivisor * w * hours[a] * weight + (value + (1 - w) * wageBase) * scale;
      const value = fixed + own(w, 1, trait.value[P], trait.wageBase[P]) + pot[P][a][n];
      // As the card reads: each group of traits by how well it fits x.
      let fit = 0, read = 0;
      for (const grp of T.groups[a][P]) {
        const f = wageFit(x, grp.m) * grp.weight;
        if (f) { fit += f; read += wageFit(x, grp.m) * own(x * grp.k, grp.weight, grp.value, grp.wageBase); }
      }
      if (!fit) for (const grp of T.groups[a][P]) { fit += grp.weight; read += own(x * grp.k, grp.weight, grp.value, grp.wageBase); }
      const seen = fixed + read / fit + pot[P][a].slice(HIRE.minPotential).reduce((x, v) => x + v, 0) / pots;
      cands.push({ seen, value, days: days[a] });
    }
    // The k-th worst-reading of `draws` is the best of `slots` with
    // probability (k/draws)^slots − ((k−1)/draws)^slots.
    const pickAt = r => {
      const order = [...cands].sort((x, y) => (x.seen - r * x.days) - (y.seen - r * y.days));
      const picks = order.map((c, k) => ({ value: c.value - r * c.days, gross: c.value, days: c.days, p: ((k + 1) / draws) ** slots - (k / draws) ** slots }));
      const mean = k => picks.reduce((a, x) => a + x.p * x[k], 0);
      return { picks, best: mean('value'), gross: mean('gross'), days: mean('days') };
    };
    // The slot's rate and the pick depend on each other; a few rounds settle it.
    let r = rate === 'slot' ? 0 : rate, at = pickAt(r);
    for (let i = 0; rate === 'slot' && i < 4; i++) {
      r = Math.max(0, (at.gross - alt) / (at.days || 1));
      at = pickAt(r);
    }
    const picks = at.picks.sort((x, y) => x.value - y.value);
    return {
      best: at.best, gross: at.gross, days: at.days, rate: r,
      average: cands.reduce((a, c) => a + c.value - r * c.days, 0) / draws,
      coworkers: coworkerSum / draws,
      beat: bar => picks.reduce((a, x) => x.value > bar ? a + x.p : a, 0),
    };
  }

  return {
    toolboxRate, CFG, RARITIES, NUMERIC_CARDS, PROD_TRAIT_CARDS, TRAIT_CARDS, DEFAULT_EMPLOYEE, DEFAULT_CONTEXT, LADDER_FLAGS,
    TRAITS, TRAIT, DEFAULT_SITUATION, HABIT_POLARITY, EXCLUSIVE, currentTraits, ownTraitProduction, paidProduction,
    cardPool, cardOutcomes, gameDailyProfit, gameMargins, wildCardOutcomes, secondWindValue, energyOn, expectedMax, trainingOutlook, rolledTraitValue, futureLuckValue,
    potentialValue, candidateValue, freshSetValue, freshSetWarm,
    comparisonProduction, productionStanding, peerProduction, nationalitySituation, locationSituation, eligibleTraits, wildCardRisk, canNegotiate, traitValue, traitChart, traitUnit,
    drill, neg, wind, cardValue, rankTier, rankHand, rarityOdds, ladder,
    expectedTrainingValue, marginPerPoint, drillBeatsNegotiationBelow, hourlyProfit, careerBonus, workingDays,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = EmployeeCore;
  if (require.main === module) printReference();
}

// `node js/employee-core.js`: rankings for a few typical employees.
function printReference() {
  const { rankTier, RARITIES } = EmployeeCore;
  const scenarios = {
    'typical (exp 1.00, bonus +24%)': {},
    'thin margin (exp 1.18, bonus +24%)': { wageExpectation: 1.18 },
    'cheap (exp 0.80, bonus +24%)': { wageExpectation: 0.8 },
    'old (age 58, exp 1.00)': { age: 58 },
    'young, high potential (age 20, 8 left)': { age: 20, potentialLeft: 8 },
  };
  for (const [name, e] of Object.entries(scenarios)) {
    console.log(`\n== ${name}`);
    for (const r of RARITIES) {
      const row = rankTier(r, e, {}).map(c => `${c.label} (${c.value.toFixed(2)})`).join('  >  ');
      console.log(`  ${r.padEnd(10)} ${row}`);
    }
  }
}
