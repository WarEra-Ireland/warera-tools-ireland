/*
 *  FIGHTING BUILD COMPARISON & MANUAL BUILDS  (pure: no DOM, no network)
 *  A manual build is an ordinary strategy (fighting-core.js) the player
 *  enters by hand: what they run today, or a variation of a found build.
 *  manualOptions lists what the editor offers for a snapshot, profileDraft
 *  starts one from the player's current skills and equipped gear, cleanStrategy fits a
 *  stored draft to a snapshot it wasn't made against, and withManualGear
 *  prices hand-entered rolls nobody has sold.
 *
 *  compareBuilds lines two evaluated builds up side by side: the headline
 *  figures (income, costs and what's left of them, a day and over a month
 *  with the gear bought) with B − A and which side is better, skill levels,
 *  the gear in each slot of each phase, and consumables.
 */
const FightingCompare = (() => {
  const inNode = typeof module !== 'undefined' && module.exports;
  const Core = inNode ? require('./fighting-core.js') : FightingCore;
  const Search = inNode ? require('./fighting-search.js') : FightingSearch;

  const MONTH_DAYS = 30;
  const sumOrNull = (xs) => xs.some(x => x == null) ? null : xs.reduce((s, x) => s + x, 0);
  // higher: whether a larger figure is the better one. dailyIncome is the
  // enabled ledger streams; monthNet, a month's balance less buying the gear.
  const FIGURES = [
    { key: 'dailyDamage', higher: true },
    { key: 'dailyIncome', higher: true, of: (r) => sumOrNull(r.ledger.filter(l => l.enabled).map(l => l.amount)) },
    { key: 'dailyFightingCost', higher: false },
    { key: 'dailyBalance', higher: true },
    { key: 'equipmentPurchasePrice', higher: false },
    { key: 'monthNet', higher: true, of: (r) => r.figures.dailyBalance == null || r.figures.equipmentPurchasePrice == null ? null
      : MONTH_DAYS * r.figures.dailyBalance - r.figures.equipmentPurchasePrice },
    { key: 'costPer1000Damage', higher: false },
  ];

  const isFood = (i) => typeof i.healthRegenPercent === 'number';
  const isPill = (i) => typeof i.buffHours === 'number';
  const isAmmo = (i) => typeof i.percentAttack === 'number' && i.buffHours == null;
  const byCode = (a, b) => a.code.localeCompare(b.code);
  const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  const rank = (i) => { const r = RARITY_ORDER.indexOf(i.rarity); return r < 0 ? RARITY_ORDER.length : r; };

  // Every roll of every item is offered, priced or not and dominated or not:
  // the player's own gear needn't be anything the search would pick. Items
  // come in rarity order, each with the range its stats roll in. Roll prices
  // are as you'd pay them, buyer tax included.
  function manualOptions(snapshot) {
    const maxima = Search.ordinaryMaxima(snapshot);
    const items = Object.values(snapshot.config.items);
    const slots = Object.fromEntries(Core.SLOTS.map(slot => [slot,
      items.filter(i => i.slot === slot).sort((a, b) => rank(a) - rank(b) || byCode(a, b)).map(i => ({
        code: i.code, rarity: i.rarity ?? null, ranges: i.ranges || null,
        rolls: (snapshot.equipment[i.code] || []).map(t => ({ stats: t.stats, price: Core.buyCost(snapshot, { ...t, value: t.price ?? null }) }))
          .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)),
      }))]));
    const priced = (i) => ({ code: i.code, price: snapshot.prices[i.code]?.value ?? null });
    return {
      skills: Search.MODEL_SKILLS.filter(k => k in maxima).map(name => ({ name, max: maxima[name] })),
      slots,
      foods: items.filter(isFood).sort(byCode).map(priced),
      ammo: items.filter(isAmmo).sort(byCode).map(priced),
      pills: items.filter(isPill).sort(byCode).map(priced),
    };
  }

  // The player's current ordinary levels, capped at what they can reach,
  // the gear and ammunition they have equipped, and no food: the game
  // doesn't say which they eat. Equipped rolls nobody has sold recently
  // come unpriced, for the player to price.
  function profileDraft(snapshot) {
    const { skills } = manualOptions(snapshot);
    const equipped = snapshot.profile.equipped;
    return cleanStrategy(snapshot, {
      skills: Object.fromEntries(skills.map(({ name, max }) =>
        [name, Math.min(max, Math.max(0, snapshot.profile.currentSkills?.[name] || 0))])),
      equipment: Object.fromEntries(Core.SLOTS.map(s => [s, equipped?.equipment?.[s] || null])),
      food: null, ammo: equipped?.ammo ?? null,
    });
  }

  // Keep what the snapshot knows: unknown skills and item codes are dropped,
  // levels become whole numbers of at least zero. Levels over the maximum
  // stay, so the evaluation reports them rather than silently changing them.
  // A pilled build's debuff companion keeps only the parts it has: the rest
  // is the buff loadout's (fighting-core.js).
  function cleanStrategy(snapshot, draft) {
    const opts = manualOptions(snapshot);
    const known = (list, code) => list.some(o => o.code === code) ? code : null;
    const gear = (equipment) => Object.fromEntries(Core.SLOTS.map(slot => {
      const e = equipment?.[slot];
      if (!e || !opts.slots[slot].some(o => o.code === e.code)) return [slot, null];
      const stats = Object.fromEntries(Object.entries(e.stats || {})
        .filter(([, v]) => Number.isFinite(+v) && +v > 0).map(([k, v]) => [k, +v])
        .sort(([a], [b]) => a.localeCompare(b)));
      const price = e.price == null || e.price === '' ? null : +e.price;
      return [slot, { code: e.code, stats, ...(Number.isFinite(price) && price >= 0 ? { price } : {}) }];
    }));
    const out = {
      skills: Object.fromEntries(opts.skills.map(({ name }) =>
        [name, Math.max(0, Math.floor(+draft?.skills?.[name] || 0))])),
      equipment: gear(draft?.equipment),
      food: known(opts.foods, draft?.food),
      ammo: known(opts.ammo, draft?.ammo),
    };
    const pill = known(opts.pills, draft?.pill);
    if (pill) out.pill = pill;
    const d = draft?.debuff;
    if (pill && d) {
      out.debuff = {
        ...('equipment' in d ? { equipment: gear(d.equipment) } : {}),
        ...('food' in d ? { food: known(opts.foods, d.food) } : {}),
        ...('ammo' in d ? { ammo: known(opts.ammo, d.ammo) } : {}),
      };
    }
    return out;
  }

  // A hand-entered roll nobody has sold joins the snapshot as a target at the
  // price the player gave (none: it stays unpriced), with the durability of
  // another roll of the same item. Rolls the snapshot has keep its prices.
  function withManualGear(snapshot, strategy) {
    const refs = [strategy.equipment, strategy.debuff?.equipment].flatMap(e => Object.values(e || {})).filter(Boolean);
    let equipment = null;
    for (const ref of refs) {
      const have = (equipment || snapshot.equipment)[ref.code] || [];
      if (have.some(t => Core.sameStats(t.stats, ref.stats))) continue;
      equipment ||= { ...snapshot.equipment };
      equipment[ref.code] = [...have, { stats: ref.stats, price: ref.price ?? null, maxState: have[0]?.maxState ?? null,
        samples: 0, fetchedAt: null, tradeDate: null, taxBasis: 'tax-inclusive', source: 'manual' }];
    }
    return equipment ? { ...snapshot, equipment } : snapshot;
  }

  // a, b: { strategy, result } with result from Core.evaluateStrategy.
  function compareBuilds(a, b) {
    const figures = FIGURES.map(({ key, higher, of = (r) => r.figures[key] }) => {
      const x = of(a.result), y = of(b.result);
      const delta = x == null || y == null ? null : y - x;
      const better = delta == null || Math.abs(delta) < 1e-9 ? null : (delta > 0) === higher ? 'b' : 'a';
      return { key, a: x, b: y, delta, better };
    });

    const names = [...new Set([...Object.keys(a.result.effectiveSkills), ...Object.keys(b.result.effectiveSkills)])];
    const level = (r, n) => r.effectiveSkills[n] || { ordinary: 0, prestige: 0, level: 0 };
    const skills = names.map(name => ({ name, a: level(a.result, name), b: level(b.result, name) }))
      .filter(s => s.a.level || s.b.level)
      .map(s => ({ ...s, same: s.a.level === s.b.level && s.a.ordinary === s.b.ordinary }));

    // The first phase is the unpilled or buff loadout; a second, the debuff
    // companion, only shows when either build takes a pill.
    const phaseCount = Math.max(a.result.phases.length, b.result.phases.length);
    const sameGear = (x, y) => (!x && !y) || (x && y && x.code === y.code && Core.sameStats(x.stats, y.stats));
    const phases = Array.from({ length: phaseCount }, (_, i) => {
      const pa = a.result.phases[i] || null, pb = b.result.phases[i] || null;
      const slotOf = (p, slot) => p?.equipment.find(e => e.slot === slot) || null;
      return {
        phase: (pa || pb).phase === 'unpilled' && phaseCount > 1 ? 'buff' : (pa || pb).phase,
        gear: Core.SLOTS.map(slot => {
          const x = slotOf(pa, slot), y = slotOf(pb, slot);
          return { slot, a: x, b: y, same: !!sameGear(x, y) };
        }),
        food: { a: pa?.food ?? null, b: pb?.food ?? null, same: (pa?.food ?? null) === (pb?.food ?? null) },
        ammo: { a: pa?.ammo ?? null, b: pb?.ammo ?? null, same: (pa?.ammo ?? null) === (pb?.ammo ?? null) },
        missing: !pa ? 'a' : !pb ? 'b' : null,
      };
    });
    const pill = { a: a.strategy.pill || null, b: b.strategy.pill || null };
    pill.same = pill.a === pill.b;
    return { figures, skills, phases, pill };
  }

  // A build in its other pill state, with its skills and gear kept: a
  // pilled build on the days you hold the pill (no pill, its buff or debuff
  // gear at full strength) or an unpilled build put on a pill cycle. Food
  // and ammunition are picked again for each phase. The pick is the most
  // damage that spends no more a day than the build does before pills;
  // failing that, the smallest spend. With spendPill, a pilled build's
  // hold days may also spend what its pills cost. Null when nothing can be
  // costed. `next` is the runner-up, or null when nothing does more damage.
  function counterpart(snapshot, strategy, { spendPill = false } = {}) {
    const evaluate = (s) => Core.evaluateStrategy(snapshot, s);
    const items = Object.values(snapshot.config.items);
    const priced = (i) => snapshot.prices[i.code]?.value != null;
    const foods = [null, ...items.filter(i => isFood(i) && priced(i)).map(i => i.code).sort()];
    const ammo = items.filter(i => isAmmo(i) && priced(i)).map(i => i.code).sort();
    // A gun refuses attacks without ammunition; the knife needs none.
    const choices = (equipment) => foods.flatMap(food =>
      (snapshot.config.items[equipment?.weapon?.code]?.usesAmmo ? ammo : [null]).map(a => ({ food, ammo: a })));
    // The balance before pills, or without income, the fighting cost before them.
    const beforePills = (r) => r.fightingCost.pill == null ? null
      : r.figures.dailyBalance != null ? r.figures.dailyBalance + r.fightingCost.pill
      : r.figures.dailyFightingCost != null ? r.fightingCost.pill - r.figures.dailyFightingCost : null;
    const ownResult = evaluate(strategy);
    const { pill, debuff, ...base } = strategy;
    const own = beforePills(ownResult) == null ? null : beforePills(ownResult) - (pill && spendPill ? ownResult.fightingCost.pill : 0);

    let candidates;
    if (pill) {
      const gear = [base.equipment];
      if (debuff?.equipment && !snapshot.settings.sameGearBothPhases) gear.push(debuff.equipment);
      candidates = gear.flatMap(equipment => choices(equipment).map(c => ({ ...base, equipment, ...c })));
    } else {
      // Each phase's choices are narrowed on their own (the other phase
      // kept as it is) before the pairs are tried.
      const narrow = (rows, index) => rows.map(choice => {
        const r = evaluate(choice.strategy), p = r.phases[index];
        return { ...choice, damage: p.dailyDamage, attacks: p.attacksPerDay,
          cost: Object.values(p.fightingCost).some(v => v == null) ? null : Object.values(p.fightingCost).reduce((s, v) => s + v, 0) };
      }).filter((r, i, rows) => r.cost != null && !rows.some((a, j) => j !== i && a.cost != null
        && a.damage >= r.damage && a.cost <= r.cost && a.attacks >= r.attacks
        && (a.damage > r.damage || a.cost < r.cost || a.attacks > r.attacks || j < i)));
      const pills = items.filter(i => isPill(i) && priced(i)).map(i => i.code).sort();
      candidates = pills.flatMap(code => {
        const start = { ...base, pill: code, debuff: { food: base.food, ammo: base.ammo } };
        const buff = narrow(choices(base.equipment).map(c => ({ c, strategy: { ...start, ...c } })), 0);
        const after = narrow(choices(base.equipment).map(c => ({ c, strategy: { ...start, debuff: c } })), 1);
        return buff.flatMap(b => after.map(d => ({ ...start, ...b.c, debuff: d.c })));
      });
    }

    const rated = candidates.map(s => ({ strategy: s, result: evaluate(s) }))
      .filter(c => beforePills(c.result) != null && !c.result.issues.length);
    if (!rated.length) return null;
    const dmg = (c) => c.result.figures.dailyDamage;
    const within = own == null ? rated : rated.filter(c => beforePills(c.result) >= own - 1e-9);
    const pick = within.length
      ? within.reduce((best, c) => dmg(c) > dmg(best) || (dmg(c) === dmg(best) && beforePills(c.result) > beforePills(best.result)) ? c : best)
      : rated.reduce((best, c) => beforePills(c.result) > beforePills(best.result) ? c : best);
    // The runner-up: the cheapest choice that does more damage, over budget.
    const next = rated.filter(c => dmg(c) > dmg(pick)).reduce((best, c) => !best
      || beforePills(c.result) > beforePills(best.result) || (beforePills(c.result) === beforePills(best.result) && dmg(c) > dmg(best)) ? c : best, null);
    return { ...pick, next };
  }

  return { FIGURES, MONTH_DAYS, manualOptions, profileDraft, cleanStrategy, withManualGear, compareBuilds, counterpart };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingCompare;
