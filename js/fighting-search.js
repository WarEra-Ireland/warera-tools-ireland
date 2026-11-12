/*
 *  FIGHTING BUILD SEARCH  (pure: no DOM, no network, no clock)
 *  search(snapshot, { seed, depth, checkpoint }) explores skill
 *  allocations, priced equipment targets, consumables, company setups and
 *  (by pill mode) pilled strategies with fighting-core.js's
 *  evaluateStrategy, and returns the four-figure frontier, the four role
 *  picks and what was searched. Frontier builds carry only the figures and
 *  flags the search reads (`slim`); callers evaluate the rest when shown.
 *
 *  The work is split into deterministic rounds: the same snapshot, seed
 *  and depth always give the same result, and a checkpoint resumes the
 *  search exactly. Wall-clock limits belong to the caller, which runs the
 *  search a few rounds at a time. It is a bounded best-found search, never
 *  a proof of optimality.
 */
const FightingSearch = (() => {
  const Core = typeof module !== 'undefined' && module.exports ? require('./fighting-core.js') : FightingCore;
  const SEARCH_VERSION = 'search-8';

  // The skills the model reads; anything else would waste points.
  const MODEL_SKILLS = ['attack', 'precision', 'criticalChance', 'criticalDamages', 'armor', 'dodge', 'health', 'hunger',
                        'lootChance', 'companies', 'production', 'management', 'energy'];
  const STEPS_PER_ROUND = 30;      // hill-climbing steps from each start
  const NEIGHBOURS_PER_STEP = 14;  // random moves tried per step
  const ELITE_AFTER = 8;           // rounds of fresh starts before restarting from the best
  const ARCHIVE_LIMIT = 2048;
  const CACHE_LIMIT = 10000;      // FIFO result cache, bounded per worker

  const DEFAULTS = { savingsTarget: 100, lossAllowance: 200, pillMode: 'both', includeStale: false,
                     equipmentBudget: null, skillLocks: {} };
  const settingOf = (snapshot, k) => snapshot.settings[k] ?? DEFAULTS[k];

  // mulberry32: a 32-bit state, so a checkpoint can carry it.
  function rng(state) {
    const next = () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], state: () => state };
  }

  // Stable JSON (sorted keys) and FNV-1a, for the snapshot hash and ids.
  function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
  }
  // 64 bits as two 32-bit halves (cyrb53's two lanes, both kept whole), so
  // millions of builds don't collide: a collision would skip a build as seen.
  function hash2(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return [h1 >>> 0, h2 >>> 0];
  }
  const hex = (hi, lo) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  const hash = (str) => hex(...hash2(str));

  // The ids of every build met, as 64-bit pairs in insertion order (`ids`,
  // two words a build) with an open-addressed table of positions + 1 over
  // them: a fraction of a Set of strings' memory, and a checkpoint stores
  // the pairs as they are.
  function seenSet(from = new Uint32Array(0)) {
    let ids = new Uint32Array(Math.max(1024, from.length * 2)), size = 0, table, mask;
    const slot = (hi, lo) => {
      let i = (Math.imul(hi ^ lo, 0x9E3779B1) >>> 0) & mask;
      for (;;) {
        const at = table[i];
        if (!at || (ids[2 * at - 2] === hi && ids[2 * at - 1] === lo)) return i;
        i = (i + 1) & mask;
      }
    };
    const rehash = (cap) => {
      table = new Uint32Array(cap); mask = cap - 1;
      for (let n = 1; n <= size; n++) table[slot(ids[2 * n - 2], ids[2 * n - 1])] = n;
    };
    rehash(1 << Math.max(11, Math.ceil(Math.log2(from.length + 1)) + 1));
    const set = {
      get size() { return size; },
      has: (hi, lo) => table[slot(hi, lo)] !== 0,
      add(hi, lo) {
        const i = slot(hi, lo);
        if (table[i]) return;
        if (2 * size + 2 > ids.length) { const grown = new Uint32Array(ids.length * 2); grown.set(ids); ids = grown; }
        ids[2 * size] = hi; ids[2 * size + 1] = lo;
        table[i] = ++size;
        if (2 * size > table.length) rehash(table.length * 2);
      },
      // The first `count` ids, as a checkpoint stores them.
      first: (count) => ids.slice(0, 2 * count),
    };
    for (let n = 0; n < from.length; n += 2) set.add(from[n], from[n + 1]);
    return set;
  }

  // What the archive and frontier keep of a build: its figures and flags,
  // not the ~5 KB full result.
  const slim = ({ id, strategy, result: { figures, complete, stale, pilled } }) =>
    ({ id, strategy, result: { figures, complete, stale, pilled } });

  const cost = (level) => level * (level + 1) / 2;
  const bonusLevels = (snapshot) => snapshot.config.prestigeSkillBonusLevels ?? 1;
  const prestigeLevels = (snapshot, k) => (snapshot.profile.prestigeBoosts?.[k] || 0) * bonusLevels(snapshot);

  // The highest ordinary level the player can hold in each modelled skill.
  function ordinaryMaxima(snapshot) {
    const out = {};
    for (const k of MODEL_SKILLS) {
      const table = snapshot.config.skills[k];
      if (!table) continue;
      let max = 0;
      for (let l = 1; l < table.values.length; l++) if ((table.unlockAtLevel[l] ?? 1) <= snapshot.profile.level) max = l;
      out[k] = max;
    }
    return out;
  }

  const value = (snapshot, k, level) => {
    const v = snapshot.config.skills[k].values;
    return level < v.length ? v[level] : v[v.length - 1] + (level - v.length + 1) * (v[v.length - 1] - v[v.length - 2]);
  };

  // Locks fix skills at final effective levels (prestige included); a
  // companies lock so fixes the company count. Anything that can't be met is
  // explained, never relaxed.
  function resolveLocks(snapshot, maxima) {
    const fixed = {}, explanations = [];
    const locks = settingOf(snapshot, 'skillLocks') || {};
    for (const [k, level] of Object.entries(locks)) {
      if (level == null) continue;
      if (!(k in maxima)) { explanations.push(`${k} is not a skill the optimiser models.`); continue; }
      const ordinary = level - prestigeLevels(snapshot, k);
      if (!Number.isInteger(ordinary) || ordinary < 0) {
        explanations.push(`${k} can't be locked at level ${level}: your prestige already gives level ${prestigeLevels(snapshot, k)}.`);
      } else if (ordinary > maxima[k]) {
        explanations.push(`${k} can't be locked at level ${level}: that needs ordinary level ${ordinary}, above the ${maxima[k]} you can reach.`);
      } else fixed[k] = ordinary;
    }
    const spent = Object.values(fixed).reduce((s, l) => s + cost(l), 0);
    if (spent > snapshot.profile.ordinarySkillBudget) {
      explanations.push(`The locks need ${spent} skill points, over your budget of ${snapshot.profile.ordinarySkillBudget}.`);
    }
    return { fixed, explanations };
  }

  // More defensive stats can increase ammunition and wear costs. Keep every
  // priced roll; only the evaluated figures can establish dominance.
  function slotOptions(snapshot) {
    const options = Object.fromEntries(Core.SLOTS.map(s => [s, []]));
    for (const [code, targets] of Object.entries(snapshot.equipment)) {
      const slot = snapshot.config.items[code]?.slot;
      if (!options[slot]) continue;
      for (const t of targets) if (t.price != null) options[slot].push({ code, stats: t.stats,
        price: Core.buyCost(snapshot, { ...t, value: t.price }) });
    }
    for (const slot of Core.SLOTS) options[slot].sort((a, b) => a.price - b.price || stable(a).localeCompare(stable(b)));
    return options;
  }

  function incomeTable(snapshot, sp, locks) {
    const keys = sp.skills.filter(k => Core.INCOME_SKILLS.includes(k));
    if (!keys.length) return null;
    const budget = snapshot.profile.ordinarySkillBudget;
    if (Core.incomeForSkills(snapshot, Object.fromEntries(keys.map(k => [k, locks[k] ?? 0]))) == null) return null;
    const enabled = id => snapshot.settings.incomeToggles?.[id] !== false;
    // Companies feed engines and staff, Management staff and the manager
    // job, and energy and Production self-work.
    const active = k => k === 'companies' ? enabled('production') || enabled('employees')
      : k === 'management' ? enabled('employees') || enabled('manager') : enabled('production');
    const levels = keys.map(k => locks[k] != null ? [locks[k]]
      : Array.from({ length: active(k) ? Math.min(sp.maxima[k], Math.floor((Math.sqrt(8 * budget + 1) - 1) / 2)) + 1 : 1 }, (_, i) => i));
    const energyAt = keys.indexOf('energy');
    const energyLevels = energyAt < 0 ? [0] : levels.splice(energyAt, 1)[0];
    if (energyAt >= 0) keys.splice(energyAt, 1);
    const productionLevels = levels[keys.indexOf('production')]?.length || 1;
    // Self-work depends on production and energy. First keep the best
    // company allocation at each cost and production level, then combine energy.
    const work = levels.reduce((n, l) => n * l.length, 1) + productionLevels * (budget + 1) * energyLevels.length;
    if (work > 200000 || budget > 10000) return null;
    const table = Array(budget + 1).fill(null), byProduction = new Map();
    const skills = energyAt < 0 ? {} : { energy: energyLevels[0] };
    const evaluateIncome = Core.createIncomeEvaluator(snapshot);
    function visit(i, spent) {
      if (i < keys.length) {
        for (const level of levels[i]) {
          const next = spent + cost(level);
          if (next > budget) break;
          skills[keys[i]] = level;
          visit(i + 1, next);
        }
        return;
      }
      const income = evaluateIncome(skills), production = skills.production || 0;
      if (!byProduction.has(production)) byProduction.set(production, Array(budget + 1).fill(null));
      const row = byProduction.get(production);
      if (income != null && (!row[spent] || income > row[spent].income)) row[spent] = { income, skills: { ...skills } };
    }
    visit(0, cost(energyLevels[0]));
    for (const row of byProduction.values()) for (let spent = 0; spent <= budget; spent++) {
      if (!row[spent]) continue;
      for (const energy of energyLevels) {
        const total = spent + cost(energy) - cost(energyLevels[0]);
        if (total > budget) break;
        const allocation = energyAt < 0 ? row[spent].skills : { ...row[spent].skills, energy };
        const income = evaluateIncome(allocation);
        if (!table[total] || income > table[total].income) table[total] = { income, skills: allocation };
      }
    }
    for (let points = 1; points <= budget; points++) {
      if (table[points - 1] && (!table[points] || table[points - 1].income >= table[points].income)) table[points] = table[points - 1];
    }
    return table[budget] ? table : null;
  }

  function space(snapshot) {
    const maxima = ordinaryMaxima(snapshot);
    const items = Object.values(snapshot.config.items);
    const priced = (code) => snapshot.prices[code]?.value != null;
    return {
      maxima,
      skills: Object.keys(maxima),
      slots: slotOptions(snapshot),
      foods: items.filter(i => typeof i.healthRegenPercent === 'number' && priced(i.code)).map(i => i.code).sort(),
      ammo: items.filter(i => typeof i.percentAttack === 'number' && i.buffHours == null && priced(i.code)).map(i => i.code).sort(),
      pills: items.filter(i => typeof i.buffHours === 'number' && priced(i.code)).map(i => i.code).sort(),
    };
  }

  // --- Strategies ---
  const spentOf = (skills) => Object.values(skills).reduce((s, l) => s + cost(l), 0);

  // Spend the free points one random level at a time.
  function fillSkills(skills, sp, locks, budget, r, weights) {
    let left = budget - spentOf(skills);
    for (;;) {
      const open = sp.searchSkills.filter(k => locks[k] == null && skills[k] < sp.maxima[k] && skills[k] + 1 <= left);
      if (!open.length) return skills;
      const total = open.reduce((s, k) => s + (weights[k] || 1), 0);
      let x = r.next() * total;
      const k = open.find(k => (x -= weights[k] || 1) < 0) || open[open.length - 1];
      skills[k] += 1;
      left -= skills[k];
    }
  }

  function randomLoadout(sp, r, budget) {
    const equipment = {};
    for (const slot of Core.SLOTS) {
      const opts = sp.slots[slot];
      equipment[slot] = opts.length && r.next() < 0.85 ? opts[r.int(opts.length)] : null;
    }
    // An equipment budget steers starts: trade the dearest piece down until it fits.
    if (budget != null) {
      for (let guard = 0; guard < 100; guard++) {
        const total = Core.SLOTS.reduce((s, slot) => s + (equipment[slot]?.price || 0), 0);
        if (total <= budget) break;
        const slot = Core.SLOTS.filter(s => equipment[s]).sort((a, b) => equipment[b].price - equipment[a].price)[0];
        const opts = sp.slots[slot], i = opts.indexOf(equipment[slot]);
        equipment[slot] = i > 0 ? opts[i - 1] : null;
      }
    }
    // Targets share the snapshot's frozen stats rather than copying them.
    const strip = (t) => t && { code: t.code, stats: t.stats };
    return {
      equipment: Object.fromEntries(Core.SLOTS.map(s => [s, strip(equipment[s])])),
      food: sp.foods.length ? r.pick(sp.foods) : null,
      ammo: sp.ammo.length ? r.pick(sp.ammo) : null,
    };
  }

  const priceIn = (sp, slot, t) => sp.slots[slot].find(o => o.code === t.code && stable(o.stats) === stable(t.stats))?.price || 0;

  function startStrategy(snapshot, sp, locks, r, round, pilled) {
    const budget = snapshot.profile.ordinarySkillBudget;
    let skills;
    if (round < 2) {
      // The first starts keep the player's current allocation where it fits.
      skills = Object.fromEntries(sp.skills.map(k => [k, locks[k] ?? Math.min(sp.maxima[k], snapshot.profile.currentSkills?.[k] || 0)]));
      while (spentOf(skills) > budget) {
        const k = sp.skills.filter(k => locks[k] == null && skills[k] > 0).sort((a, b) => skills[b] - skills[a])[0];
        if (!k) break;
        skills[k] -= 1;
      }
    } else {
      skills = Object.fromEntries(sp.skills.map(k => [k, locks[k] ?? 0]));
      const weights = Object.fromEntries(sp.skills.map(k => [k, 0.2 + r.next() * 2]));
      const available = sp.income ? spentOf(skills) + r.int(Math.max(1, budget - spentOf(skills) + 1)) : budget;
      fillSkills(skills, sp, locks, available, r, weights);
    }
    const l = randomLoadout(sp, r, settingOf(snapshot, 'equipmentBudget'));
    const s = { skills, ...l };
    if (pilled && sp.pills.length) {
      s.pill = r.pick(sp.pills);
      // A separate companion set shares the budget with the buff loadout: the
      // budget is for the combined purchase.
      const budget = settingOf(snapshot, 'equipmentBudget');
      const spentOnBuff = Core.SLOTS.reduce((t, slot) => t + (l.equipment[slot] ? priceIn(sp, slot, l.equipment[slot]) : 0), 0);
      const companion = r.next() < 0.5 ? { equipment: { ...l.equipment }, food: l.food, ammo: l.ammo }
        : randomLoadout(sp, r, budget == null ? null : Math.max(0, budget - spentOnBuff));
      // Under the same-gear override the companion only brings consumables.
      if (snapshot.settings.sameGearBothPhases) delete companion.equipment;
      s.debuff = companion;
    }
    return s;
  }

  // Moves only replace skill levels, slot targets and consumables, never
  // edit a target, so copying down to the equipment maps is enough.
  const clonePhase = (p) => ({ ...p, equipment: p.equipment && { ...p.equipment } });
  const clone = (s) => ({ ...clonePhase(s), skills: { ...s.skills }, ...(s.debuff ? { debuff: clonePhase(s.debuff) } : {}) });

  // A cheap cache key: equal for strategies stable() would write alike.
  const statKeys = new WeakMap();
  const statKey = (stats) => {
    let k = statKeys.get(stats);
    if (k == null) statKeys.set(stats, k = stable(stats));
    return k;
  };
  const phaseKey = (sp, p) => `${p.equipment ? Core.SLOTS.map(slot => p.equipment[slot] ? sp.targetId(p.equipment[slot]) : 0).join(',') : '~'}|${p.food}|${p.ammo}`;
  const keyOf = (sp, s) => `${sp.skills.map(k => s.skills[k]).join(',')}#${phaseKey(sp, s)}${s.pill ? `#${s.pill}#${phaseKey(sp, s.debuff)}` : ''}`;

  function canonicalStrategy(snapshot, sp, locks, strategy) {
    const s = clone(strategy);
    if (s.pill) {
      s.debuff = { food: s.food, ammo: s.ammo, ...s.debuff };
      if (snapshot.settings.sameGearBothPhases) delete s.debuff.equipment;
    } else delete s.debuff;
    for (const phase of [s, s.debuff].filter(Boolean)) {
      const equipment = phase.equipment || s.equipment;
      if (!snapshot.config.items[equipment?.weapon?.code]?.usesAmmo) phase.ammo = null;
      else if (!phase.ammo) phase.ammo = sp.ammo[0] || null;
    }
    // Reduce only the two stats whose rounded percentages determine all uses.
    for (const k of ['armor', 'dodge']) {
      if (locks[k] != null || !snapshot.config.skills[k]) continue;
      const cap = snapshot.config.skills[k].softCap;
      const totals = [s, s.debuff].filter(Boolean).map(p => Object.values(p.equipment || s.equipment || {})
        .reduce((sum, e) => sum + (e?.stats[k] || 0), 0));
      let level = s.skills[k] || 0;
      const pct = l => totals.map(t => Core.softCapPercent(t + value(snapshot, k, l + prestigeLevels(snapshot, k)), cap));
      const before = pct(level);
      while (level > 0 && pct(level - 1).every((v, i) => v === before[i])) level--;
      s.skills[k] = level;
    }
    if (sp.income) {
      const combatSpent = sp.searchSkills.reduce((sum, k) => sum + cost(s.skills[k] || 0), 0);
      const available = snapshot.profile.ordinarySkillBudget - combatSpent;
      let allocation = sp.income[available];
      if (sp.lootLevels) {
        const yieldPerPoint = sp.evaluate.lootIncomePerPoint(s);
        let best = -Infinity;
        for (const level of sp.lootLevels) {
          const income = sp.income[available - cost(level)];
          if (!income) continue;
          const total = income.income + yieldPerPoint * value(snapshot, 'lootChance', level + prestigeLevels(snapshot, 'lootChance'));
          if (total > best) {
            best = total;
            allocation = income;
            s.skills.lootChance = level;
          }
        }
      }
      if (allocation) Object.assign(s.skills, allocation.skills);
    }
    return s;
  }

  function neighbour(snapshot, sp, locks, s, r) {
    const n = clone(s);
    const budget = snapshot.profile.ordinarySkillBudget;
    const free = sp.searchSkills.filter(k => locks[k] == null);
    const move = r.int(sp.conditionalConsumables ? 8 : 10);
    if (move < 5 && free.length) {
      const down = free.filter(k => n.skills[k] > 0);
      if (move === 4 && down.length) n.skills[r.pick(down)]--;
      else {
        const open = free.filter(k => n.skills[k] < sp.maxima[k]);
        if (!open.length) return null;
        const up = r.pick(open);
        let target = n.skills[up] + 1;
        if (['armor', 'dodge'].includes(up)) {
          const cap = snapshot.config.skills[up].softCap;
          const gear = [n, n.debuff].filter(Boolean).map(p => Object.values(p.equipment || n.equipment || {})
            .reduce((sum, e) => sum + (e?.stats[up] || 0), 0));
          const pct = (l, t) => Core.softCapPercent(t + value(snapshot, up, l + prestigeLevels(snapshot, up)), cap);
          while (target < sp.maxima[up] && gear.every(t => pct(target, t) === pct(n.skills[up], t))) target++;
        }
        if (sp.income && move >= 2) for (const k of [...Core.INCOME_SKILLS, ...(sp.lootLevels ? ['lootChance'] : [])]) if (k in n.skills) n.skills[k] = locks[k] ?? 0;
        const required = cost(target) - cost(n.skills[up]);
        let left = budget - spentOf(n.skills);
        const donors = free.filter(k => k !== up && n.skills[k] > 0);
        while (left < required && donors.length) {
          const k = r.pick(donors);
          left += n.skills[k]--;
          if (!n.skills[k]) donors.splice(donors.indexOf(k), 1);
        }
        if (left < required) return null;
        n.skills[up] = target;
      }
    } else {
      const companion = n.pill && r.next() < 0.5 && (move >= 8 || !snapshot.settings.sameGearBothPhases);
      const phase = companion ? (n.debuff ||= { equipment: { ...n.equipment }, food: n.food, ammo: n.ammo }) : n;
      if (move < 8) {
        const slot = r.pick(Core.SLOTS), opts = sp.slots[slot];
        phase.equipment ||= { ...n.equipment };
        const current = phase.equipment[slot];
        const at = opts.findIndex(t => current && t.code === current.code && statKey(t.stats) === statKey(current.stats));
        const choices = [null, ...opts];
        const index = r.next() < 0.6 ? Math.max(0, Math.min(choices.length - 1, at + 1 + (r.next() < 0.5 ? -1 : 1))) : r.int(choices.length);
        const t = choices[index];
        phase.equipment[slot] = t && { code: t.code, stats: t.stats };
      } else if (move === 8) phase.food = r.pick([null, ...sp.foods]);
      else phase.ammo = sp.ammo.length ? r.pick(sp.ammo) : null;
    }
    return n;
  }

  // Armor and dodge round to whole percents, so a roll's last few points of
  // either can buy nothing. The cheaper rolls of the same item that differ
  // only in less of a soft-capped stat and keep every phase wearing it at
  // the same percent: each gives the same damage for less.
  function lighterRolls(snapshot, options, t, totals) {
    const caps = snapshot.config.skills;
    const capped = (k) => typeof caps[k]?.softCap === 'number';
    const keys = Object.keys(t.stats);
    if (!keys.some(capped)) return [];
    const price = options.find(o => o.code === t.code && statKey(o.stats) === statKey(t.stats))?.price;
    if (price == null) return [];
    const pct = (total, k) => Core.softCapPercent(total, caps[k].softCap);
    return options.filter(o => o.code === t.code && o.price < price
      && Object.keys(o.stats).length === keys.length
      && keys.every(k => capped(k) ? o.stats[k] <= t.stats[k] : o.stats[k] === t.stats[k])
      && keys.filter(capped).every(k => totals.every(tot => pct(tot[k] - t.stats[k] + o.stats[k], k) === pct(tot[k], k))));
  }

  // --- Frontier ---
  // Higher damage and balance, lower price and cost. An unknown figure is
  // the worst possible, never zero.
  const MEASURES = [['dailyDamage', 1], ['equipmentPurchasePrice', -1], ['dailyFightingCost', -1], ['dailyBalance', 1]];
  const score = (f, k, sign) => f[k] == null ? -Infinity : sign * f[k];
  function dominates(a, b) {
    let strict = false;
    for (const [k, sign] of MEASURES) {
      const x = score(a.result.figures, k, sign), y = score(b.result.figures, k, sign);
      if (x < y) return false;
      if (x > y) strict = true;
    }
    return strict;
  }
  const sameFigures = (a, b) => MEASURES.every(([k]) => a.result.figures[k] === b.result.figures[k]);

  // Offer a candidate to the archive: keep it unless something dominates or
  // equals it, and drop what it dominates.
  function offer(archive, c) {
    for (const a of archive) if (dominates(a, c) || sameFigures(a, c)) return archive;
    return [...archive.filter(a => !dominates(c, a)), c];
  }

  const byDamage = (a, b) => (b.result.figures.dailyDamage - a.result.figures.dailyDamage) || a.id.localeCompare(b.id);

  // --- Role picks ---
  const ROLES = [
    { role: 'saver',       label: 'Saver' },
    { role: 'selfFunding', label: 'Self-funding' },
    { role: 'moderate',    label: 'Moderate spender' },
    { role: 'full',        label: 'Full spender' },
  ];
  const coins = (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(Math.round(v * 100) / 100)}`;

  /**
   * The highest-damage build meeting each role's rule, or why there is
   * none. Stale builds are left out unless includeStale; incomplete ones
   * always (every role rests on the balance).
   */
  function pickRoles(candidates, settings = {}) {
    const savings = settings.savingsTarget ?? DEFAULTS.savingsTarget;
    const loss = settings.lossAllowance ?? DEFAULTS.lossAllowance;
    const includeStale = settings.includeStale ?? false;
    const known = candidates.filter(c => c.result.complete && c.result.figures.dailyBalance != null);
    const eligible = known.filter(c => includeStale || !c.result.stale);
    const left = [];
    if (candidates.length - known.length) left.push(`${candidates.length - known.length} incomplete`);
    if (known.length - eligible.length) left.push(`${known.length - eligible.length} stale-priced`);
    const among = `among ${eligible.length} eligible build${eligible.length === 1 ? '' : 's'} found${
      left.length ? ` (${left.join(' and ')} left out)` : ''}; this search not finding one doesn't prove none exists`;
    const bal = (c) => c.result.figures.dailyBalance, dmg = (c) => c.result.figures.dailyDamage;
    const compare = (a, b) => (dmg(b) - dmg(a)) || (bal(b) - bal(a))
      || (a.result.figures.equipmentPurchasePrice - b.result.figures.equipmentPurchasePrice) || a.id.localeCompare(b.id);
    const best = (pred) => eligible.reduce((winner, c) => pred(c) && (!winner || compare(c, winner) < 0) ? c : winner, null);

    const saver = best(c => bal(c) >= savings);
    const self = best(c => bal(c) >= 0);
    const floor = self ? dmg(self) : -Infinity;
    const spending = (limit) => best(c => bal(c) >= -limit && dmg(c) > floor);
    const full = spending(loss);
    let moderate = spending(loss / 2);
    const out = {
      saver: saver || `No build with a daily balance of at least ${coins(savings)} ${among}.`,
      selfFunding: self || `No build without a daily loss ${among}.`,
      full: full || (best(c => bal(c) >= -loss)
        ? `No build within a ${coins(loss).replace('+', '')} daily loss beats the self-funding damage.`
        : `No build within a ${coins(loss).replace('+', '')} daily loss ${among}.`),
    };
    if (moderate && full && moderate === full) {
      moderate = best(c => bal(c) >= -loss / 2 && dmg(c) > floor && dmg(c) < dmg(full) && bal(c) > bal(full));
      out.moderate = moderate || `The best build within half the loss allowance is the full-spender pick, and no smaller-loss build ${
        ''}beats the self-funding damage ${among}.`;
    } else {
      out.moderate = moderate || (best(c => bal(c) >= -loss / 2)
        ? `No build within a ${coins(loss / 2).replace('+', '')} daily loss beats the self-funding damage.`
        : `No build within a ${coins(loss / 2).replace('+', '')} daily loss ${among}.`);
    }
    return ROLES.map(({ role, label }) => {
      const v = out[role];
      const candidate = typeof v === 'string' ? null : v;
      return { role, label, candidate, explanation: candidate ? null : v,
               ...(role === 'selfFunding' && candidate ? { surplus: bal(candidate) } : {}) };
    });
  }

  function compactArchive(snapshot, archive) {
    if (archive.length <= ARCHIVE_LIMIT) return archive;
    const keep = new Set();
    for (const includeStale of [false, true]) for (const pick of pickRoles(archive, {
      savingsTarget: settingOf(snapshot, 'savingsTarget'), lossAllowance: settingOf(snapshot, 'lossAllowance'), includeStale,
    })) if (pick.candidate) keep.add(pick.candidate);
    const distance = new Float64Array(archive.length);
    for (const [key, sign] of MEASURES) {
      const sorted = archive.map((c, i) => ({ i, value: score(c.result.figures, key, sign) }))
        .filter(p => Number.isFinite(p.value)).sort((a, b) => a.value - b.value || a.i - b.i);
      if (!sorted.length) continue;
      distance[sorted[0].i] = distance[sorted.at(-1).i] = Infinity;
      const span = sorted.at(-1).value - sorted[0].value;
      if (span > 0) for (let i = 1; i < sorted.length - 1; i++) {
        distance[sorted[i].i] += (sorted[i + 1].value - sorted[i - 1].value) / span;
      }
    }
    const order = archive.map((_, i) => i).sort((a, b) => distance[b] - distance[a] || a - b);
    for (const i of order) {
      if (keep.size >= ARCHIVE_LIMIT / 2) break;
      keep.add(archive[i]);
    }
    return archive.filter(c => keep.has(c));
  }

  // --- Search ---
  // Each round climbs from one start towards one objective. The objectives
  // cycle through role thresholds and intermediate spending/purchase bands.
  function objective(snapshot, sp, round) {
    const savings = settingOf(snapshot, 'savingsTarget'), loss = settingOf(snapshot, 'lossAllowance');
    const thresholds = [0, savings, -loss / 2, -loss];
    const kind = Math.floor(round / 2) % 8;
    if (kind < 4) {
      const t = thresholds[kind];
      return (f) => f.dailyBalance == null ? -Infinity : f.dailyBalance >= t ? 1e12 + f.dailyDamage : f.dailyBalance - t;
    }
    // Alternate the role targets with intermediate spending and purchase bands.
    // These constraints can reach trade-offs that weighted sums skip.
    const cycle = Math.floor(round / 16);
    const t = [-loss / 4, -3 * loss / 4, savings / 2, thresholds[cycle % 4]][kind - 4];
    const maxPrice = Core.SLOTS.reduce((sum, slot) => sum + Math.max(0, ...sp.slots[slot].map(t => t.price)), 0)
      * (settingOf(snapshot, 'pillMode') !== 'unpilled' && !snapshot.settings.sameGearBothPhases ? 2 : 1);
    const price = (settingOf(snapshot, 'equipmentBudget') ?? maxPrice) * [0.1, 0.25, 0.5, 1][(cycle + kind) % 4];
    return f => {
      if (f.dailyBalance == null || f.equipmentPurchasePrice == null) return -Infinity;
      const deficit = Math.max(0, t - f.dailyBalance) / Math.max(1, loss, savings)
        + Math.max(0, f.equipmentPurchasePrice - price) / Math.max(1, price);
      return deficit > 0 ? -deficit : 1e12 + f.dailyDamage;
    };
  }

  function kindsFor(snapshot, sp) {
    const mode = settingOf(snapshot, 'pillMode');
    if (!sp.pills.length) return mode === 'pilled' ? [] : [false];
    return mode === 'unpilled' ? [false] : mode === 'pilled' ? [true] : [false, true];
  }

  // What a search covered, for the page to lay out.
  function scope(snapshot, sp, locks) {
    const mode = settingOf(snapshot, 'pillMode');
    return {
      skillPoints: snapshot.profile.ordinarySkillBudget, skills: sp.skills.length, locked: Object.keys(locks),
      gear: Core.SLOTS.reduce((s, slot) => s + sp.slots[slot].length, 0), slots: Core.SLOTS.length,
      foods: sp.foods.length, ammo: sp.ammo.length,
      pills: mode === 'unpilled' || !sp.pills.length ? 'unpilled' : mode === 'pilled' ? 'pilled' : 'both',
    };
  }

  const memos = new WeakMap();
  // A caller resuming every few rounds passes the same frozen snapshot, so
  // its hash, search space and locks are worked out once.
  function prepare(snapshot) {
    let memo = memos.get(snapshot);
    if (!memo) {
      const sp = space(snapshot);
      const targetIds = new Map(), referenceIds = new WeakMap();
      for (const slot of Core.SLOTS) for (const t of sp.slots[slot]) {
        const key = t.code + statKey(t.stats);
        if (!targetIds.has(key)) targetIds.set(key, targetIds.size + 1);
      }
      sp.targetId = t => {
        let ids = referenceIds.get(t.stats);
        if (!ids) referenceIds.set(t.stats, ids = new Map());
        if (!ids.has(t.code)) ids.set(t.code, targetIds.get(t.code + statKey(t.stats)) ?? t.code + statKey(t.stats));
        return ids.get(t.code);
      };
      const { fixed: locks, explanations } = resolveLocks(snapshot, sp.maxima);
      sp.income = explanations.length ? null : incomeTable(snapshot, sp, locks);
      sp.evaluate = Core.createSearchEvaluator(snapshot);
      sp.lootLevels = sp.income && sp.evaluate.lootOptimizable && sp.skills.includes('lootChance')
        ? locks.lootChance != null ? [locks.lootChance] : Array.from({ length: sp.maxima.lootChance + 1 }, (_, i) => i) : null;
      sp.searchSkills = sp.skills.filter(k => (!sp.income || !Core.INCOME_SKILLS.includes(k)) && !(sp.lootLevels && k === 'lootChance'));
      const phaseChoices = (sp.foods.length + 1) * Math.max(1, sp.ammo.length);
      sp.conditionalConsumables = phaseChoices ** (settingOf(snapshot, 'pillMode') === 'unpilled' || !sp.pills.length ? 1 : 2) <= 256;
      const kinds = kindsFor(snapshot, sp);
      if (!kinds.length) explanations.push('Pilled strategies need a priced pill, and none is priced.');
      memos.set(snapshot, memo = { snapshotHash: hash(stable(snapshot)), sp, locks, explanations, kinds, evaluateCore: sp.evaluate });
    }
    return memo;
  }

  // The frontier, role picks and metadata of an archive, for one search or several.
  function report(snapshot, archive, searched) {
    const { snapshotHash, sp, locks, explanations } = prepare(snapshot);
    const budget = settingOf(snapshot, 'equipmentBudget');
    const frontier = (explanations.length ? [] : [...archive].sort(byDamage)).map(c => ({
      ...c, pilled: !!c.result.pilled,
      overBudget: budget != null && c.result.figures.equipmentPurchasePrice != null && c.result.figures.equipmentPurchasePrice > budget,
    }));
    const picks = explanations.length
      ? ROLES.map(({ role, label }) => ({ role, label, candidate: null, explanation: `No build: ${explanations.join(' ')}` }))
      : pickRoles(frontier, { savingsTarget: settingOf(snapshot, 'savingsTarget'), lossAllowance: settingOf(snapshot, 'lossAllowance'),
                              includeStale: settingOf(snapshot, 'includeStale') });
    const { seeds, depth, evaluated, evaluatedPilled, companyCounts } = searched;
    return {
      frontier,
      picks,
      infeasible: [...explanations],
      metadata: {
        ...(seeds.length === 1 ? { seed: seeds[0] } : { seeds }), depth, evaluated, evaluatedPilled, companyCounts,
        scope: explanations.length ? null : scope(snapshot, sp, locks),
        modelVersion: Core.MODEL_VERSION, searchVersion: SEARCH_VERSION, snapshotHash, globalOptimum: false, archiveLimit: ARCHIVE_LIMIT,
      },
    };
  }
  // The seen set and result cache behind each returned checkpoint, so the
  // caller resuming every slice doesn't rebuild them from the checkpoint.
  // Resuming takes them over; the same checkpoint resumed again rebuilds.
  const live = new WeakMap();

  /**
   * opts: { seed, depth, checkpoint? }. Runs rounds until `depth` are
   * complete (resuming from the checkpoint's) and returns the frontier,
   * role picks, search metadata and a checkpoint to continue from.
   */
  function search(snapshot, { seed = 1, depth = 1, checkpoint = null } = {}) {
    const { snapshotHash, sp, locks, explanations, kinds } = prepare(snapshot);

    // The archive and company counts are replaced, never edited, so a
    // shallow copy leaves the checkpoint untouched.
    let state, seen, cache;
    if (checkpoint) {
      if (checkpoint.snapshotHash !== snapshotHash || checkpoint.seed !== seed || checkpoint.searchVersion !== SEARCH_VERSION) {
        throw new Error('The checkpoint belongs to a different snapshot, seed or search version.');
      }
      const { searchVersion, depth, rng, evaluated, evaluatedPilled, companyCounts, archive } = checkpoint;
      state = { searchVersion, snapshotHash, seed, depth, rng, evaluated, evaluatedPilled, companyCounts, archive };
      ({ seen, cache } = live.get(checkpoint) || { seen: seenSet(checkpoint.seen), cache: new Map() });
      live.delete(checkpoint);
    } else {
      state = { searchVersion: SEARCH_VERSION, snapshotHash, seed, depth: 0, rng: (seed >>> 0) ^ 0x9E3779B9,
                evaluated: 0, evaluatedPilled: 0, companyCounts: [], archive: [] };
      seen = seenSet(); cache = new Map();
    }

    if (!explanations.length) {
      const r = rng(state.rng);
      const evaluateCore = prepare(snapshot).evaluateCore;
      // Every strategy is counted and offered to the archive once, the first
      // time any round meets it, so a resumed search repeats an unbroken one.
      const counts = new Set(state.companyCounts);
      // Climbing rarely tries the one cheaper roll that would show a soft-
      // capped stat's last points buy nothing, so a build entering the
      // archive tries them, slot by slot; any that beats it is offered too.
      // A target both phases wear is bought once, so it is swapped in both.
      const trim = (c) => {
        let best = c;
        const phases = (s) => [s, s.debuff].filter(p => p?.equipment);
        const same = (u, t) => u && u.code === t.code && statKey(u.stats) === statKey(t.stats);
        // Each phase's soft-capped totals: skill plus its gear.
        const totalsOf = (p) => Object.fromEntries(Object.keys(snapshot.config.skills)
          .filter(k => typeof snapshot.config.skills[k].softCap === 'number')
          .map(k => [k, (c.result.effectiveSkills[k]?.value || 0)
            + Object.values(p.equipment).reduce((sum, e) => sum + (e?.stats[k] || 0), 0)]));
        for (const slot of Core.SLOTS) {
          const targets = phases(best.strategy).map(p => p.equipment[slot]).filter(Boolean);
          for (const t of targets.filter((t, i) => targets.findIndex(u => same(u, t)) === i)) {
            const totals = phases(best.strategy).filter(p => same(p.equipment[slot], t)).map(totalsOf);
            for (const o of lighterRolls(snapshot, sp.slots[slot], t, totals)) {
              const n = clone(best.strategy);
              for (const p of phases(n)) {
                if (same(p.equipment[slot], t)) p.equipment[slot] = { code: o.code, stats: o.stats };
              }
              const tried = evaluate(n, false);
              if (!tried.result.issues.length && dominates(tried, best)) { best = tried; break; }
            }
          }
        }
      };
      const evaluate = (strategy, trimming = true, canonical = false) => {
        if (!canonical) strategy = canonicalStrategy(snapshot, sp, locks, strategy);
        const key = keyOf(sp, strategy);
        const hit = cache.get(key);
        if (hit) return { id: hit.id, strategy, result: hit };
        const [hi, lo] = hash2(key);
        const id = hex(hi, lo);
        const c = { id, strategy, result: evaluateCore(strategy) };
        // The cache holds only what climbing reads: a full result is ~7 KB,
        // and a long search meets hundreds of thousands of builds.
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, { id, figures: c.result.figures, issues: c.result.issues });
        if (!seen.has(hi, lo)) {
          seen.add(hi, lo);
          state.evaluated += 1;
          if (strategy.pill) state.evaluatedPilled += 1;
          counts.add(c.result.companies.count);
          if (!c.result.issues.length) {
            const kept = slim(c);
            state.archive = compactArchive(snapshot, offer(state.archive, kept));
            if (trimming && state.archive.includes(kept)) trim(c);
          }
        }
        return c;
      };
      while (state.depth < depth) {
        const round = state.depth;
        // Each objective gets a fresh and an elite round for every strategy kind.
        const pilled = kinds[Math.floor(round / 2) % kinds.length];
        const objectiveRound = Math.floor(round / (2 * kinds.length)) * 2 + round % 2;
        const goal = objective(snapshot, sp, objectiveRound);
        // Every other round after the first few restarts from the archive's
        // best build for this objective, kicked by a few random moves
        // (iterated local search); the rest start fresh.
        // Fresh starts cover both kinds; elite rounds can refine either.
        const pool = round >= ELITE_AFTER && round % 2 === 1 ? state.archive : [];
        let current;
        if (pool.length) {
          const elite = pool.reduce((b, c) => goal(c.result.figures) > goal(b.result.figures) ? c : b);
          let kicked = elite.strategy;
          // Seed the other pill mode from an already strong allocation rather
          // than relying on an unrelated random loadout to discover it.
          if (pilled !== !!kicked.pill && Math.floor(round / 8) % 2 === 0) {
            kicked = clone(kicked);
            if (pilled) {
              kicked.pill = r.pick(sp.pills);
              kicked.debuff = { equipment: { ...kicked.equipment }, food: kicked.food, ammo: kicked.ammo };
            } else { delete kicked.pill; delete kicked.debuff; }
          }
          for (let k = 1 + r.int(4); k > 0; k--) kicked = neighbour(snapshot, sp, locks, kicked, r) || kicked;
          current = evaluate(kicked);
        } else {
          current = evaluate(startStrategy(snapshot, sp, locks, r, round, pilled));
        }
        const fit = (c) => c.result.issues.length ? -Infinity : goal(c.result.figures);
        const refine = candidate => {
          if (!sp.conditionalConsumables) return candidate;
          // Check the conditional consumable space before accepting a local optimum.
          const choices = evaluateCore.consumableChoices(candidate.strategy, sp.foods, sp.ammo);
          if (choices.reduce((n, xs) => n * xs.length, 1) <= 256) {
            const base = candidate.strategy;
            for (const main of choices[0]) for (const companion of choices[1] || [null]) {
              const n = clone(base);
              Object.assign(n, main);
              if (companion) Object.assign(n.debuff, companion);
              const c = evaluate(n);
              if (fit(c) > fit(candidate)) candidate = c;
            }
          }
          return candidate;
        };
        let failed = 0;
        for (let step = 0; step < STEPS_PER_ROUND; step++) {
          let next = null;
          const tried = new Set([keyOf(sp, current.strategy)]);
          for (let attempts = 0; attempts < NEIGHBOURS_PER_STEP * 4 && tried.size <= NEIGHBOURS_PER_STEP; attempts++) {
            const n = neighbour(snapshot, sp, locks, current.strategy, r);
            if (!n) continue;
            const normalized = canonicalStrategy(snapshot, sp, locks, n);
            const key = keyOf(sp, normalized);
            if (tried.has(key)) continue;
            tried.add(key);
            const c = evaluate(normalized, true, true);
            if (fit(c) > fit(next || current)) next = c;
          }
          if (!next && failed === 0) {
            const refined = refine(current);
            if (fit(refined) > fit(current)) next = refined;
          }
          if (!next) { if (++failed >= 2) break; continue; }
          failed = 0;
          current = next;
        }
        state.depth += 1;
        state.rng = r.state();
      }
      state.companyCounts = [...counts].sort((a, b) => a - b);
    }
    // Ids are only ever added, so the first `count` in insertion order are
    // this checkpoint's, however far a later resume has grown the set.
    const count = seen.size;
    const next = { ...state, get seen() { return seen.first(count); } };
    live.set(next, { seen, cache });

    let reported;
    const result = () => reported ||= report(snapshot, state.archive, { ...state, seeds: [seed] });
    return { get frontier() { return result().frontier; }, get picks() { return result().picks; },
      infeasible: [...explanations], get metadata() { return result().metadata; }, checkpoint: next };
  }

  /**
   * What search() returns for a checkpoint without running a round: the
   * same report, and the checkpoint itself to resume from. Skips rebuilding
   * the seen set, which a long search makes slow.
   */
  function fromCheckpoint(snapshot, checkpoint) {
    const { snapshotHash } = prepare(snapshot);
    if (!Number.isSafeInteger(checkpoint?.depth) || checkpoint.depth < 0
      || !(checkpoint.seen instanceof Uint32Array) || !Array.isArray(checkpoint.archive)) throw new Error('Invalid checkpoint.');
    if (checkpoint.snapshotHash !== snapshotHash || checkpoint.searchVersion !== SEARCH_VERSION) {
      throw new Error('The checkpoint belongs to a different snapshot or search version.');
    }
    return { ...report(snapshot, checkpoint.archive, { ...checkpoint, seeds: [checkpoint.seed] }), checkpoint };
  }

  /**
   * Several searches of one snapshot, each from its own seed, as one: the
   * frontier of their frontiers, role picks over it and summed counts.
   * Builds two searches both found count once in the frontier but in each
   * search's count. The same results merge the same in any order.
   */
  function merge(snapshot, results) {
    const sorted = [...results].sort((a, b) => a.metadata.seed - b.metadata.seed);
    // What offering each in turn would keep, in one pass over figure vectors:
    // the undominated, and of equal figures the first.
    const all = sorted.flatMap(r => r.frontier);
    // Figure vectors in one flat array, D to a build, compared in place.
    const D = MEASURES.length, v = new Float64Array(all.length * D);
    all.forEach((c, i) => MEASURES.forEach(([k, sign], d) => { v[i * D + d] = score(c.result.figures, k, sign); }));
    const beats = (i, j) => {
      let strict = false;
      for (let d = 0, a = i * D, b = j * D; d < D; d++) {
        if (v[a + d] < v[b + d]) return false;
        if (v[a + d] > v[b + d]) strict = true;
      }
      return strict;
    };
    // Of equal figures the first, by key; then highest figures first, each
    // against only those kept: a build that beats it comes earlier, and
    // whatever dropped that one beats it too.
    const first = new Map();
    for (let i = 0; i < all.length; i++) { const key = v.subarray(i * D, i * D + D).join(); if (!first.has(key)) first.set(key, i); }
    const lex = (i, j) => { for (let d = 0; d < D; d++) if (v[i * D + d] !== v[j * D + d]) return v[j * D + d] - v[i * D + d]; return 0; };
    const kept = [];
    for (const i of [...first.values()].sort(lex)) {
      if (!kept.some(j => beats(j, i))) kept.push(i);
    }
    const archive = kept.sort((a, b) => a - b).map(i => all[i]);
    const sum = (k) => sorted.reduce((s, r) => s + r.metadata[k], 0);
    return report(snapshot, compactArchive(snapshot, archive), {
      seeds: sorted.map(r => r.metadata.seed), depth: sum('depth'), evaluated: sum('evaluated'), evaluatedPilled: sum('evaluatedPilled'),
      companyCounts: [...new Set(sorted.flatMap(r => r.metadata.companyCounts))].sort((a, b) => a - b),
    });
  }

  return { SEARCH_VERSION, MODEL_SKILLS, ordinaryMaxima, search, fromCheckpoint, slim, merge, pickRoles, hash, stable };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingSearch;
