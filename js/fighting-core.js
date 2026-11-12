/*
 *  FIGHTING BUILD CORE  (pure: no DOM, no network)
 *  evaluateStrategy(snapshot, strategy) prices one candidate build from a
 *  frozen input snapshot (fighting-snapshot.js): daily damage, daily
 *  fighting cost, cost per 1,000 damage and the equipment purchase price,
 *  plus the effective skill levels and provisional-assumption labels.
 *
 *  The combat formula follows captured config and the community build
 *  article as cross-checked against the War Era frontend: soft caps,
 *  overflow, modifier order and health use are NOT the server's exposed
 *  algorithm, which is why every result carries the combat label.
 */
const FightingCore = (() => {
  // The cost curve and prestige effective levels are the Skill Point
  // Advisor's rules; don't fork them.
  const inNode = typeof module !== 'undefined' && module.exports;
  const SkillRules = inNode
    ? require('./sp-advisor-core.js') : { costToReachLevel, effectiveLevel, skillValueAtLevel };

  const SLOTS = ['weapon', 'helmet', 'chest', 'gloves', 'pants', 'boots'];
  const HOURS_PER_DAY = 24;
  // Precision over 100% spills into attack and critical chance over 100%
  // into critical damage, at four points per point (client skill metadata).
  const OVERFLOW_FACTOR = 4;
  const MISS_DAMAGE = 0.5;   // misses do half damage and can't crit (game help)
  // Each attack rolls for loot: a loot-chance point is one percentage point
  // of case1 and a hundredth of one of case2 (game help).
  const CASE_CHANCE_PER_LOOT_PCT = { case1: 1 / 100, case2: 1 / 10000 };
  // Client salvage by rarity: floor(base + bonus × state/maxState). A worn-out
  // item goes on its action at state one (estimate; server breakage unverified).
  const SCRAP = {
    common: { base: 2, bonus: 4 }, uncommon: { base: 6, bonus: 12 }, rare: { base: 18, bonus: 36 },
    epic: { base: 54, bonus: 108 }, legendary: { base: 162, bonus: 324 }, mythic: { base: 486, bonus: 972 },
  };
  const BATTLE_BONUS_DEFAULT = 0.60;
  // Bumped whenever a formula changes what a strategy evaluates to.
  const MODEL_VERSION = 'fighting-model-8';

  function effectiveSkills(snapshot, ordinary) {
    const out = {};
    for (const [name, table] of Object.entries(snapshot.config.skills)) {
      const o = ordinary[name] || 0;
      const p = snapshot.profile.prestigeBoosts?.[name] || 0;
      const level = SkillRules.effectiveLevel(o, p, snapshot.config.prestigeSkillBonusLevels ?? 1);
      const strategic = snapshot.profile.strategicBoosts?.[name] || 0;
      out[name] = { ordinary: o, prestige: p, level, strategic, value: SkillRules.skillValueAtLevel(table.values, level) + strategic };
    }
    return out;
  }

  // Ordinary points come from the profile's real budget; prestige is fixed
  // and paid from its own, so it costs nothing here.
  function skillPointIssues(snapshot, skills, spent) {
    const issues = [];
    const budget = snapshot.profile.ordinarySkillBudget;
    if (spent > budget) issues.push(`The allocation needs ${spent} skill points, over the budget of ${budget}.`);
    for (const [name, s] of Object.entries(skills)) {
      const table = snapshot.config.skills[name];
      if (s.ordinary > table.values.length - 1) {
        issues.push(`${name} level ${s.ordinary} is above the ordinary maximum of ${table.values.length - 1}.`);
      } else if (s.ordinary > 0 && table.unlockAtLevel[s.ordinary] > snapshot.profile.level) {
        issues.push(`${name} level ${s.ordinary} unlocks at player level ${table.unlockAtLevel[s.ordinary]}.`);
      }
    }
    return issues;
  }

  const sameStats = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every(k => a[k] === b[k]);
  };

  // The buyer's market tax (a percentage, client-applied from the player's
  // country) goes on top only of prices recorded before it. Tax-inclusive,
  // seller-proceeds and unknown prices are used as they are, and no seller
  // fee is ever inferred from it.
  const marketTaxPct = (snapshot) => snapshot.countries?.[snapshot.profile.countryId]?.taxes?.market || 0;
  const buyCost = (snapshot, entry) => entry?.value == null ? null
    : entry.taxBasis === 'pre-buyer-tax' ? entry.value * (1 + marketTaxPct(snapshot) / 100) : entry.value;

  // A price is stale once it is older than the freshness threshold at the
  // snapshot's as-of time, or when its last refresh failed. Manual prices
  // never go stale; a market price of unknown age is stale once a clock is set.
  const HOUR_MS = 3600e3;
  function isStale(snapshot, entry) {
    if (!entry || entry.source === 'manual') return false;
    if (entry.refreshFailedAt) return true;
    if (!snapshot.asOf) return false;
    if (!entry.fetchedAt) return true;
    const hours = snapshot.settings.freshnessHours ?? 24;
    return Date.parse(snapshot.asOf) - Date.parse(entry.fetchedAt) > hours * HOUR_MS;
  }

  const provenance = (snapshot, entry, fields) => ({
    ...fields,
    value: entry ? entry.value ?? entry.price ?? null : null,
    cost: fields.role === 'loot' ? entry?.value ?? null : buyCost(snapshot, entry && { ...entry, value: entry.value ?? entry.price }),
    fetchedAt: entry?.fetchedAt ?? null,
    tradeDate: entry?.tradeDate ?? null,
    taxBasis: entry?.taxBasis || 'unknown',
    source: entry?.source || (entry ? 'market' : null),
    stale: isStale(snapshot, entry),
  });

  /**
   * Whole items to buy to fight for `days`: consumables as used, and gear
   * for every item that wears out in the period, the first set included
   * unless `ownGear` (it then starts the period fully repaired). A count or
   * price that's unknown leaves the total unknown.
   */
  function shoppingList(result, days, { ownGear = false } = {}) {
    const whole = (x) => Math.max(0, Math.ceil(x - 1e-9));
    const rows = result.usage.map(u => {
      const quantity = u.perDay == null ? null
        : u.role === 'equipment' ? Math.max(ownGear ? 0 : 1, whole(u.perDay * days) - (ownGear ? 1 : 0))
        : whole(u.perDay * days);
      return { ...u, quantity, cost: quantity == null || u.unitCost == null ? null : quantity * u.unitCost };
    });
    return { days, rows, total: sumOrNull(rows.map(r => r.cost)) };
  }

  // The whole percent a soft-capped stat applies, as the game rounds it.
  const softCapPercent = (total, softCap) => Math.round(100 * total / (total + softCap));

  // A target is a priced stat roll, not a live listing, so it is always an
  // estimate; an unpriced target keeps its stats but has no price or durability.
  function resolveTarget(snapshot, slot, ref) {
    const priced = (snapshot.equipment[ref.code] || []).find(t => sameStats(t.stats, ref.stats));
    return { slot, code: ref.code, stats: { ...ref.stats }, estimate: true,
             rarity: snapshot.config.items[ref.code]?.rarity ?? null,
             price: priced ? buyCost(snapshot, { ...priced, value: priced.price }) : null,
             maxState: priced ? priced.maxState : null,
             samples: priced ? priced.samples : 0,
             priceEntry: priced || null };
  }

  const priceOf = (snapshot, code) => snapshot.prices[code]?.value ?? null;
  const buyPriceOf = (snapshot, code) => buyCost(snapshot, snapshot.prices[code]);
  const sumOrNull = (xs) => xs.some(x => x == null) ? null : xs.reduce((s, x) => s + x, 0);

  // Income streams in ledger order. Each is disjoint: materials, wages and
  // manager pay sit inside a stream's net figure and are never deducted again.
  const STREAMS = [
    { id: 'production', label: 'Engines and self-work' },
    { id: 'employees',  label: 'Employees after wages and managers' },
    { id: 'manager',    label: 'Your manager job' },
    { id: 'bounty',     label: 'Bounty' },
    { id: 'cases',      label: 'Cases', saleProceeds: true },
    { id: 'scrap',      label: 'Scrap', saleProceeds: true },
  ];
  // Every player can run two companies before any company skill; a build
  // never runs fewer.
  const MIN_COMPANIES = 2;
  const streamEnabled = (snapshot, id) => snapshot.settings.incomeToggles?.[id] !== false;

  const skillValueOf = (skills, k) => skills[k]?.value || 0;

  // The owner's Management and a hired manager each add this many percent
  // to every employee's output bonus per point (client config
  // managementBonusPercentPerLevel), with no cap on either or both
  // together: live rosters show 24% + 24% (2026-11-08).
  const MANAGEMENT_PCT_PER_POINT = 2;
  const ENERGY_PER_ACTION = 10;
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  // Money per production point of an item at Employee Training's prices,
  // the average of recent trades: (sale price − inputs) ÷ productionPoints.
  // null when anything is unpriced.
  const productPrice = (snapshot, code) => snapshot.production?.prices?.[code]?.value ?? null;
  function marginPerPP(snapshot, code) {
    const it = snapshot.production?.items?.[code];
    const sale = productPrice(snapshot, code);
    if (!(it?.productionPoints > 0) || sale == null) return null;
    let inputs = 0;
    for (const [input, qty] of Object.entries(it.productionNeeds || {})) {
      const p = productPrice(snapshot, input);
      if (p == null) return null;
      inputs += qty * p;
    }
    return (sale - inputs) / it.productionPoints;
  }
  const engineDailyProd = (snapshot, level) => snapshot.config.upgradesConfig?.automatedEngine?.levels?.[level]?.stats?.dailyProd || 0;

  /*
   *  What a build's skills don't change, worked out once per snapshot: each
   *  owned company's margin, engine output and staff, the product self-work
   *  and new companies make, and the median company a new one copies.
   *
   *  Self-work and new companies make the best-margin product among the
   *  enabled companies (the market's best when there are none), so they
   *  don't depend on which companies a build keeps.
   */
  const prepared = new WeakMap();
  function preparedProduction(snapshot) {
    if (prepared.has(snapshot)) return prepared.get(snapshot);
    const production = snapshot.production;
    let out = null;
    if (production) {
      const companies = production.companies.map(c => ({ ...c, margin: c.item ? marginPerPP(snapshot, c.item) : null,
        enginePP: c.disabled ? 0 : engineDailyProd(snapshot, c.engineLevel) }));
      const enabled = companies.filter(c => !c.disabled);
      const best = (codes) => codes.map(code => ({ item: code, margin: marginPerPP(snapshot, code) }))
        .filter(t => t.margin != null).sort((a, b) => b.margin - a.margin || a.item.localeCompare(b.item))[0] || null;
      const target = best([...new Set(enabled.map(c => c.item).filter(Boolean))]) || best(Object.keys(production.items));
      const engineLevel = Math.round(median(enabled.map(c => c.engineLevel)) ?? 1);
      const template = {
        engineLevel, enginePP: engineDailyProd(snapshot, engineLevel),
        slots: Math.max(1, Math.round(median(enabled.map(c => c.breakRoom)) ?? 1)),
        // Every current employee, as a new company's hire might be (no manager).
        employees: enabled.flatMap(c => c.employees || []),
      };
      // Prices the income rests on, for staleness.
      const codes = new Set(target ? [target.item] : []);
      for (const c of enabled) if (c.item) codes.add(c.item);
      for (const code of [...codes]) Object.keys(production.items[code]?.productionNeeds || {}).forEach(k => codes.add(k));
      out = { companies, target, template, priceCodes: [...codes] };
    }
    prepared.set(snapshot, out);
    return out;
  }

  // An employee a day at an output bonus: PP made, and money after wages.
  function employeeDay(e, bonusPct, margin) {
    if (e.baseOutput == null || e.otherBonusPct == null || e.wage == null) return null;
    const outputPP = HOURS_PER_DAY * e.baseOutput * (1 + (e.otherBonusPct + bonusPct) / 100);
    return { outputPP, wage: HOURS_PER_DAY * e.wage, contribution: outputPP * margin - HOURS_PER_DAY * e.wage };
  }

  /*
   *  One company a day at the owner's Management bonus. Employees who'd
   *  lose money are let go (their wage is the game's, so firing is the only
   *  lever). A hired manager adds their bonus to every employee for a fixed
   *  hourly pay; one who costs more than they add is let go.
   *  An inactive manager gives no bonus and accrues no pay (manager-core.js).
   *  A disabled company produces nothing and pays nobody.
   */
  function companyDay(c, ownerPct) {
    const base = { id: c.id, name: c.name, item: c.item, margin: c.margin, disabled: c.disabled, engineLevel: c.engineLevel };
    if (c.disabled) return { ...base, value: 0, engineIncome: 0, employeesIncome: 0, enginePP: 0, staff: [], manager: null };
    if (c.margin == null || c.employees == null) return { ...base, value: null, engineIncome: null, employeesIncome: null, enginePP: c.enginePP, staff: [], manager: null };
    const run = (managerPct) => {
      const staff = c.employees.map(e => ({ id: e.id, name: e.name, ...employeeDay(e, ownerPct + managerPct, c.margin) }));
      const unknown = staff.some(e => e.contribution == null);
      for (const e of staff) e.kept = e.contribution > 0;
      return { staff, amount: unknown ? null : staff.reduce((sum, e) => sum + (e.kept ? e.contribution : 0), 0) };
    };
    let result = run(0), manager = null;
    if (c.manager) {
      if (c.manager.inactive) manager = { bonusPct: 0, pay: 0, adds: 0, kept: true, inactive: true };
      else {
        const withManager = run(c.manager.bonusPct);
        const pay = HOURS_PER_DAY * c.manager.hourlyWage;
        const adds = withManager.amount == null || result.amount == null ? null : withManager.amount - result.amount;
        const kept = adds != null && adds > pay;
        manager = { bonusPct: c.manager.bonusPct, pay, adds, kept, inactive: false };
        if (kept) result = withManager;
      }
    }
    const employeesIncome = result.amount == null ? null : result.amount - (manager?.kept ? manager.pay : 0);
    const engineIncome = c.enginePP * c.margin;
    return { ...base, value: employeesIncome == null ? null : engineIncome + employeesIncome,
             engineIncome, employeesIncome, enginePP: c.enginePP, staff: result.staff, manager };
  }

  /*
   *  The company count is the companies skill's capacity, built and run.
   *  Owned companies run as they are today (product, engine, Break Room,
   *  roster, manager), at this build's Management bonus. With fewer places
   *  than companies the least profitable are left out; each place beyond
   *  them is a new company like the median one: its engine level and Break
   *  Room, each place an employee earning what the median current one
   *  would there, making the self-work product. Construction is free.
   */
  function companyPortfolio(snapshot, skills) {
    const count = Math.max(MIN_COMPANIES, Math.floor(skillValueOf(skills, 'companies')));
    const prep = preparedProduction(snapshot);
    const unknown = { capacity: count, count, owned: 0, kept: [], dropped: [], newCompanies: 0, newCompany: null,
                      target: prep?.target || null, engineIncome: null, employeesIncome: null };
    if (!prep) return unknown;
    const ownerPct = MANAGEMENT_PCT_PER_POINT * skillValueOf(skills, 'management');
    const rows = prep.companies.map(c => companyDay(c, ownerPct));
    if (rows.some(r => !r.disabled && r.value == null)) return { ...unknown, owned: rows.length };
    const order = rows.map((r, i) => i).sort((a, b) => rows[b].value - rows[a].value || a - b);
    const keptSet = new Set(order.slice(0, count));
    const kept = rows.filter((r, i) => keptSet.has(i)), dropped = rows.filter((r, i) => !keptSet.has(i));
    const newCompanies = Math.max(0, count - rows.length);
    let newCompany = null;
    if (newCompanies && prep.target) {
      const { template, target } = prep;
      const days = template.employees.map(e => employeeDay(e, ownerPct, target.margin)?.contribution).filter(x => x != null);
      const perEmployee = days.length ? Math.max(0, median(days)) : 0;
      newCompany = { engineLevel: template.engineLevel, slots: template.slots, perEmployee, hired: days.length > 0,
                     engineIncome: template.enginePP * target.margin, employeesIncome: template.slots * perEmployee };
    }
    if (newCompanies && !newCompany) return { ...unknown, owned: rows.length };
    const sum = (key) => kept.reduce((s, r) => s + r[key], 0) + newCompanies * (newCompany?.[key] || 0);
    return { capacity: count, count, owned: rows.length, kept, dropped, newCompanies, newCompany, target: prep.target,
             engineIncome: sum('engineIncome'), employeesIncome: sum('employeesIncome') };
  }

  // Company valuation depends only on these skills and the snapshot, and
  // dominates evaluation time, so a search reuses it per snapshot.
  const PORTFOLIO_SKILLS = ['companies', 'management'];
  const portfolios = new WeakMap();
  function cachedPortfolio(snapshot, skills) {
    let bySkills = portfolios.get(snapshot);
    if (!bySkills) portfolios.set(snapshot, bySkills = new Map());
    const key = PORTFOLIO_SKILLS.map(k => skillValueOf(skills, k)).join(',');
    if (!bySkills.has(key)) {
      if (bySkills.size >= 1024) bySkills.delete(bySkills.keys().next().value);
      bySkills.set(key, companyPortfolio(snapshot, skills));
    }
    return bySkills.get(key);
  }

  // The owner's energy spent on self-work: 10 energy a work, each making
  // the Production skill's value in PP of the self-work product (no bonus).
  // Energy regenerates a tenth of the bar an hour. A product that loses
  // money isn't worked.
  function selfWork(snapshot, skills) {
    const target = preparedProduction(snapshot)?.target;
    const cost = snapshot.config.energyCostPerAction || ENERGY_PER_ACTION;
    const worksPerDay = HOURS_PER_DAY / snapshot.config.regenDividedBy * skillValueOf(skills, 'energy') / cost;
    const outputPP = worksPerDay * skillValueOf(skills, 'production');
    return { worksPerDay, outputPP, item: target?.item ?? null, margin: target?.margin ?? null,
             income: target ? outputPP * Math.max(0, target.margin) : null };
  }

  // The player's own manager job: their Management points at a rate per
  // point an hour (the market average unless set), after their country's
  // manager tax. Manager jobs open at a player level.
  function managerJob(snapshot, skills) {
    const points = skillValueOf(skills, 'management');
    const openAt = snapshot.config.managerJobLevel;
    if (openAt != null && (snapshot.profile.level ?? 0) < openAt) return { points, rate: null, taxPct: 0, openAt, income: 0, locked: true };
    const rate = snapshot.settings.managerRate ?? snapshot.production?.managerRate ?? null;
    const taxPct = snapshot.countries?.[snapshot.profile.countryId]?.taxes?.manager || 0;
    return { points, rate, taxPct, openAt, locked: false,
             income: rate == null ? null : HOURS_PER_DAY * points * rate * (1 - taxPct / 100) };
  }

  const muHelp = (snapshot) => Math.max(0, snapshot.settings.muHelpHealthPerDay || 0);

  function labels(snapshot, equipment, companies, pilled) {
    const bonusPct = Math.round(snapshot.settings.battleBonus * 1000) / 10;
    const out = [
      { id: 'combat-model', text: 'Combat modifier order, soft caps and health rounding are estimates from captured config and client code; the server algorithm is not exposed.' },
      { id: 'battle-bonus', text: snapshot.settings.battleBonus === BATTLE_BONUS_DEFAULT
        ? `Battle-damage bonus of ${bonusPct}% (accepted default, editable).`
        : `Battle-damage bonus of ${bonusPct}% (your setting; the accepted default is ${BATTLE_BONUS_DEFAULT * 100}%).` },
    ];
    if (equipment.length) out.push({ id: 'wear', text: 'Equipment durability and wear follow client bookkeeping; server breakage is unverified.' });
    if (equipment.length && streamEnabled(snapshot, 'scrap')) {
      out.push({ id: 'scrap', text: 'Scrap assumes each worn-out item salvages by the client formula at its last state, one; server breakage salvage is unverified. Valued as estimated sale proceeds.' });
    }
    if (streamEnabled(snapshot, 'cases')) {
      out.push({ id: 'cases', text: 'Cases assume only hits roll for loot, at your loot chance, so misses from precision below 100% earn none; case eligibility is unverified. Valued as estimated sale proceeds.' });
    }
    if (muHelp(snapshot) > 0) {
      out.push({ id: 'mu-help', text: `Military-unit help of ${muHelp(snapshot)} health a day is your own estimate, not verified game evidence.` });
    }
    const strategic = Object.entries(snapshot.profile.strategicBoosts || {}).filter(([, v]) => v > 0);
    if (strategic.length) {
      out.push({ id: 'strategic', text: `Skill values include today's strategic-resource bonuses (${strategic.map(([k, v]) => `+${v} ${k}`).join(', ')}), which follow your country's resources.` });
    }
    const production = streamEnabled(snapshot, 'production'), employees = streamEnabled(snapshot, 'employees');
    if (production && companies.selfWork.outputPP > 0) {
      out.push({ id: 'self-work', text: 'Self-work spends all your energy; energy spent training or hiring employees is counted as self-work, which it would otherwise earn.' });
    }
    if ((production || employees) && snapshot.production) {
      out.push({ id: 'product-prices', text: 'Products and their inputs are priced at the average of their latest trades over the past day, as in Employee Training.' });
    }
    if (employees && companies.owned > 0) {
      out.push({ id: 'roster', text: "Employees are valued as they are today (bonuses, events, tools, specialization and wages); this build's Management changes only its own bonus. Anyone who would lose money is let go, and so is a manager who costs more than they add." });
    }
    if ((production || employees) && companies.newCompany) {
      const n = companies.newCompanies, c = companies.newCompany;
      out.push({ id: 'new-companies', text: `${n} new compan${n === 1 ? 'y copies' : 'ies copy'} your median company: engine level ${c.engineLevel} and ${c.slots} employee${c.slots === 1 ? '' : 's'}${c.hired ? ' each earning what your median employee would there' : ' (no employees to copy, so none)'}, making the self-work product. Building ${n === 1 ? 'it' : 'them'} is free.` });
    }
    const job = companies.managerJob;
    if (streamEnabled(snapshot, 'manager') && !job.locked && job.rate != null) {
      out.push({ id: 'manager-job', text: `Your manager job pays ${job.rate.toFixed(4)} per Management point an hour (${snapshot.settings.managerRate != null ? 'your setting' : 'the market average'})${job.taxPct ? `, less your country's ${job.taxPct}% manager tax` : ''}; the tax of the company's country may differ.` });
    }
    if (pilled) {
      out.push({ id: 'pill-repeat', text: 'The pill is repeated only once its debuff has ended (your confirmation), with an equal-magnitude attack debuff after the buff (first-party help); durations come from the captured config.' });
      out.push({ id: 'gear-swap', text: 'Swapping gear between the buff and debuff phases keeps stored health and hunger (your experience; not verified against the server).' });
    }
    return out;
  }

  // One phase of fighting: a loadout used for a given number of health and
  // hunger bars a day, at an attack multiplier (1 unpilled, the pill's buff
  // or debuff otherwise). Bars are full-bar equivalents: 2.4 a day at a ten-
  // hour refill is not 2.4 discrete fights. Each hunger point eats one food,
  // which restores a percentage of max health.
  function fightPhase(snapshot, skillStats, loadout, { healthBarsPerDay, hungerBarsPerDay, attackMultiplier }, resolve = resolveTarget) {
    const { config, settings, profile } = snapshot;
    const equipment = SLOTS.filter(slot => loadout.equipment?.[slot])
      .map(slot => resolve(snapshot, slot, loadout.equipment[slot]));
    const stats = { ...skillStats };
    for (const e of equipment) for (const [k, v] of Object.entries(e.stats)) stats[k] = (stats[k] || 0) + v;
    const stat = (k) => stats[k] || 0;

    const weapon = equipment.find(e => e.slot === 'weapon');
    const ammo = weapon && config.items[weapon.code]?.usesAmmo && loadout.ammo ? loadout.ammo : null;
    const food = loadout.food || null;

    const healPerFood = food ? (config.items[food]?.healthRegenPercent || 0) / 100 * stat('health') : 0;
    const foodPerDay = food ? hungerBarsPerDay * stat('hunger') : 0;
    const healthPerDay = healthBarsPerDay * stat('health') + foodPerDay * healPerFood;

    // Armor and dodge follow total / (total + softCap), rounded to a whole
    // percent as the game does (softcap.js checks it against the API), so
    // points within one percent buy nothing. Armor cuts the health an attack
    // costs; a dodge costs none.
    const softCapped = (k) => softCapPercent(stat(k), config.skills[k].softCap) / 100;
    const armorReduction = softCapped('armor');
    const dodgeChance = softCapped('dodge');
    const attacksPerDay = healthPerDay / (config.healthCost * (1 - armorReduction) * (1 - dodgeChance));

    const hitChance = Math.min(1, stat('precision') / 100);
    const critChance = Math.min(1, stat('criticalChance') / 100);
    const critDamage = stat('criticalDamages') + Math.max(0, stat('criticalChance') - 100) * OVERFLOW_FACTOR;
    const ammoPct = ammo ? (config.items[ammo]?.percentAttack || 0) : 0;
    const attack = (stat('attack') + Math.max(0, stat('precision') - 100) * OVERFLOW_FACTOR)
      * (1 + ammoPct / 100) * attackMultiplier * (1 + (settings.rankDamagePct ?? profile.rankDamagePct ?? 0) / 100) * (1 + settings.battleBonus);
    const damagePerAttack = attack * ((1 - hitChance) * MISS_DAMAGE + hitChance * (1 + critChance * critDamage / 100));

    // Wear: the weapon loses one state per attack, armour only when the
    // attack isn't dodged. The client removes an item on the action taken
    // at state one (after maxState − 1 decrements), so it lasts maxState actions.
    const retirements = equipment.map(e => e.maxState == null ? null
      : attacksPerDay * (e.slot === 'weapon' ? 1 : 1 - dodgeChance) / e.maxState);
    const ammoPrice = ammo ? buyPriceOf(snapshot, ammo) : 0;
    const foodPrice = food ? buyPriceOf(snapshot, food) : 0;
    const fightingCost = {
      ammo: ammoPrice == null ? null : attacksPerDay * ammoPrice,
      food: foodPrice == null ? null : foodPerDay * foodPrice,
      wear: sumOrNull(equipment.map((e, i) => e.price == null ? null : e.price * retirements[i])),
    };
    return {
      equipment, ammo, food, stats, retirements, fightingCost,
      loadoutPrice: sumOrNull(equipment.map(e => e.price)),
      healthPerDay, foodPerDay, attacksPerDay, damagePerAttack, dailyDamage: damagePerAttack * attacksPerDay,
      hitChance, critChance, armorReduction, dodgeChance,
    };
  }

  // The pill schedule's resource envelope: a dose is taken with one stored
  // bar, everything regenerated during the buff is spent as it arrives, and
  // the debuff spends what it regenerates except the last refill window,
  // which is stored for the next dose (no repeat before the debuff ends).
  // Over a period P with buff B and refill rate r bars an hour: the buff
  // spends 1 + B·r and the debuff (P − B)·r − 1, all P·r regenerated bars.
  // Bars stay constant across phases: current gear has no bar stats and
  // swapping it doesn't reset or rescale stored resources.
  function pillCycle(buffHours, debuffHours, ratePerHour) {
    const debuffBars = debuffHours * ratePerHour - 1;
    return { buff: 1 + buffHours * ratePerHour, debuff: Math.max(0, debuffBars) };
  }

  const INCOME_SKILLS = ['companies', 'production', 'management', 'energy'];

  // The company streams at a build's skills: engines plus self-work, staff
  // after wages and managers, and the player's own manager job.
  function companyIncome(snapshot, skills) {
    const portfolio = cachedPortfolio(snapshot, skills);
    const work = selfWork(snapshot, skills), job = managerJob(snapshot, skills);
    return {
      companies: { ...portfolio, selfWork: work, managerJob: job },
      amounts: {
        production: portfolio.engineIncome == null || work.income == null ? null : portfolio.engineIncome + work.income,
        employees: portfolio.employeesIncome,
        manager: job.income,
      },
    };
  }

  function incomeAtSkills(snapshot, skills) {
    const { amounts } = companyIncome(snapshot, skills);
    return sumOrNull(Object.entries(amounts).filter(([k]) => streamEnabled(snapshot, k)).map(([, v]) => v));
  }

  function incomeForSkills(snapshot, ordinary) {
    return incomeAtSkills(snapshot, effectiveSkills(snapshot, ordinary));
  }

  function createIncomeEvaluator(snapshot) {
    const levels = Object.fromEntries(INCOME_SKILLS.filter(k => snapshot.config.skills[k]).map(k => {
      const table = snapshot.config.skills[k];
      return [k, table.values.map((_, ordinary) => effectiveSkills(snapshot, { [k]: ordinary })[k])];
    }));
    return ordinary => incomeAtSkills(snapshot, Object.fromEntries(Object.entries(levels).map(([k, values]) => [k, values[ordinary[k] || 0]])));
  }

  function createSearchEvaluator(snapshot) {
    const phases = new Map(), stale = new Map(), targets = new Map();
    const targetRefs = new WeakMap(), snapshotStats = new WeakSet();
    let preparing = true;
    const target = (slot, ref) => {
      let bySlot = targetRefs.get(ref.stats);
      if (!bySlot) {
        bySlot = new Map();
        if (snapshotStats.has(ref.stats)) targetRefs.set(ref.stats, bySlot);
      }
      const identity = `${slot}|${ref.code}`;
      if (!bySlot.has(identity)) {
        // Property order is part of the full evaluator's ownership identity.
        const key = `${slot}|${ref.code}|${JSON.stringify(ref.stats)}`;
        if (!targets.has(key)) {
          const record = resolveTarget(snapshot, slot, ref);
          if (!preparing) return { id: key, record };
          targets.set(key, { id: targets.size + 1, record });
        }
        bySlot.set(identity, targets.get(key));
      }
      return bySlot.get(identity);
    };
    for (const [code, rows] of Object.entries(snapshot.equipment)) {
      const slot = snapshot.config.items[code]?.slot;
      if (slot) for (const row of rows) {
        snapshotStats.add(row.stats);
        target(slot, { code, stats: row.stats });
      }
    }
    preparing = false;
    const skillKeys = Object.keys(snapshot.config.skills);
    const skillLevels = Object.fromEntries(skillKeys.map(k => [k, snapshot.config.skills[k].values
      .map((_, ordinary) => effectiveSkills(snapshot, { [k]: ordinary })[k])]));
    const combatKeys = skillKeys.filter(k => !INCOME_SKILLS.includes(k) && k !== 'lootChance');
    const context = {
      skills(ordinary) {
        const out = {};
        for (const k of skillKeys) {
          const level = ordinary[k] || 0;
          out[k] = skillLevels[k][level] || effectiveSkills(snapshot, { [k]: level })[k];
        }
        return out;
      },
      stale(entry) {
        if (!stale.has(entry)) stale.set(entry, isStale(snapshot, entry));
        return stale.get(entry);
      },
      phase(stats, loadout, envelope) {
        const key = JSON.stringify([combatKeys.map(k => stats[k]),
          SLOTS.map(slot => { const t = loadout.equipment?.[slot]; return t ? target(slot, t).id : 0; }),
          loadout.food, loadout.ammo, envelope.healthBarsPerDay, envelope.hungerBarsPerDay, envelope.attackMultiplier]);
        if (!phases.has(key)) {
          if (phases.size >= 512) phases.delete(phases.keys().next().value);
          const phase = fightPhase(snapshot, stats, loadout, envelope, (_, slot, ref) => target(slot, ref).record);
          phases.set(key, { phase, gearLoot: phase.equipment.filter(e => 'lootChance' in e.stats).map(e => e.stats.lootChance) });
        }
        const { phase, gearLoot } = phases.get(key);
        return { ...phase, stats: { ...phase.stats, lootChance: gearLoot.reduce((sum, value) => (sum || 0) + value, stats.lootChance || 0) } };
      },
    };
    const evaluate = strategy => evaluateStrategy(snapshot, strategy, context);
    // A skill loot point changes only case revenue. Refuse the reduction when
    // missing/stale prices could change eligibility as loot becomes positive.
    evaluate.lootOptimizable = !streamEnabled(snapshot, 'cases') || Object.keys(CASE_CHANCE_PER_LOOT_PCT)
      .every(code => priceOf(snapshot, code) != null && !context.stale(snapshot.prices[code]));
    evaluate.lootIncomePerPoint = strategy => {
      if (!streamEnabled(snapshot, 'cases')) return 0;
      const stats = Object.fromEntries(Object.entries(context.skills(strategy.skills)).map(([k, v]) => [k, v.value]));
      const { phases } = strategyPhases(snapshot, strategy, stats, context);
      return phases.reduce((sum, p) => sum + p.attacksPerDay * p.hitChance, 0)
        * Object.entries(CASE_CHANCE_PER_LOOT_PCT).reduce((sum, [code, chance]) => sum + chance * priceOf(snapshot, code), 0);
    };
    evaluate.consumableChoices = (strategy, foods, ammunition) => {
      const stats = Object.fromEntries(Object.entries(context.skills(strategy.skills)).map(([k, v]) => [k, v.value]));
      const original = strategyPhases(snapshot, strategy, stats, context).phases;
      return original.map((_, index) => {
        const loadout = index ? { ...strategy, ...strategy.debuff } : strategy;
        if (index && snapshot.settings.sameGearBothPhases) loadout.equipment = strategy.equipment;
        const gun = snapshot.config.items[loadout.equipment?.weapon?.code]?.usesAmmo;
        const rows = [null, ...foods].flatMap(food => (gun ? ammunition : [null]).map(ammo => {
          const choice = { food, ammo };
          const changed = index ? { ...strategy, debuff: { ...strategy.debuff, ...choice } } : { ...strategy, ...choice };
          const p = strategyPhases(snapshot, changed, stats, context).phases[index];
          // More attacks also mean more salvage and case income. Requiring
          // identical attacks avoids assuming either reward has a known price.
          return { choice, damage: p.dailyDamage, cost: sumOrNull(Object.values(p.fightingCost)),
            attacks: p.attacksPerDay,
            stale: [food, ammo].some(code => code && context.stale(snapshot.prices[code])) };
        }));
        return rows.filter((r, i) => !rows.some((a, j) => j !== i && a.attacks === r.attacks && a.stale === r.stale
          && a.cost != null && r.cost != null && a.damage >= r.damage && a.cost <= r.cost
          && (a.damage > r.damage || a.cost < r.cost || j < i))).map(r => r.choice);
      });
    };
    return evaluate;
  }

  function strategyPhases(snapshot, strategy, skillStats, context) {
    const { config, settings } = snapshot;
    const phaseResult = (loadout, envelope) => context
      ? context.phase(skillStats, loadout, envelope) : fightPhase(snapshot, skillStats, loadout, envelope);
    const refillsPerDay = HOURS_PER_DAY / config.regenDividedBy;
    const loadout = { equipment: strategy.equipment, food: strategy.food, ammo: strategy.ammo };
    const pill = strategy.pill ? config.items[strategy.pill] || { code: strategy.pill } : null;
    // MU help adds the player's own health-a-day estimate, as bars of their
    // max health, only when above zero.
    const muBarsPerDay = skillStats.health > 0 ? muHelp(snapshot) / skillStats.health : 0;
    let phases, schedule = null;
    if (!pill) {
      phases = [{ phase: 'unpilled', hours: HOURS_PER_DAY,
        ...phaseResult(loadout,
          { healthBarsPerDay: refillsPerDay + muBarsPerDay, hungerBarsPerDay: refillsPerDay, attackMultiplier: 1 }) }];
    } else {
      const buffHours = pill.buffHours, debuffHours = pill.debuffHours;
      const periodHours = buffHours + debuffHours;
      const cyclesPerDay = HOURS_PER_DAY / periodHours;
      const regenPerHour = 1 / config.regenDividedBy;
      const health = pillCycle(buffHours, debuffHours, regenPerHour + muBarsPerDay / HOURS_PER_DAY);
      const hunger = pillCycle(buffHours, debuffHours, regenPerHour);
      const companion = { ...loadout, ...(strategy.debuff || {}) };
      if (settings.sameGearBothPhases) companion.equipment = loadout.equipment;
      const pct = (pill.percentAttack || 0) / 100;
      phases = [['buff', buffHours, loadout, 1 + pct], ['debuff', debuffHours, companion, Math.max(0, 1 - pct)]]
        .map(([phase, hours, l, attackMultiplier]) => ({
          phase, hours, healthBarsPerCycle: health[phase], hungerBarsPerCycle: hunger[phase],
          ...phaseResult(l, { attackMultiplier,
            healthBarsPerDay: health[phase] * cyclesPerDay, hungerBarsPerDay: hunger[phase] * cyclesPerDay }),
        }));
      schedule = { pill: pill.code, periodHours, buffHours, debuffHours, pillsPerDay: cyclesPerDay };
    }

    return { phases, schedule, pill };
  }

  /**
   * strategy: { skills: { [skill]: ordinaryLevel }, equipment: { [slot]: { code, stats } | null },
   *             food: itemCode | null, ammo: itemCode | null,
   *             pill?: itemCode, debuff?: { equipment, food, ammo } }
   * Without a pill the build is unpilled. With one, the top-level loadout is
   * the buff phase and `debuff` the companion it shares skills, prestige and
   * companies with (the same loadout if absent; settings.sameGearBothPhases
   * keeps the buff equipment and only the companion's consumables).
   */
  function evaluateStrategy(snapshot, strategy, context = null) {
    const { config, settings, profile } = snapshot;
    const skills = context ? context.skills(strategy.skills || {}) : effectiveSkills(snapshot, strategy.skills || {});
    const spent = Object.values(skills).reduce((s, k) => s + SkillRules.costToReachLevel(k.ordinary), 0);
    const issues = skillPointIssues(snapshot, skills, spent);
    const skillStats = {};
    for (const [name, s] of Object.entries(skills)) skillStats[name] = s.value;

    const { phases, schedule, pill } = strategyPhases(snapshot, strategy, skillStats, context);

    // Attacks with a gun and no ammunition are refused (your confirmation);
    // only the knife fights without it. Any ammunition fits any gun.
    for (const p of phases) {
      const gun = p.equipment.find(e => e.slot === 'weapon' && config.items[e.code]?.usesAmmo);
      if (gun && !p.ammo) {
        issues.push(`The ${p.phase === 'unpilled' ? '' : `${p.phase} phase's `}${gun.code} needs ammunition: attacks with a gun and none are refused.`);
      }
    }
    const sum = (f) => phases.reduce((s, p) => s + f(p), 0);
    const attacksPerDay = sum(p => p.attacksPerDay);
    const dailyDamage = sum(p => p.dailyDamage);
    const pillPrice = pill ? buyPriceOf(snapshot, pill.code) : 0;
    const fightingCost = {
      ammo: sumOrNull(phases.map(p => p.fightingCost.ammo)),
      food: sumOrNull(phases.map(p => p.fightingCost.food)),
      wear: sumOrNull(phases.map(p => p.fightingCost.wear)),
      pill: pillPrice == null ? null : (schedule ? schedule.pillsPerDay * pillPrice : 0),
    };
    const dailyFightingCost = sumOrNull(Object.values(fightingCost));

    // Every distinct target once: an item kept on across phases is bought once.
    const owned = new Map();
    phases.forEach(p => p.equipment.forEach((e, i) => {
      const key = `${e.slot}|${e.code}|${JSON.stringify(e.stats)}`;
      const o = owned.get(key) || { ...e, retirementsPerDay: 0, phases: [] };
      o.phases.push(p.phase);
      o.retirementsPerDay = o.retirementsPerDay == null || p.retirements[i] == null ? null : o.retirementsPerDay + p.retirements[i];
      owned.set(key, o);
    }));
    const equipment = [...owned.values()];
    const equipmentPurchasePrice = sumOrNull(equipment.map(e => e.price));

    // Rewards are income, never netted off the gross fighting cost: wear
    // buys a whole replacement and the worn-out item's salvage is scrap.
    // Only hits roll for loot (unverified; see the cases assumption).
    const lootPct = sum(p => p.attacksPerDay * p.hitChance * (p.stats.lootChance || 0));
    const cases = Object.fromEntries(Object.entries(CASE_CHANCE_PER_LOOT_PCT).map(([code, perPct]) => [code, lootPct * perPct]));
    const salvage = (e) => Math.floor(SCRAP[e.rarity].base + SCRAP[e.rarity].bonus / e.maxState);
    const scraps = sumOrNull(equipment.map(e => e.retirementsPerDay == null || !SCRAP[e.rarity] ? null
      : e.retirementsPerDay * salvage(e)));
    // Item counts a day valued at market; a code needs a price only if any drop.
    const unpriced = (counts) => Object.keys(counts).filter(code => counts[code] > 0 && priceOf(snapshot, code) == null);
    const marketValue = (counts) => Object.values(counts).some(n => n == null) || unpriced(counts).length ? null
      : Object.entries(counts).reduce((sum, [code, n]) => sum + (n && n * priceOf(snapshot, code)), 0);

    const { companies, amounts: company } = companyIncome(snapshot, skills);
    const amounts = {
      ...company,
      bounty: dailyDamage * Math.max(0, settings.bountyPer1000 || 0) / 1000,
      cases: marketValue(cases),
      scrap: marketValue({ scraps }),
    };
    const ledger = STREAMS.map(s => ({ ...s, amount: amounts[s.id], enabled: streamEnabled(snapshot, s.id) }));
    const dailyBalance = dailyFightingCost == null ? null
      : sumOrNull([...ledger.filter(r => r.enabled).map(r => r.amount), -dailyFightingCost]);
    const consumables = [...new Set(phases.flatMap(p => [p.ammo, p.food]).filter(Boolean))];
    const missingPrices = [...new Set([
      ...equipment.filter(e => e.price == null).map(e => e.code),
      ...consumables.filter(code => buyPriceOf(snapshot, code) == null),
      ...(pill && pillPrice == null ? [pill.code] : []),
      ...(streamEnabled(snapshot, 'cases') ? unpriced(cases) : []),
      ...(streamEnabled(snapshot, 'scrap') ? unpriced({ scraps }) : []),
    ])];
    // Without a rarity a worn-out item's salvage is unknown.
    const missingRarity = streamEnabled(snapshot, 'scrap') ? equipment.filter(e => !SCRAP[e.rarity]).map(e => e.code) : [];

    const lootCodes = (streamEnabled(snapshot, 'cases') ? Object.keys(cases).filter(c => cases[c] > 0) : [])
      .concat(streamEnabled(snapshot, 'scrap') && scraps > 0 ? ['scraps'] : []);
    const stalePrice = context ? entry => context.stale(entry) : entry => isStale(snapshot, entry);
    // Company income rests on the product and input prices of the companies it runs.
    const productionStale = (streamEnabled(snapshot, 'production') || streamEnabled(snapshot, 'employees'))
      && (preparedProduction(snapshot)?.priceCodes || []).some(code => stalePrice(snapshot.production.prices[code]));
    const summary = {
      figures: { dailyDamage, dailyFightingCost,
        costPer1000Damage: dailyFightingCost == null || !(dailyDamage > 0) ? null : 1000 * dailyFightingCost / dailyDamage,
        equipmentPurchasePrice, dailyBalance },
      pilled: !!pill,
      effectiveSkills: skills,
      companies,
      stale: equipment.some(e => stalePrice(e.priceEntry))
        || [...consumables, ...lootCodes, ...(pill ? [pill.code] : [])].some(code => stalePrice(snapshot.prices[code]))
        || !!productionStale,
      complete: missingPrices.length === 0 && missingRarity.length === 0,
      issues,
    };
    if (context) return summary;

    // Every price the build rests on, with its provenance and freshness.
    const roleOf = (code) => phases.some(p => p.ammo === code) ? 'ammo' : 'food';
    const usedPrices = [
      ...equipment.map(e => provenance(snapshot, e.priceEntry, { role: 'equipment', code: e.code, slot: e.slot, stats: e.stats })),
      ...consumables.map(code => provenance(snapshot, snapshot.prices[code], { role: roleOf(code), code })),
      ...(pill ? [provenance(snapshot, snapshot.prices[pill.code], { role: 'pill', code: pill.code })] : []),
      ...lootCodes.map(code => provenance(snapshot, snapshot.prices[code], { role: 'loot', code })),
    ];
    // What the build uses up a day: a round of ammunition per attack, food
    // per hunger point, pills by the schedule, and each item as it wears out.
    const perDay = new Map();
    const use = (code, role, n, phase) => {
      if (!code || !(n > 0)) return;
      const u = perDay.get(code) || { code, role, perDay: 0, unitCost: buyPriceOf(snapshot, code), phases: [] };
      u.perDay += n;
      if (phase && !u.phases.includes(phase)) u.phases.push(phase);
      perDay.set(code, u);
    };
    for (const p of phases) { use(p.ammo, 'ammo', p.attacksPerDay, p.phase); use(p.food, 'food', p.foodPerDay, p.phase); }
    if (schedule) use(pill.code, 'pill', schedule.pillsPerDay);
    const usage = [
      ...equipment.map(e => ({ code: e.code, role: 'equipment', slot: e.slot, stats: e.stats, rarity: e.rarity, phases: e.phases,
                               perDay: e.retirementsPerDay, unitCost: e.price })),
      ...perDay.values(),
    ];

    const strip = ({ priceEntry, retirementsPerDay, phases, ...e }) => e;
    const only = phases.length === 1 ? phases[0] : null;
    return {
      ...summary,
      sustainable: dailyBalance == null ? null : dailyBalance >= 0,
      schedule,
      phases: phases.map(p => ({
        phase: p.phase, hours: p.hours, healthBarsPerCycle: p.healthBarsPerCycle, hungerBarsPerCycle: p.hungerBarsPerCycle,
        equipment: p.equipment.map(strip), food: p.food, ammo: p.ammo, loadoutPrice: p.loadoutPrice,
        attacksPerDay: p.attacksPerDay, dailyDamage: p.dailyDamage, damagePerAttack: p.damagePerAttack,
        fightingCost: p.fightingCost,
      })),
      ledger,
      fightingCost,
      rewards: { cases, scraps },
      combat: { healthPerDay: sum(p => p.healthPerDay), attacksPerDay,
                damagePerAttack: attacksPerDay > 0 ? dailyDamage / attacksPerDay : 0,
                ...(only ? { hitChance: only.hitChance, critChance: only.critChance,
                             armorReduction: only.armorReduction, dodgeChance: only.dodgeChance } : {}) },
      combatStats: phases[0].stats,
      skillPoints: { budget: profile.ordinarySkillBudget, spent, remaining: profile.ordinarySkillBudget - spent },
      equipment: equipment.map(strip),
      usage,
      food: phases[0].food, ammo: phases[0].ammo,
      prices: usedPrices,
      labels: labels(snapshot, equipment, companies, !!pill),
      missingPrices,
      missingRarity,
    };
  }

  return { SLOTS, MODEL_VERSION, MIN_COMPANIES, INCOME_SKILLS, incomeForSkills, createIncomeEvaluator, createSearchEvaluator, buyCost, evaluateStrategy, effectiveSkills, shoppingList, sameStats, softCapPercent };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingCore;
