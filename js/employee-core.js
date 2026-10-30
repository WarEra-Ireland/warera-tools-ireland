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
 *    output = (P + extra)/4 × (1 + bonus) × sellRatio × V
 *    wage   = P/4 × wageExpectation × V
 *  P is the Production the wage is paid on: hired plus trained (the API's
 *  `base`). `extra` is Production from traits, which isn't paid for. Both
 *  checked against every employee's wage. So a
 *  Production drill earns only its margin over the wage it adds.
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
  // Trait cards that change Production can be priced: trait Production
  // isn't paid for, so each point is pure output. They only count while the
  // trait's condition holds (product type, coworkers, region, age).
  const PROD_TRAIT_CARDS = {
    rare:      [traitProd(3, 'Habit', '+3 Prod trait', 'Rival, Craftsman, Laborer'),
                traitProd(2, 'Rehab', '−2 Prod trait', 'Xenophobe, Homesick, Worn Out')],
    epic:      [traitProd(2, 'Habit', '+2 Prod trait', 'Patriot, Expat, Cosmopolitan')],
    legendary: [traitProd(4, 'Habit pair', '+4 Prod or more', 'two of Patriot, Expat, Cosmopolitan')],
  };
  function traitProd(delta, name, detail, examples) { return { card: 'traitProd', delta, name, detail, examples }; }
  function drill(stat, delta) { return { card: 'drill', stat, delta }; }
  function neg(drop) { return { card: 'negotiation', drop }; }
  function wind(gain) { return { card: 'secondWind', gain }; }

  const DEFAULT_EMPLOYEE = {
    age: 30, production: 3, responsibility: 2, luck: 2,
    extraProduction: 0,     // from traits; produces but isn't paid
    bonus: 0.24,            // production bonus as a fraction (+24%), today
    specialization: 20,     // % of the bonus that is specialization; 20 = maxed, no further growth
    wageExpectation: 1,     // wage ÷ (P/4 × V): 1 = market rate, Greedy/Modest folded in
    happinessLoss: 10,      // happiness points lost to tax, storage, moves… (Loyal halves them)
    happiness: null,        // today's happiness, 0 to 100; null = unknown, so gains aren't capped
    potentialLeft: 3,
    trainingsPerDay: 1,
  };
  const DEFAULT_CONTEXT = {
    sellRatio: 1,
    toolboxValue: 0,        // in points of production; unknown, so off by default
    management: 0,          // the owner's Management level, for training card rarity
  };

  const workingDays = e => Math.max(0, CFG.retireAge - e.age);
  const hoursLeft = e => workingDays(e) * 24;
  const pph = e => (e.production + e.extraProduction) / CFG.outputDivisor;   // output points per hour before bonuses
  const paidPph = e => e.production / CFG.outputDivisor;                     // the points the wage is paid on

  // Average bonus over the working days left: today's, plus the
  // specialization still to come (+1% a day until the cap).
  // Quick Study doubles the growth (rate 2).
  function careerBonus(e, rate = 1) {
    const days = workingDays(e);
    const room = Math.max(0, CFG.specializationMax - e.specialization);
    if (!days || !room) return e.bonus;
    let extra = 0;
    for (let k = 0; k < days; k++) extra += Math.min(room, k * rate);
    return e.bonus + extra / days / 100;
  }

  // Margin per point of paid Production, per hour, averaged over the working
  // days left: its output after bonuses minus the wage it adds.
  const marginPerPoint = (e, ctx) => (1 + careerBonus(e)) * ctx.sellRatio - e.wageExpectation;

  // The wage expectation below which a Production drill beats the
  // Negotiation of the same rarity (margin > 5% × paid Production).
  const drillBeatsNegotiationBelow = (e, ctx) => (1 + careerBonus(e)) * ctx.sellRatio - 0.05 * e.production;

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
    if (c.card === 'traitProd') return c.delta * (1 + careerBonus(e)) * ctx.sellRatio / CFG.outputDivisor;
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

  // Value of a card over the employee's remaining working life.
  function cardValue(e, c, ctx, depth = 1) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    if (c.card === 'secondWind') return secondWindValue(e, c, ctx, depth);
    let v = traitCardValue(e, c, ctx);
    if (v === undefined) {
      const h = hourlyGain(e, c, ctx);
      v = h === null ? null : h * hoursLeft(e);
    }
    if (v === null) return null;
    const after = afterCard(e, c);
    return after ? v + peerShift(e, after, ctx) : v;
  }

  /* ── Standing among coworkers ────────────────────────────────
   * Four traits compare the employee with their coworkers: Rival and
   * Mentor on hired + trained Production (before traits), Prima Donna and
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
    if (!next || next.production === e.production && next.wageExpectation === e.wageExpectation) return null;
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
    const me = { production: e2.production, wagePP: wagePP(e2), self: true };
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
  function secondWindValue(e, c, ctx, depth, price = null) {
    if (depth <= 0) return 0;
    const days = workingDays(e);
    if (!days) return 0;
    const perTraining = trainingOutlook(e, ctx, { price, depth: depth - 1 }).value;   // value if trained today
    let total = 0;
    for (let j = 1; j <= c.gain; j++) {
      const daysUntil = (e.potentialLeft + j) / e.trainingsPerDay;
      total += perTraining * Math.max(0, days - daysUntil) / days;
    }
    return total;
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
      .map(c => ({ ...c, label: c.trait ? `${c.name} (${c.detail})` : cardLabel(c), value: c.trait ? null : cardValue(e, c, ctx) }))
      .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  }

  // Trait cards depend on which trait, so they can't be priced. They sit at
  // a fixed place in their tier: before the card named in `before`, or last.
  const TRAIT_CARDS = {
    uncommon:  [trait('wildCard', 'Wild Card', 'random trait, +1 stat', 'responsibility')],
    rare:      [trait('rehab', 'Rehab', 'other negative trait', 'secondWind'),
                trait('habit', 'Habit', 'other mixed trait', null)],
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
    coworkers: 2,               // Break Room level 3, the top, holds 3 employees
    femaleCoworkers: 1,         // of the coworkers
    otherNationalities: 0,      // distinct coworker nationalities other than the employee's
    strongerCoworker: true,     // a coworker with more Production (hired + trained, before traits)
    weakerCoworker: true,
    peers: null,                // the coworkers, if known: [{ production, wagePP }] (hired + trained,
                                // hourly wage in PP); then they decide stronger, weaker and betterPaid
    coworkerModels: null,       // each coworker as { e, ctx }, their peers marking this employee self: true
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
    ['nationalist', 'Nationalist', 'positive', 10, '+2 Responsibility and +5 happiness when all coworkers share nationality', x => x.s.coworkers && !x.s.otherNationalities ? x.resp(2) + x.happy(5) : 0],
    ['xenophobe', 'Xenophobe', 'negative', 10, '−2 Production and −5 happiness with a coworker of another nationality', x => x.s.otherNationalities ? x.prod(-2) + x.happy(-5) : 0],
    ['cosmopolitan', 'Cosmopolitan', 'positive', 10, '+2 Prod per other nationality, cap +4', x => x.prod(per(x.s.otherNationalities, 2, 4))],
    ['loner', 'Loner', 'positive', 5, '+100% output and +5 happiness as the sole employee', x => x.s.coworkers ? 0 : x.pct(100) + x.happy(5)],
    ['sociable', 'Sociable', 'mixed', 10, '+25% output per coworker, capped at +50%; −10 happiness alone', x => x.s.coworkers ? x.pct(per(x.s.coworkers, 25, 50)) : x.happy(-10)],
    ['comic', 'Comic', 'mixed', 10, '−1 Prod, coworkers +10 happiness', x => x.s.coworkers ? x.prod(-1) + x.teamHappy(10) : 0],
    ['mentor', 'Mentor', 'mixed', 2, 'a coworker with lower hired + trained Production gains +2 Production; self −1 Production', x => x.s.weakerCoworker ? x.teamProd(2) + x.prod(-1) : 0],
    ['foreman', 'Foreman', 'positive', 5, 'coworkers +3 Resp', x => x.s.coworkers ? x.teamResp(3) : 0],
    ['rival', 'Rival', 'mixed', 5, '+3 Production with a coworker whose hired + trained Production is higher; −1 Production otherwise', x => x.prod(x.s.strongerCoworker ? 3 : -1)],
    ['primaDonna', 'Prima Donna', 'mixed', 5, 'highest-paid employee with coworkers: +20% output, −10 happiness', x => x.s.coworkers && !x.s.betterPaid ? x.pct(20) + x.happy(-10) : 0],
    ['bully', 'Bully', 'mixed', 5, '+2 Prod, coworkers −10 happiness', x => x.s.coworkers ? x.prod(2) + x.teamHappy(-10) : 0],
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
    ['patriot', 'Patriot', 'positive', 10, '+2 Production and +10 happiness in a core region of their home country', x => x.s.place === 'homeCore' ? x.prod(2) + x.happy(10) : 0],
    ['homesick', 'Homesick', 'negative', 10, '−2 Production and −10 happiness outside their home country', x => x.s.place === 'abroad' ? x.prod(-2) + x.happy(-10) : 0],
    ['expat', 'Expat', 'positive', 10, '+2 Production outside their home country', x => x.s.place === 'abroad' ? x.prod(2) : 0],
    ['taxShy', 'Tax Shy', 'negative', 10, '−1% output per income tax percentage point, capped at −30%', x => x.pct(-Math.min(30, x.s.incomeTax))],
    ['statist', 'Statist', 'positive', 10, '+2 Responsibility when income tax is at least 20%', x => x.s.incomeTax >= 20 ? x.resp(2) : 0],
    // Held, the wage already includes it; gained, it applies on top.
    ['greedy', 'Greedy', 'negative', 10, 'wage +20%', x => x.wage(x.held ? 1 - 1 / 1.2 : 0.2)],
    ['modest', 'Modest', 'positive', 10, 'wage −15%', x => x.wage(x.held ? 1 - 1 / 0.85 : -0.15)],
    ['climber', 'Climber', 'negative', 10, 'wage expectation +0.02 per week employed', x => x.raise(Math.floor(x.employed / 7) - Math.floor(x.s.employedDays / 7))],
    ['loyal', 'Loyal', 'positive', 5, 'halves happiness losses', x => -x.happy(-x.loss / 2)],
    ['flightRisk', 'Flight Risk', 'negative', 10, 'quits below 50 happiness, not 30', null, { unpriced: 'raises the chance of losing the employee' }],
    ['anchor', 'Anchor', 'mixed', 5, 'never quits; −50% output while unhappy', null, { unpriced: 'only matters while unhappy' }],
    ['scavenger', 'Scavenger', 'mixed', 2, '2× toolbox chance, −25% output', x => x.pct(-25) + x.boxes(toolboxRate(x.e.luck))],
    ['salvager', 'Salvager', 'positive', 5, 'loots with storage full', x => x.s.storageFull ? x.boxes(toolboxRate(x.e.luck)) : 0],
    ['gambler', 'Gambler', 'mixed', 10, '+3 Luck, −15% output', x => x.luck(3) + x.pct(-15)],
    ['luckyCharm', 'Lucky Charm', 'positive', 5, 'coworkers +3 Luck', x => x.s.coworkers * x.luck(3)],
    ['jinx', 'Jinx', 'negative', 10, 'coworkers −2 Luck', x => x.s.coworkers * x.luck(-2)],
    ['recruiter', 'Recruiter', 'positive', 2, '+1 candidate slot', null, { unpriced: 'more candidates to hire from' }],
    ['trainer', 'Trainer', 'positive', 5, 'coworkers +1 training a day', null, { unpriced: 'coworkers train twice as fast' }],
  ].map(([code, name, polarity, weight, when, hourly, extra]) => ({ code, name, polarity, weight, when, hourly, ...extra }));
  const TRAIT = Object.fromEntries(TRAITS.map(t => [t.code, t]));
  // Retired codes and what the game turned them into.
  const RENAMED_TRAITS = { sprinter: 'earlyBloomer' };
  const currentTraits = traits => (traits || []).map(t => RENAMED_TRAITS[t.code] ? { ...t, code: RENAMED_TRAITS[t.code] } : t);

  // An employee can't hold both of a pair.
  const EXCLUSIVE = [
    ['handy', 'improviser'],
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

  // Traits a Habit (positive or mixed) or Wild Card (any) could give.
  function eligibleTraits(heldCodes, gender, polarities) {
    return TRAITS.filter(t => !t.partner && polarities.includes(t.polarity) && !heldCodes.includes(t.code)
      && !heldCodes.some(h => conflicts(h, t.code)) && (!t.gender || t.gender === gender));
  }
  function wildCardRisk(heldCodes, gender) {
    const pool = eligibleTraits(heldCodes, gender, ['positive', 'mixed', 'negative']);
    return pool.length ? pool.filter(t => t.polarity === 'negative').length / pool.length : null;
  }
  const HABIT_POLARITY = { rare: 'mixed', epic: 'positive', legendary: 'positive' };

  // Known arguments stay fixed. Diamond rolls each stat equally; a gained
  // Specialist takes the company's good, or a match if the product is unknown.
  function traitArgs(t, arg, s, held = false) {
    if (!t.arg || arg) return [{ arg, p: 1 }];
    if (t.arg === 'stat') return STAT_ARGS.map(a => ({ arg: a, p: 1 / 3 }));
    return [{ arg: held ? null : s.product || 'match', p: 1 }];
  }

  // { value, outcomes: [{ arg, p, value }] } over the working life; value is
  // the expected PP, null if unpriced. `held` prices having it now (Rehab
  // is minus that).
  function traitValue(code, e, ctx = {}, { arg = null, held = false } = {}) {
    const t = TRAIT[code];
    if (!t || t.unpriced) return { value: null, outcomes: [], note: t?.unpriced };
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    if (s.peers) {
      const own = wagePP(e);
      s.strongerCoworker = s.peers.some(p => p.production > e.production);
      s.weakerCoworker = s.peers.some(p => p.production < e.production);
      s.betterPaid = s.peers.filter(p => p.wagePP > own + 1e-9).length;
    }
    const B = careerBonus(e), sr = ctx.sellRatio;
    // A coworker's output before bonuses, the base their happiness scales;
    // they work in the same company, so with about the same bonus.
    const coworkerBase = ctx.coworkerOutput != null ? ctx.coworkerOutput / (1 + B) : pph(e) * sr;
    // Held, the happiness is already in today's value, so none of it is capped.
    const gain = (n, h) => held ? n : happyGain(n, h);
    const base = {
      e, s, held, male: Math.max(0, s.coworkers - s.femaleCoworkers), loss: e.happinessLoss,
      // Production never drops below 1, so a loss only counts down to it.
      prod: d => (Math.max(1, e.production + d) - Math.max(1, e.production)) / CFG.outputDivisor * (1 + B) * sr,
      pct: p => pph(e) * p / 100 * sr,
      happy: h => pph(e) * sr * gain(h, e.happiness) / 100,
      resp: d => pph(e) * sr * gain(CFG.respHappiness * d, e.happiness) / 100,
      luck: d => (toolboxRate(e.luck + d) - toolboxRate(e.luck)) * ctx.toolboxValue,
      boxes: rate => rate * ctx.toolboxValue,
      wage: f => -paidPph(e) * e.wageExpectation * f,
      raise: k => -paidPph(e) * 0.02 * k * wageTraitMultiplier(e),   // k × +0.02 wage expectation
      teamHappy: h => s.coworkers * coworkerBase * gain(h, s.coworkerHappiness) / 100,
      teamProd: d => d / CFG.outputDivisor * (1 + B) * sr,
      teamResp: d => s.coworkers * coworkerBase * gain(CFG.respHappiness * d, s.coworkerHappiness) / 100,
      quickStudy: pph(e) * (careerBonus(e, 2) - B) * sr,
    };
    base.stat = (stat, k) => stat === 'production' ? base.prod(k) : stat === 'responsibility' ? base.resp(k) : base.luck(k);
    const outcomes = traitArgs(t, arg, s, held).map(({ arg: a, p }) => {
      let total = 0;
      for (let d = 0; d < workingDays(e); d++) {
        total += t.hourly({ ...base, arg: a, age: e.age + d, tenure: s.tenureDays + d, employed: s.employedDays + d }) * 24;
      }
      return { arg: a, p, value: total };
    });
    return { value: outcomes.reduce((a, o) => a + o.p * o.value, 0), outcomes: outcomes.length > 1 ? outcomes : [] };
  }

  // Values for the trait cards. e.traits is what the employee holds:
  // [{ code, arg }]. removeTrait is the chart's hypothetical removal, not a dealt card.
  function traitCardValue(e, c, ctx) {
    const held = e.traits || [];
    const s = { ...DEFAULT_SITUATION, ...ctx?.situation };
    const v = (code, opts) => traitValue(code, e, ctx, opts).value;
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
      // +1 to a random stat.
      const pool = eligibleTraits(held.map(h => h.code), s.gender, ['positive', 'mixed', 'negative']);
      const traitAvg = pool.reduce((a, t) => a + (v(t.code) ?? 0), 0) / (pool.length || 1);
      const statAvg = STAT_ARGS.reduce((a, st) => a + cardValue(e, drill(st, 1), ctx), 0) / 3;
      return traitAvg + statAvg;
    }
    return undefined;
  }

  // Resolved transitions, shared by projected hands and outlooks. Each roll
  // applies all changes together before its placement is valued.
  function cardOutcomes(e, c, ctx = {}) {
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
    return rolls.flatMap(r => (c.card === 'wildCard' ? STAT_ARGS : [c.stat]).map(stat => {
      const next = { ...e, traits: r.traits };
      const delta = c.card === 'wildCard' ? 1 : c.card === 'drill' ? c.delta : 0;
      if (delta) next[stat] = (e[stat] || 0) + delta;
      let factor = stat === 'production' && delta ? next.production / e.production : 1;
      for (const [code, m] of [['greedy', 1.2], ['modest', 0.85]]) {
        if (!held.some(t => t.code === code) && r.traits.some(t => t.code === code)) factor *= m;
        if (held.some(t => t.code === code) && !r.traits.some(t => t.code === code)) factor /= m;
      }
      const raiseFactor = factor;
      if (c.card === 'negotiation') factor *= Math.max(0, e.wageExpectation - c.drop * wageTraitMultiplier(e)) / e.wageExpectation;
      if (Number.isFinite(e.wage)) next.wage = e.wage * factor;
      next.wageExpectation = e.wageExpectation * factor / (stat === 'production' && delta ? next.production / e.production : 1);
      if (c.card === 'negotiation' && e.negotiationExpectation != null) next.negotiationExpectation = Math.round(1000 * (e.negotiationExpectation - c.drop)) / 1000;
      const climbs = r.traits.some(t => t.code === 'climber');
      const wageTrait = r.traits.some(t => t.code === 'greedy') ? 1.2 : r.traits.some(t => t.code === 'modest') ? 0.85 : 1;
      next.climberRaise = !climbs ? 0 : e.climberRaise ? e.climberRaise * raiseFactor
        : next.production / 4 * (ctx.ppValue || 1) * 0.02 * wageTrait;
      return { p: r.p / (c.card === 'wildCard' ? 3 : 1), arg: r.arg, employee: next };
    }));
  }

  // Each trait's value for this employee, best first. `unit` is +1 trait
  // Production over the working life, for scaling tiers.
  function traitChart(e, ctx = {}) {
    const held = e.traits || [];
    const unit = traitUnit(e, ctx);
    return TRAITS.filter(t => t.weight > 0 || held.some(h => h.code === t.code)).map(t => {
      const h = held.find(x => x.code === t.code);
      const r = traitValue(t.code, e, ctx, { held: !!h, arg: h?.arg });
      return { ...t, ...r, held: !!h, ratio: r.value === null || !unit ? null : r.value / unit };
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
  function cardPool(e, ctx = {}, { price = null, depth = 1 } = {}) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const s = { ...DEFAULT_SITUATION, ...ctx.situation };
    const held = e.traits || [];
    const codes = held.map(h => h.code);
    const value = c => (price ? price(c) : cardValue(e, c, ctx, depth)) ?? 0;
    const traitV = {};
    const tv = code => (traitV[code] ??= (price ? price({ card: 'habit', code }) : traitValue(code, e, ctx).value) ?? 0);
    const pool = Object.fromEntries(RARITIES.map(r => [r, []]));
    for (const r of RARITIES) {
      for (const c of NUMERIC_CARDS[r]) {
        if (c.card === 'secondWind' && e.potentialMax != null && e.potentialMax + c.gain > CFG.potentialMaxCap) continue;
        const v = price ? price(c) : cardValue(e, c, ctx, depth);
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
    for (const t of eligibleTraits(codes, s.gender, ['mixed'])) pool.rare.push({ card: 'habit', code: t.code, value: tv(t.code) });
    const positives = eligibleTraits(codes, s.gender, ['positive']);
    for (const t of positives) pool.epic.push({ card: 'habit', code: t.code, value: tv(t.code) });
    for (let i = 0; i < positives.length; i++) {
      for (let j = i + 1; j < positives.length; j++) {
        const a = positives[i].code, b = positives[j].code;
        if (!conflicts(a, b)) pool.legendary.push({ card: 'habitPair', codes: [a, b], value: price ? price({ card: 'habitPair', codes: [a, b] }) ?? tv(a) + tv(b) : tv(a) + tv(b) });
      }
    }
    if (eligibleTraits(codes, s.gender, ['positive', 'mixed', 'negative']).length) {
      pool.uncommon.push({ card: 'wildCard', value: value({ card: 'wildCard' }) });
    }
    return pool;
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
  // Each trait that can roll for this gender: [{ code, p, value }].
  function rolledTraits(e, ctx, gender) {
    const held = (e.traits || []).map(t => t.code);
    const rollable = TRAITS.filter(t => t.weight && (!t.gender || t.gender === gender)
      && !held.includes(t.code) && !held.some(h => conflicts(h, t.code)));
    const gctx = { ...ctx, situation: { ...ctx.situation, gender } };
    const weights = rollable.reduce((a, t) => a + t.weight, 0);
    return rollable.map(t => ({ code: t.code, p: t.weight / weights, value: t.partner ? 0 : traitValue(t.code, e, gctx).value ?? 0 }));
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

  // How likely a wage reading x = expectation × Greedy/Modest is for a
  // trait with wage multiplier m. The expectation is uniform on 70% to
  // 130%, so x is uniform on m × that range, with density ∝ 1/m.
  function wageFit(x, m) {
    const ex = x / m;
    return ex >= CFG.wageFloor - 1e-6 && ex <= 2 - CFG.wageFloor + 1e-6 ? 1 / m : 0;
  }
  // The roll weights of a hidden trait given the wage reading x: Greedy
  // and Modest move the wage, so the wage hints at them (above 130% only
  // Greedy fits). With no trait fitting, the plain roll weights.
  // [{ code, p, value }].
  function traitsGivenWage(list, x) {
    const fit = list.map(t => t.p * wageFit(x, wageMult(t.code)));
    const total = fit.reduce((a, v) => a + v, 0);
    return total ? list.map((t, i) => ({ ...t, p: fit[i] / total })).filter(t => t.p > 0) : list;
  }

  // The trainings an employee's potential holds, net of what the same
  // energy would earn elsewhere (`alt`, PP per 10 energy). Training k
  // happens k days in, when that much less working life is left. A
  // training worth less than alt counts 0: the energy goes elsewhere.
  function potentialValue(e, ctx, potential, alt) {
    const days = workingDays(e);
    if (!days || !potential) return 0;
    const o = trainingOutlook(e, ctx).value;
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
  // what the wage says about Greedy and Modest, and potential 3 to 10.
  // ctx.situation is the company seen from this candidate. `alt` prices
  // the energy a training uses; `bonus` is the company's, without
  // happiness. { value, output, trait, potential, happiness,
  // wageExpectation, odds: { greedy, modest }, spread }. spread is every way
  // they could turn out, over the trait and potential: [{ p, value }].
  function candidateValue(cand, ctx = {}, { bonus = 0, happinessLoss = DEFAULT_EMPLOYEE.happinessLoss, alt = 0 } = {}) {
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const production = cand.production ?? HIRE.avgStat;
    const gender = cand.gender === 'female' ? 'female' : 'male';
    // Expectation × Greedy/Modest, as the model's wage expectation is.
    const wageExpectation = 4 * (cand.wagePP || 0) / production;
    const responsibility = cand.responsibility ?? HIRE.avgStat;
    const happiness = hireHappiness(responsibility, happinessLoss);
    const e = {
      ...DEFAULT_EMPLOYEE, age: cand.age, production, extraProduction: 0,
      responsibility, luck: cand.luck ?? HIRE.avgStat, bonus: withHappiness(bonus, happiness), happiness,
      specialization: 0, wageExpectation, happinessLoss, traits: [], trainingsPerDay: 1,
    };
    const output = hourlyProfit(e, ctx) * hoursLeft(e);
    // Greedy and Modest are already in the wage, so they add nothing more.
    const rolls = traitsGivenWage(rolledTraits(e, ctx, gender), wageExpectation)
      .map(t => WAGE_MULT[t.code] ? { ...t, value: 0 } : t);
    const trait = rolls.reduce((a, t) => a + t.p * t.value, 0);
    const pots = POTENTIALS.map(n => potentialValue(e, ctx, n, alt));
    const potential = pots.reduce((a, v) => a + v, 0) / pots.length;
    const p = code => rolls.find(t => t.code === code)?.p || 0;
    // Each trait by its odds, each potential equally likely.
    const spread = rolls.flatMap(t => pots.map(v => ({ p: t.p / pots.length, value: output + t.value + v })));
    return { value: output + trait + potential, output, trait, potential, happiness, wageExpectation, odds: { greedy: p('greedy'), modest: p('modest') }, spread };
  }

  // What a fresh set of candidates is worth when the pick sees only what a
  // card shows: age, gender, nationality, Production, Responsibility and
  // wage, never the trait or potential. Each candidate is drawn at random:
  // a group by weight, either gender, Production and Responsibility 1 to 4
  // (Responsibility sets their happiness), expectation 70% to 130%, age
  // 18 to 45, potential 3 to 10, one trait by roll weight (Greedy ×1.2 and
  // Modest ×0.85 on the wage). Each is valued twice: as the card reads (the
  // trait by its odds given the wage, potential averaged) and as they turn
  // out. The pick
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
  function freshSetValue(groups, { alt = 0, slots = 3, draws = 6000, seed = 1, rate = 0 } = {}) {
    if (!Array.isArray(groups)) groups = [groups || {}];
    const ages = HIRE.maxAge - HIRE.minAge + 1;
    const wageGrid = Array.from({ length: 11 }, (_, i) => 0.6 + i * 0.1);   // expectation × Greedy/Modest
    const own = new Map();
    const tables = groups.map(g => {
      const ctx = { ...DEFAULT_CONTEXT, ...g.ctx };
      const hire = { ...DEFAULT_EMPLOYEE, extraProduction: 0, bonus: g.bonus || 0, specialization: 0, happinessLoss: g.happinessLoss ?? DEFAULT_EMPLOYEE.happinessLoss, traits: [], trainingsPerDay: 1 };
      const key = g.key ?? own.size;
      if (!own.has(key)) {
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
        // Trainings by Production, age and potential.
        const pot = [];
        for (let P = HIRE.minStat; P <= HIRE.maxStat; P++) {
          const perDay = trainingOutlook({ ...mid, production: P }, ctx).value / midDays;
          pot[P] = days.map(d => {
            const byN = [0];
            for (let k = 0; k < HIRE.maxPotential; k++) byN.push(byN[k] + Math.max(0, perDay * Math.max(0, d - k) - alt));
            return byN;
          });
        }
        // Rollable traits by gender, each priced by Production at age 31.
        const traits = {};
        for (const gender of ['male', 'female']) {
          const gctx = { ...ctx, situation: { ...ctx.situation, gender } };
          const list = TRAITS.filter(t => t.weight && (!t.gender || t.gender === gender)).map(t => ({
            code: t.code, weight: t.weight, mult: wageMult(t.code),
            value: [0, 1, 2, 3, 4].map(P => !P || t.partner || WAGE_MULT[t.code] ? 0
              : traitValue(t.code, { ...mid, production: P }, gctx).value ?? 0),
          }));
          const total = list.reduce((a, t) => a + t.weight, 0);
          // Greedy and Modest are worth 0, so by wage multiplier: the weight
          // and the weighted value of the traits with it.
          const byMult = [1, ...Object.values(WAGE_MULT)].map(m => {
            const of = list.filter(t => t.mult === m);
            return { m, weight: of.reduce((a, t) => a + t.weight, 0), value: [0, 1, 2, 3, 4].map(P => of.reduce((a, t) => a + t.weight * t.value[P], 0)) };
          });
          // The trait's average as the card reads, given the wage reading x.
          const seen = (P, x) => {
            let w = 0, v = 0;
            for (const b of byMult) { const f = wageFit(x, b.m); w += f * b.weight; v += f * b.value[P]; }
            return w ? v / w : byMult.reduce((a, b) => a + b.value[P], 0) / total;
          };
          traits[gender] = { list, total, seen };
        }
        own.set(key, { gross, hours, days, pot, traits, midDays });
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
      const worth = (p, x) => p / CFG.outputDivisor * (gross[R][a] - x) * hours[a] + coworkerAt(g.cw[gender][p], x);
      const wage = expectation * trait.mult;
      const cw = coworkerAt(g.cw[gender][P], wage);
      coworkerSum += cw;
      const value = worth(P, wage) + trait.value[P] * scale + pot[P][a][n];
      const seen = worth(P, wage) + T.seen(P, wage) * scale + pot[P][a].slice(HIRE.minPotential).reduce((x, v) => x + v, 0) / pots;
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

  /* ── Keep or replace ───────────────────────────────────────
   * Firing frees a Break Room slot and costs coworkers nothing.
   */
  // What keeping an employee is worth over their working life left, in PP:
  // output after wages, the traits they hold, and the trainings their
  // potential still holds, net of what the same energy earns elsewhere
  // (`alt`). Trait Production is priced by its trait, as its condition
  // comes and goes, so the output leaves it out. Greedy and Modest are
  // already in the wage. e.potentialMax keeps Second Wind within the cap.
  // e.traitBonus is the part of today's bonus the held traits give (their
  // happiness and output percentages); the traits price it, so the output
  // leaves it out too.
  // { value, output, traits, potential, unpriced: [code] }.
  function employeeValue(e, ctx = {}, { alt = 0, trainingsLeft = 0 } = {}) {
    e = { ...DEFAULT_EMPLOYEE, ...e };
    ctx = { ...DEFAULT_CONTEXT, ...ctx };
    const output = hourlyProfit({ ...e, extraProduction: 0, bonus: e.bonus - (e.traitBonus || 0) }, ctx) * hoursLeft(e);
    let traits = 0;
    const unpriced = [];
    for (const t of e.traits || []) {
      if (t.code === 'greedy' || t.code === 'modest') continue;
      const v = traitValue(t.code, e, ctx, { held: true, arg: t.arg }).value;
      if (v == null) unpriced.push(t.code);
      else traits += v;
    }
    const potential = potentialValue(e, ctx, trainingsLeft, alt);
    return { value: output + traits + potential, output, traits, potential, unpriced };
  }

  // An employee record from the API after picking card c from their dealt
  // hand, until the next reload shows the real one. The draw already set
  // the day's training (lastTrainedAt, trainingsToday) and spent the energy
  // and the potential, so the pick only applies the card. Production and
  // the wage expectation scale the wage (paid on hired + trained
  // Production); Production scales the output estimate. What the game rolls
  // on the pick (Wild card's trait and stat, a gained trait's target) isn't
  // known, so it's listed in `rolled` and left for the reload.
  // opts.wageExpectation: the employee's, as a multiplier (default 1).
  function takeCard(emp, c, { wageExpectation = 1, now = new Date() } = {}) {
    const out = {
      ...emp,
      base: { ...emp.base },
      breakdown: Object.fromEntries(Object.entries(emp.breakdown || {}).map(([k, v]) => [k, { ...v }])),
      estimate: emp.estimate ? { ...emp.estimate } : emp.estimate,
      traits: [...(emp.traits || [])],
    };
    delete out.pendingTraining;
    const rolled = [];
    const addStat = (stat, d) => {
      const was = out.base[stat] || 0;
      out.base[stat] = was + d;
      if (out.breakdown[stat]) out.breakdown[stat].total = (out.breakdown[stat].total ?? was) + d;
      if (stat !== 'production') return;
      if (was > 0 && typeof out.wage === 'number') out.wage *= (was + d) / was;
      const total = (out.breakdown.production?.total ?? was + d) - d;
      if (total > 0 && typeof out.estimate?.production === 'number') out.estimate.production *= (total + d) / total;
    };
    if (c.card === 'wildCard') rolled.push('the trait', '+1 stat');
    else if (c.card === 'secondWind') out.potentialMax = Math.min(CFG.potentialMaxCap, (out.potentialMax || 0) + c.gain);
    else {
      const model = { ...DEFAULT_EMPLOYEE, ...emp.base, traits: emp.traits || [], wage: emp.wage, wageExpectation, negotiationExpectation: emp.wageExpectation };
      const next = cardOutcomes(model, c)[0]?.employee;
      if (next) {
        if (c.card === 'drill') addStat(c.stat, next[c.stat] - model[c.stat]);
        if (typeof out.wage === 'number') out.wage = next.wage;
        if (c.card === 'negotiation' && next.negotiationExpectation != null) out.wageExpectation = next.negotiationExpectation;
        out.traits = next.traits.map(t => {
          const held = model.traits.find(h => h.code === t.code);
          if (held) return held;
          const def = TRAIT[t.code];
          if (def?.arg || def?.partner) rolled.push(`${def.name}'s ${def.arg === 'good' ? 'good' : def.arg === 'stat' ? 'stat' : 'partner'}`);
          return { code: t.code, revealed: true };
        });
      }
    }
    if (out.lastTrainedAt?.slice(0, 10) !== now.toISOString().slice(0, 10)) {
      out.lastTrainedAt = now.toISOString();
      out.trainingsToday = 1;
    }
    return { emp: out, rolled };
  }

  return {
    CFG, RARITIES, NUMERIC_CARDS, PROD_TRAIT_CARDS, TRAIT_CARDS, DEFAULT_EMPLOYEE, DEFAULT_CONTEXT, LADDER_FLAGS,
    TRAITS, TRAIT, DEFAULT_SITUATION, HABIT_POLARITY, EXCLUSIVE, currentTraits,
    cardPool, cardOutcomes, secondWindValue, expectedMax, trainingOutlook, rolledTraitValue, takeCard,
    potentialValue, candidateValue, freshSetValue, employeeValue,
    eligibleTraits, wildCardRisk, canNegotiate, traitValue, traitChart, traitUnit,
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
