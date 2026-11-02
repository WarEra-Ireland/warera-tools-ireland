/* Complete-roster projections. Money is in game currency; percentage bonuses
 * are percentage points. Training valuations remain in EmployeeCore. */
const EmployeePlanner = (() => {
  const EC = typeof module !== 'undefined' ? require('./employee-core.js') : EmployeeCore;
  const TOOL_TYPES = {
    sickle: ['grain', 'livestock', 'coca', 'wood', 'fish'],
    pickaxe: ['limestone', 'iron', 'lead', 'petroleum'],
    skillet: ['bread', 'steak', 'cookedFish'],
    hammer: ['steel', 'concrete'],
    flask: ['oil', 'paper', 'cocain'],
    caliper: ['lightAmmo', 'ammo', 'heavyAmmo'],
  };
  // Thresholds are evaluated exactly at event boundaries; this absorbs float
  // error from converting a fractional tenure into hours and back.
  const EPS = 1e-9;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const has = (e, code) => e.traits.some(t => t.code === code);
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const compatible = (tool, company) => !!TOOL_TYPES[tool.type]?.includes(company.product);
  const wageAt = (e, hour) => !e.climberRaise ? e.wage
    : e.wage + e.climberRaise * (Math.floor((e.employedDays + hour / 24 + EPS) / 7) - Math.floor((e.employedDays + EPS) / 7));
  const initial = s => s.employees.map(e => ({ employee: e.id, company: e.company, tool: e.equipped?.id || null }));

  // Effects the planner cannot reproduce. Their company stays as it is.
  function uncertainty(e) {
    for (const t of e.traits) {
      const def = EC.TRAIT[t.code];
      if (t.revealed === false) return 'has a hidden trait';
      if (!def) return `has a trait the planner does not know (${t.code})`;
      if ((def.arg || def.partner) && !t.arg) return `has ${def.name} without its stat or partner`;
    }
    return null;
  }

  function validate(s, arrangement) {
    const errors = [];
    const companies = new Map(s.companies.map(c => [c.id, c]));
    const frozen = e => !!companies.get(e?.company)?.excluded;
    const unique = (xs, label) => {
      if (xs.some(x => !x.id) || new Set(xs.map(x => x.id)).size !== xs.length) errors.push(`${label} must have unique IDs.`);
    };
    unique(s.companies, 'Companies'); unique(s.employees, 'Employees'); unique(s.tools, 'Tools');
    if (!(s.days >= 1 && s.days <= 47 && Number.isInteger(s.days))) errors.push('Choose a planning period from 1 to 47 whole days.');
    for (const c of s.companies) {
      if (!c.excluded && (!['raw', 'product', 'weapon'].includes(c.type) || !Number.isFinite(c.margin) || !Number.isFinite(c.bonus)
        || !Number.isFinite(c.tax) || !Number.isInteger(c.capacity) || c.capacity < 1)) errors.push(`Missing company data for ${c.name}.`);
    }
    for (const e of s.employees) {
      if (!companies.has(e.company)) { errors.push(`Missing employee data for ${e.name}.`); continue; }
      if (frozen(e)) continue;
      if (![e.age, e.production, e.responsibility, e.wage, e.tenure, e.employedDays].every(Number.isFinite)) errors.push(`Missing employee data for ${e.name}.`);
      if (has(e, 'climber') && !Number.isFinite(e.climberRaise)) errors.push(`Missing weekly wage increase for ${e.name}.`);
    }
    for (const t of s.tools) {
      const holder = t.holder && s.employees.find(e => e.id === t.holder);
      if (holder && frozen(holder)) continue;
      if (!TOOL_TYPES[t.type] || !(t.bonus >= 3 && t.bonus <= 65) || !(t.hours >= 0 && t.hours <= 10000)) errors.push(`Invalid bonus or working hours for ${t.name}.`);
    }
    if (arrangement.length !== s.employees.length || new Set(arrangement.map(a => a.employee)).size !== arrangement.length) errors.push('Assign each employee exactly once.');
    const used = new Set();
    for (const a of arrangement) {
      const e = s.employees.find(e => e.id === a.employee), c = companies.get(a.company);
      if (!e || !c) { errors.push('Unknown employee or company.'); continue; }
      if ((frozen(e) || c.excluded) && (a.company !== e.company || a.tool !== (e.equipped?.id || null))) errors.push(`${c.name} is not being planned, so its roster and tools stay unchanged.`);
      if (e.locked && a.company !== e.company) errors.push(`${e.name} is kept in their current company.`);
      if (!a.tool) continue;
      const t = s.tools.find(t => t.id === a.tool);
      if (!t || used.has(a.tool) || (!compatible(t, c) && (a.company !== e.company || a.tool !== e.equipped?.id)) || (t.holder && frozen(s.employees.find(e => e.id === t.holder)) && t.holder !== e.id)) errors.push('A tool must have one eligible employee.');
      used.add(a.tool);
    }
    for (const c of s.companies) if (arrangement.filter(a => a.company === c.id).length > c.capacity) errors.push(`${c.name} exceeds its Break Room capacity.`);
    return errors;
  }

  // The training callbacks supply the shared trait rules. Helpers collect
  // physical effects here, rather than converting each effect into money.
  // Algebraic/team effects whose callbacks value money need explicit handling.
  // Rival and Mentor are settled together in instant (peerProduction).
  const SKIP_HOURLY = new Set(['rival', 'mentor', 'loyal', 'stockpiler', 'anchor', 'climber', 'luckyCharm', 'jinx']);
  // What an employee's traits see of their coworkers; fixed while the roster is.
  const scenes = new WeakMap();
  function scene(e, company, roster) {
    let byRoster = scenes.get(roster);
    if (!byRoster) scenes.set(roster, byRoster = new Map());
    let sc = byRoster.get(e);
    if (sc) return sc;
    const others = roster.filter(x => x.id !== e.id);
    const femaleCoworkers = others.filter(x => x.gender === 'female').length;
    sc = { others, partners: new Set(others.map(o => o.id)), femaleCoworkers, s: {
      coworkers: others.length, femaleCoworkers,
      ...EC.nationalitySituation(e.nationality, others),
      ...EC.locationSituation(company.country, company.coreCountry, e.nationality),
      itemType: company.type, product: company.product, incomeTax: company.tax,
      smallStorage: company.storage <= 2, storageFull: company.full,
    } };
    byRoster.set(e, sc);
    return sc;
  }
  // The traits instant asks about, read once per projection (records can
  // change between projections).
  const FLAGS = ['rival', 'mentor', 'luckyCharm', 'jinx', 'trainer', 'salvager', 'scavenger', 'stockpiler', 'loyal', 'quickStudy', 'anchor'];
  const NO_FLAGS = Object.fromEntries([...FLAGS, 'hourly'].map(code => [code, false]));
  const flagsFor = members => new Map(members.map(({ e }) => {
    const f = { ...NO_FLAGS };
    for (const t of e.traits) {
      if (Object.hasOwn(f, t.code)) f[t.code] = true;
      // Whether effects has anything to do: a trait it handles itself or
      // one with an hourly rule.
      if (!SKIP_HOURLY.has(t.code) && (t.code === 'creatureOfHabit' || t.code === 'comic' || EC.TRAIT[t.code]?.hourly)) f.hourly = true;
    }
    return [e, f];
  }));
  function effects(e, company, roster, hour, tool, hourly = true) {
    const moved = e.company !== company.id;
    const sc = scene(e, company, roster);
    const { others, partners, femaleCoworkers, s: fixed } = sc;
    // Tenure is continuous: Veteran, Diamond and Burnout switch at the exact
    // hour, which projectCompany adds as a boundary. Age, for Early Bloomer,
    // Late Bloomer and Worn Out, steps at the daily boundaries.
    const tenure = (moved ? 0 : e.tenure) + hour / 24 + EPS;
    const fx = { production: 0, responsibility: 0, luck: 0, bonus: 0, happiness: [], teamHappiness: [], teamProduction: 0, teamResponsibility: 0 };
    if (!hourly || !e.traits.length) return fx;
    const own = wageAt(e, hour) + 1e-9;
    let betterPaid = 0;
    for (const x of others) if (wageAt(x, hour) > own) betterPaid++;
    // The trait rules only read what they are handed, so one record per
    // employee and roster is reused, its hourly fields set afresh.
    if (!sc.x) {
      const add = (key, n) => { sc.fx[key] += n; return 0; };
      const x = sc.x = {
        s: { ...fixed }, e, age: 0, tenure: 0, held: true, loss: 0, male: others.length - femaleCoworkers,
        prod: n => add('production', n), pct: n => add('bonus', n), happy: n => { sc.fx.happiness.push(n); return 0; },
        resp: n => add('responsibility', n), luck: n => add('luck', n), boxes: () => 0, wage: () => 0,
        teamHappy: n => { sc.fx.teamHappiness.push(n); return 0; },
        teamProd: n => add('teamProduction', n), teamResp: n => add('teamResponsibility', n), quickStudy: 0, arg: undefined,
      };
      x.stat = (stat, n) => stat === 'production' ? x.prod(n) : stat === 'responsibility' ? x.resp(n) : x.luck(n);
    }
    const x = sc.x;
    sc.fx = fx;
    x.s.betterPaid = betterPaid; x.s.hasTool = !!tool;
    x.age = e.age + Math.floor(hour / 24); x.tenure = tenure; x.arg = undefined;
    for (const t of e.traits) {
      if (SKIP_HOURLY.has(t.code)) continue;
      if (t.code === 'creatureOfHabit') {
        if ((moved ? hour : hour + e.moveAgeHours) < 72 - 1e-6) fx.bonus -= 30;
        continue;
      }
      // Comics don't stack: instant gives coworkers the first one's boost.
      if (t.code === 'comic') {
        EC.TRAIT.comic.hourly({ ...x, teamHappy: n => { fx.comicHappiness = n; return 0; } });
        continue;
      }
      const def = EC.TRAIT[t.code];
      if (!def?.hourly || def.partner && !partners.has(t.arg)) continue;
      x.arg = t.arg;
      def.hourly(x);
    }
    return fx;
  }

  const sizes = new WeakMap();
  function currentSize(s, id) {
    let m = sizes.get(s.employees);
    if (!m) {
      sizes.set(s.employees, m = new Map());
      for (const e of s.employees) m.set(e.company, (m.get(e.company) || 0) + 1);
    }
    return m.get(id) || 0;
  }

  function instant(s, company, members, hour, rosters = null, flags = flagsFor(members)) {
    const flagsOf = e => flags.get(e);
    let roster = members.filter(({ e }) => hour < (EC.CFG.retireAge - e.age) * 24).map(({ e }) => e);
    if (rosters) {
      const key = roster.map(e => e.id).join(',');
      roster = rosters.get(key) || (rosters.set(key, roster), roster);
    }
    const rows = members.filter(({ e }) => roster.includes(e)).map(({ e, tool }) => {
      const heldTool = tool && hour < tool.hours ? tool : null;
      const activeTool = heldTool && compatible(heldTool, company) ? heldTool : null;
      return { e, tool: activeTool, fx: effects(e, company, roster, hour, heldTool, flagsOf(e).hourly) };
    });
    const productions = EC.peerProduction(rows.map(({ e, fx }) => ({
      production: e.production + fx.production, rival: flagsOf(e).rival, mentor: flagsOf(e).mentor,
    })));
    const intact = roster.length === currentSize(s, company.id) && roster.every(e => e.company === company.id);
    const calc = [];
    const day = Math.floor(hour / 24);
    const result = rows.map(({ e, tool, fx }, index) => {
      const f = flagsOf(e);
      // Sums run in the order the effects were once collected in: own
      // effects, the first coworker Comic, then coworkers in roster order.
      let comic = null, teamResponsibility = fx.responsibility, coworkerLuck = 0, trainers = 0;
      for (const other of rows) {
        if (other.e.id === e.id) continue;
        if (comic === null && other.fx.comicHappiness) comic = other.fx.comicHappiness;
        teamResponsibility += other.fx.teamResponsibility;
        const g = flagsOf(other.e);
        coworkerLuck = coworkerLuck + (g.luckyCharm ? 3 : 0) - (g.jinx ? 2 : 0);
        if (g.trainer) trainers++;
      }
      const production = productions[index];
      // The game's coworker Luck and training allowance lag roster and trait
      // changes, by a rule snapshots do not reveal. Its reported values stand
      // while the roster is the reported one; changed rosters use the model.
      const o = intact && e.observed || {};
      // A card's own Luck gain moves the reported total with it. Training
      // leaves that gain out (the page values it with its own forecast),
      // so training Luck never depends on the employee's own Luck.
      const baseLuck = e.trainingBaseLuck ?? e.luck ?? 0;
      const luck = Number.isFinite(o.luck) ? o.luck + (e.luck || 0) - baseLuck : Math.max(1, (e.luck || 0) + fx.luck + coworkerLuck);
      const learningLuck = Number.isFinite(o.luck) ? o.luck : Math.max(1, baseLuck + fx.luck + coworkerLuck);
      const toolboxes = company.full && !f.salvager ? 0 : EC.toolboxRate(luck) * (f.scavenger ? 2 : 1);
      const loot = toolboxes * (s.toolboxValue || 0);
      const trainingsPerDay = Number.isFinite(o.trainingsPerDay) ? o.trainingsPerDay : 1 + 2 * trainers;
      const trainingRate = Math.min(s.trainingQuota || 0, trainingsPerDay);
      const responsibility = Math.max(1, e.responsibility + teamResponsibility);
      // Responsibility adds 3 happiness a point; Loyal halves every loss.
      const lossFactor = f.loyal ? 0.5 : 1;
      let felt = 0;
      const feel = h => { felt = felt + h * (h < 0 ? lossFactor : 1); };
      for (const h of fx.happiness) feel(h);
      if (comic !== null) feel(comic);
      for (const other of rows) if (other.e.id !== e.id) for (const h of other.fx.teamHappiness) feel(h);
      feel(-company.tax);
      if (company.full && !f.stockpiler) feel(-10);
      for (const h of e.happiness) if (hour < h.hours) feel(h.delta);
      const mood = clamp(50 + EC.CFG.respHappiness * responsibility + felt, 0, 100);
      const saved = e.specializations[company.product] || 0;
      const specialization = Math.min(20, saved + day * (f.quickStudy ? 2 : 1));
      const anchor = f.anchor && mood < 30 ? -50 : 0;
      const events = (e.productionEvents || []).reduce((sum, event) => sum + (hour < event.hours ? event.delta : 0), 0);
      const bonus = company.bonus + fx.bonus + events + specialization + mood - 50 + (tool?.bonus || 0) + anchor;
      const output = production / 4 * Math.max(0, 1 + bonus / 100);
      // Current pay already includes Greedy, Modest and past Climber raises.
      const wage = wageAt(e, hour);
      const row = { luck, learningLuck, toolboxes, loot, trainingRate, trainingsPerDay, id: e.id, company: company.id, tool: tool?.id || null, production, responsibility, happiness: mood, specialization, bonus,
        parts: { company: company.bonus, traits: fx.bonus + anchor, events, specialization, happiness: mood - 50, tool: tool?.bonus || 0, traitProduction: production - e.production },
        output, wage, profit: output * company.margin - wage + loot };
      calc.push({ production, pre: company.bonus + fx.bonus + events, mood, tool: tool?.bonus || 0, anchor, saved, loot, rate: f.quickStudy ? 2 : 1, wage });
      return row;
    });
    result.calc = calc;
    return result;
  }
  // A row's profit on a later day of the same stretch, where only
  // specialization moves: instant's arithmetic in the same order.
  const profitOn = (c, d, margin) =>
    c.production / 4 * Math.max(0, 1 + (c.pre + Math.min(20, c.saved + d * c.rate) + c.mood - 50 + c.tool + c.anchor) / 100) * margin - c.wage + c.loot;
  // Traits whose effect steps with age (a year a day, in decades).
  const AGE_TRAITS = new Set(['lateBloomer', 'earlyBloomer', 'wornOut']);

  // Hours at which an employee's trait conditions or wage change.
  function traitHours(e, moved, end) {
    const base = moved ? 0 : e.tenure, hours = [];
    const tenureDays = days => hours.push((days - base) * 24);
    if (has(e, 'veteran')) tenureDays(30);
    if (has(e, 'diamondInTheRough')) [10, 20, 30, 40].forEach(tenureDays);
    if (has(e, 'burnout')) [20, 40, 60].forEach(tenureDays);
    if (has(e, 'creatureOfHabit')) hours.push(moved ? 72 : 72 - e.moveAgeHours);
    if (e.climberRaise) {
      for (let k = Math.floor(e.employedDays / 7) + 1; (7 * k - e.employedDays) * 24 < end; k++) hours.push((7 * k - e.employedDays) * 24);
    }
    return hours;
  }

  const trainingMeans = new WeakMap();
  function trainingMean(e, luck, management) {
    if (!e.trainingValues) return 0;
    let cache = trainingMeans.get(e);
    if (!cache) trainingMeans.set(e, cache = new Map());
    const key = `${luck}/${management}`;
    if (!cache.has(key)) {
      const odds = EC.rarityOdds(luck, management);
      cache.set(key, e.trainingValues.reduce((n, v, i) => n + v * odds[EC.RARITIES[i]], 0));
    }
    return cache.get(key);
  }

  function projectCompany(s, company, members) {
    const end = s.days * 24;
    // Effects are worked out afresh only where something other than
    // specialization can change; days in between reuse them (profitOn).
    const boundaries = new Set([0, end]);
    for (const { e, tool } of members) {
      const moved = e.company !== company.id;
      for (const h of [tool?.hours, (EC.CFG.retireAge - e.age) * 24, ...e.happiness.map(x => x.hours), ...(e.productionEvents || []).map(x => x.hours), ...traitHours(e, moved, end)]) {
        if (h > 0 && h < end) boundaries.add(h);
      }
      if (e.traits.some(t => AGE_TRAITS.has(t.code))) {
        for (let d = 1; d < s.days; d++) if (Math.floor((e.age + d) / 10) !== Math.floor((e.age + d - 1) / 10)) boundaries.add(d * 24);
      }
    }
    const hours = [...boundaries].sort((a, b) => a - b);
    // Per member, by their place in `members`.
    const slot = new Map(members.map(({ e }, i) => [e.id, i]));
    const totals = members.map(() => 0), trainingProgress = members.map(() => 0), trainingValues = members.map(() => 0);
    const minHappiness = members.map(() => 100);
    const daily = new Array(s.days).fill(0);
    let value = 0;
    const rosters = new Map(), flags = flagsFor(members);
    let first = null;
    for (let i = 0; i < hours.length - 1; i++) {
      const rows = instant(s, company, members, hours[i], rosters, flags);
      if (i === 0) first = rows;
      const at = rows.map(row => slot.get(row.id));
      if (s.trainingQuota > 0) for (let r = 0; r < rows.length; r++) {
        const row = rows[r], m = at[r], e = members[m].e, daysLeft = EC.CFG.retireAge - e.age;
        if (!(e.potentialLeft > 0) || !e.trainingValues) continue;
        const from = hours[i] / 24, to = hours[i + 1] / 24;
        const before = trainingProgress[m], after = Math.min(e.potentialLeft, before + row.trainingRate * (to - from));
        if (row.trainingRate <= 1 && row.learningLuck === e.trainingLuck && Math.abs(before - Math.min(e.potentialLeft, from * row.trainingRate)) < 1e-9) {
          trainingProgress[m] = after;
          continue;
        }
        const mean = trainingMean(e, Math.max(1, row.learningLuck), s.management || 0), baseMean = trainingMean(e, e.trainingLuck ?? row.learningLuck, s.management || 0);
        const credit = (at, amount) => {
          const benefit = amount * Math.max(0, Math.min(daysLeft, s.days) - at) / daysLeft;
          if (!benefit) return;
          value += benefit; daily[Math.min(s.days - 1, Math.floor(at))] += benefit;
          totals[m] += benefit;
          trainingValues[m] += benefit;
        };
        for (let k = Math.floor(before + 1e-9) + 1; k <= Math.floor(after + 1e-9); k++) credit(from + (k - before) / row.trainingRate, mean);
        trainingProgress[m] = after;
        // Numeric Luck drills use the separate future-hand forecast. This
        // estimate changes only trait and coworker effects, avoiding double counting.
        // The page separately values own potential. Add only the difference
        // from the observed Luck and one-training-per-day baseline.
        const baseRate = Math.min(1, s.trainingQuota);
        for (let k = Math.floor(Math.min(e.potentialLeft, from * baseRate) + 1e-9) + 1; k <= Math.floor(Math.min(e.potentialLeft, to * baseRate) + 1e-9); k++) credit(k / baseRate, -baseMean);
      }

      for (let h = hours[i], start = Math.floor(h / 24); h < hours[i + 1];) {
        const day = Math.floor(h / 24), next = Math.min(hours[i + 1], (day + 1) * 24);
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r], gain = (day === start ? row.profit : profitOn(rows.calc[r], day, company.margin)) * (next - h);
          value += gain; daily[day] += gain; totals[at[r]] += gain;
          if (row.happiness < minHappiness[at[r]]) minHappiness[at[r]] = row.happiness;
        }
        h = next;
      }
    }
    if (company.recruitmentValues) {
      const recruiters = members.filter(({ e }) => has(e, 'recruiter') && e.age < EC.CFG.retireAge);
      const benefit = company.recruitmentValues[Math.min(3, recruiters.length)] - company.recruitmentValues[0];
      value += benefit; daily[0] += benefit;
      for (const { e } of recruiters) totals[slot.get(e.id)] += benefit / recruiters.length;
    }
    return { value, daily, employees: (first || instant(s, company, members, 0, rosters, flags)).map(r => ({ ...r, value: totals[slot.get(r.id)], trainingValue: trainingValues[slot.get(r.id)], minHappiness: minHappiness[slot.get(r.id)] })) };
  }

  // Projections are cached per (company, roster, tools); `misses` counts the
  // projections actually run, which is what the search budget limits.
  function projector(s) {
    const cache = new Map();
    const p = { misses: 0 };
    p.project = (company, members) => {
      members = [...members].sort((a, b) => byId(a.e, b.e));
      const key = company.id + ':' + members.map(m => `${m.e.id}/${m.tool?.id || ''}`).join(',');
      let r = cache.get(key);
      if (!r) { p.misses++; r = projectCompany(s, company, members); cache.set(key, r); }
      return r;
    };
    return p;
  }

  // Projects an assignment over the companies being planned.
  function totals(s, P, assign) {
    const employees = new Map(s.employees.map(e => [e.id, e])), tools = new Map(s.tools.map(t => [t.id, t]));
    const groups = s.companies.filter(c => !c.excluded).sort(byId).map(c => P.project(c, [...assign]
      .filter(([, a]) => a.company === c.id).map(([id, a]) => ({ e: employees.get(id), tool: tools.get(a.tool) }))));
    const daily = new Array(s.days).fill(0);
    for (const g of groups) g.daily.forEach((v, i) => { daily[i] += v; });
    return { value: groups.reduce((a, g) => a + g.value, 0), daily, employees: groups.flatMap(g => g.employees) };
  }

  const excludedList = s => s.companies.filter(c => c.excluded).map(c => ({ company: c.id, name: c.name, reason: c.excluded }));

  function coverage(s) {
    const notes = ['Earnings assume employees stay. Quit probabilities and future price changes are not valued.'];
    if (!s.toolboxValue) notes.push('Toolbox income is excluded: set a toolbox value to include Luck, Scavenger and Salvager loot benefits.');
    if (!s.trainingQuota) notes.push('Trainer and coworker Luck training benefits are excluded: set a daily training budget.');
    else notes.push('Trainer and coworker Luck use a bounded numeric-card estimate, fixed current training values and an equal share of the daily energy budget.');
    if (s.toolboxValue || s.trainingQuota) notes.push("Unchanged rosters keep the game's reported Luck and training allowance. A changed roster gets Lucky Charm, Jinx and Trainer effects at once, although the game applies them after a delay that is not yet known.");
    if (s.employees.some(e => has(e, 'recruiter')) && s.companies.some(c => !c.recruitmentValues && s.employees.some(e => e.company === c.id && has(e, 'recruiter')))) notes.push('Recruiter is not valued in companies without a planned candidate set.');
    if (s.employees.some(e => has(e, 'anchor'))) notes.push("Anchor's output penalty is included; protection against quitting is not priced.");
    return notes;
  }
  function riskWarnings(s, rows) {
    const people = new Map(s.employees.map(e => [e.id, e]));
    return rows.flatMap(r => {
      const e = people.get(r.id);
      return !has(e, 'anchor') && r.minHappiness < (has(e, 'flightRisk') ? 50 : 30)
        ? [`${e.name}'s projected happiness reaches ${r.minHappiness.toFixed(1)} and they may quit. Earnings assume they stay.`] : [];
    });
  }

  function evaluate(snapshot, arrangement = initial(snapshot)) {
    const errors = validate(snapshot, arrangement);
    if (errors.length) return { valid: false, errors };
    const assign = new Map(arrangement.map(a => [a.employee, a]));
    const result = totals(snapshot, projector(snapshot), assign);
    return { valid: true, ...result, warnings: riskWarnings(snapshot, result.employees), coverage: coverage(snapshot), arrangement, excluded: excludedList(snapshot) };
  }

  // Companies whose roster cannot be reproduced are frozen: membership and
  // tools stay as they are, and their profit is left out of every total.
  function withExclusions(snapshot) {
    const reasons = new Map(snapshot.companies.filter(c => c.excluded).map(c => [c.id, [c.excluded]]));
    const note = (id, reason) => reasons.set(id, [...(reasons.get(id) || []), reason]);
    for (const e of snapshot.employees) {
      const why = !reasons.has(e.company) && uncertainty(e);
      if (why) note(e.company, `${e.name} ${why}.`);
    }
    const tools = new Map(snapshot.tools.map(t => [t.id, t]));
    for (const c of snapshot.companies) {
      if (reasons.has(c.id)) continue;
      const members = snapshot.employees.filter(e => e.company === c.id).map(e => ({ e, tool: tools.get(e.equipped?.id) }));
      for (const row of instant(snapshot, c, members, 0)) {
        const o = members.find(m => m.e.id === row.id).e.observed;
        if (!o) continue;
        if ((Number.isFinite(o.production) && Math.abs(row.production - o.production) > 0.01)
          || (Number.isFinite(o.responsibility) && Math.abs(row.responsibility - o.responsibility) > 0.01)
          || (Number.isFinite(o.happiness) && Math.abs(row.happiness - o.happiness) > 0.15)
          || (Number.isFinite(o.bonus) && Math.abs(row.bonus - o.bonus) > 0.15)
          || (Number.isFinite(o.output) && Math.abs(row.output - o.output) > 0.011)) {
          note(c.id, `${members.find(m => m.e.id === row.id).e.name}'s rebuilt stats or bonuses differ from the game, so an unmodelled effect may be present.`);
        }
      }
    }
    return { ...snapshot, companies: snapshot.companies.map(c => reasons.has(c.id) ? { ...c, excluded: reasons.get(c.id).join(' ') } : c) };
  }

  // Compare the same company's complete career with and without one employee.
  // This shares retirement, tool expiry, happiness and trait rules with assignments.
  function retentionSession(snapshot) {
    const s = withExclusions(snapshot);
    const errors = validate(s, initial(s));
    const tools = new Map(s.tools.map(t => [t.id, t]));
    const cache = new Map();
    function price(id) {
      const e = s.employees.find(e => e.id === id);
      const company = s.companies.find(c => c.id === e?.company);
      const reason = errors[0] || !e && 'Employee not loaded.' || company?.excluded;
      if (reason) return { valid: false, reason };
      const members = s.employees.filter(x => x.company === company.id).map(e => ({ e, tool: tools.get(e.equipped?.id) }));
      const days = Math.min(47, Math.max(1, ...members.map(({ e }) => Math.ceil(EC.CFG.retireAge - e.age))));
      const project = rows => projectCompany({ ...s, days }, company, rows);
      if (!cache.has(company.id)) cache.set(company.id, project(members));
      const baseline = cache.get(company.id);
      const without = project(members.filter(m => m.e.id !== id));
      const row = baseline.employees.find(x => x.id === id);
      // The keep calculator already values this employee's own training.
      // Preserve only the supplemental training effect on coworkers here.
      const own = (row?.value || 0) - (row?.trainingValue || 0);
      const value = baseline.value - without.value - (row?.trainingValue || 0);
      return { valid: true, value, own, coworkers: value - own, warnings: [...new Set([...riskWarnings(s, baseline.employees), ...riskWarnings(s, without.employees)])], coverage: coverage(s),
        unpriced: [...new Set(members.flatMap(({ e }) => e.traits.filter(t => EC.TRAIT[t.code]?.unpriced && !(t.code === 'trainer' && s.trainingQuota) && !(t.code === 'recruiter' && company.recruitmentValues)).map(t => t.code)))] };
    }
    return { price };
  }

  /* Best-improvement local search over moves, direct swaps and tool changes.
   * Every round scores each employee's options, interleaved so a budget cut
   * falls evenly on the workforce, and accepts the single best change. Ties
   * break on a canonical key, so input order does not change the result.
   * Identical available tools (same type, bonus and hours) are one option. */
  function recommend(snapshot, { maxProjections = 60000, allowMoves = true, onProgress = null, compareOutputOnly = true } = {}) {
    let errors = validate(snapshot, initial(snapshot));
    if (errors.length) return { valid: false, errors };
    const s = withExclusions(snapshot);
    errors = validate(s, initial(s));
    if (errors.length) return { valid: false, errors };
    const P = projector(s);
    const employees = new Map(s.employees.map(e => [e.id, e])), tools = new Map(s.tools.map(t => [t.id, t]));
    const companies = new Map(s.companies.map(c => [c.id, c]));
    const planned = s.companies.filter(c => !c.excluded).sort(byId);
    const people = s.employees.filter(e => !companies.get(e.company).excluded).sort(byId);
    const assign = new Map(initial(s).map(a => [a.employee, { company: a.company, tool: a.tool }]));
    const manual = s.tools.filter(t => t.hours > 0 && (!t.holder || people.some(e => e.id === t.holder))).sort(byId);
    const classOf = t => t ? `${t.type}|${t.bonus}|${t.hours}` : '-';
    const classes = [...new Set(manual.map(classOf))].sort();
    const sample = new Map(manual.map(t => [classOf(t), t]));
    const holder = new Map([...assign].filter(([, a]) => a.tool).map(([id, a]) => [a.tool, id]));
    const freeUnit = key => manual.find(t => classOf(t) === key && !holder.has(t.id)) || null;
    const roster = new Map(planned.map(c => [c.id, people.filter(e => e.company === c.id).map(e => e.id)]));
    const value = new Map(planned.map(c => [c.id, P.project(c, roster.get(c.id).map(id => ({ e: employees.get(id), tool: tools.get(assign.get(id).tool) }))).value]));
    const baseline = totals(s, P, assign);
    const steps = [], moved = new Set();
    const movable = e => allowMoves && !e.locked && !moved.has(e.id);
    const search = { rounds: 0, candidates: 0, projections: 0, maxProjections, limited: false, stopped: 'converged' };

    const toolFor = (tool, company) => tool && compatible(tool, company) ? tool.id : null;
    function candidatesFor(e, partners) {
      const a = assign.get(e.id), here = companies.get(a.company), cur = tools.get(a.tool) || null, out = [];
      const add = (changes, key, step = null) => out.push({ changes, key, step });
      if (cur) add([[e.id, here.id, null]], `t:${e.id}:-`);
      for (const k of classes) {
        if (k === classOf(cur) || !compatible(sample.get(k), here)) continue;
        const unit = freeUnit(k);
        if (unit) { add([[e.id, here.id, unit.id]], `t:${e.id}:${k}`); continue; }
        // All units of this class are in use: exchange with each holder.
        for (const t of manual) {
          const other = holder.get(t.id);
          if (classOf(t) !== k || !other) continue;
          const there = companies.get(assign.get(other).company);
          add([[e.id, here.id, t.id], [other, there.id, toolFor(cur, there)]], `t:${e.id}:${k}:${other}`);
        }
      }
      if (!movable(e)) return out;
      for (const c of planned) {
        if (c.id === here.id || roster.get(c.id).length >= c.capacity) continue;
        const step = { kind: 'move', employees: [e.id], to: c.id }, keep = toolFor(cur, c);
        add([[e.id, c.id, keep]], `m:${e.id}:${c.id}:${classOf(tools.get(keep))}`, step);
        // A tool can make a move profitable even if neither change alone is.
        for (const k of classes) {
          if (!compatible(sample.get(k), c)) continue;
          const unit = classOf(cur) === k ? null : freeUnit(k);
          if (unit) add([[e.id, c.id, unit.id]], `m:${e.id}:${c.id}:${k}`, step);
        }
      }
      for (const f of partners) {
        const b = assign.get(f.id), there = companies.get(b.company), theirs = tools.get(b.tool) || null;
        const [x, y] = [e.id, f.id].sort(), step = { kind: 'swap', employees: [e.id, f.id] };
        const key = `s:${x}:${y}`;
        add([[e.id, there.id, toolFor(cur, there)], [f.id, here.id, toolFor(theirs, here)]], `${key}:keep`, step);
        // Tools stay with the company instead of travelling with the person.
        if (cur || theirs) add([[e.id, there.id, toolFor(theirs, there)], [f.id, here.id, toolFor(cur, here)]], `${key}:stay`, step);
        for (const k of classes) {
          const unit = freeUnit(k);
          if (!unit) continue;
          if (compatible(unit, there)) add([[e.id, there.id, unit.id], [f.id, here.id, toolFor(theirs, here)]], `${key}:${e.id}:${k}`, step);
          if (compatible(unit, here)) add([[e.id, there.id, toolFor(cur, there)], [f.id, here.id, unit.id]], `${key}:${f.id}:${k}`, step);
        }
      }
      return out;
    }

    // Gain of a candidate: only the companies it touches are re-projected.
    function score(candidate) {
      const next = new Map(candidate.changes.map(([id, company, tool]) => [id, { company, tool }]));
      const touched = new Set(candidate.changes.flatMap(([id, company]) => [assign.get(id).company, company]));
      let gain = 0;
      for (const id of [...touched].sort()) {
        const c = companies.get(id);
        const members = [...roster.get(id).filter(x => !next.has(x) || next.get(x).company === id),
          ...[...next].filter(([x, a]) => a.company === id && assign.get(x).company !== id).map(([x]) => x)];
        if (members.length > c.capacity) return null;
        gain += P.project(c, members.map(x => ({ e: employees.get(x), tool: tools.get((next.get(x) || assign.get(x)).tool) }))).value - value.get(id);
      }
      return gain;
    }

    function apply({ changes, step }) {
      const touched = new Set();
      for (const [id, company, tool] of changes) {
        const was = assign.get(id);
        touched.add(was.company).add(company);
        if (was.tool) holder.delete(was.tool);
        roster.set(was.company, roster.get(was.company).filter(x => x !== id));
        roster.get(company).push(id);
        assign.set(id, { company, tool });
      }
      for (const [id, , tool] of changes) if (tool) holder.set(tool, id);
      for (const id of touched) {
        const c = companies.get(id);
        value.set(id, P.project(c, roster.get(id).map(x => ({ e: employees.get(x), tool: tools.get(assign.get(x).tool) }))).value);
      }
      if (step) { steps.push(step); step.employees.forEach(id => moved.add(id)); }
    }

    function result(partial) {
      const proposed = totals(s, P, assign);
      const warnings = riskWarnings(s, proposed.employees);
      return { valid: true, partial, baseline, proposed, gain: proposed.value - baseline.value,
        coverage: coverage(s), arrangement: s.employees.map(e => ({ employee: e.id, ...assign.get(e.id) })), steps: [...steps], warnings,
        unused: manual.filter(t => !holder.has(t.id)).map(t => t.id), excluded: excludedList(s),
        search: { ...search, projections: P.misses } };
    }

    function finish() {
      const primary = result(false);
      const remaining = maxProjections - P.misses - planned.length;
      if (!compareOutputOnly || remaining <= planned.length || !(s.toolboxValue || s.trainingQuota || planned.some(c => c.recruitmentValues))) return primary;
      // A different objective can steer a greedy search into a worse local
      // optimum. Keep the output-only candidate, scored with the full model.
      const alternative = recommend({ ...s, toolboxValue: 0, trainingQuota: 0,
        companies: s.companies.map(c => ({ ...c, recruitmentValues: null })) },
        { maxProjections: remaining, allowMoves, compareOutputOnly: false });
      const scored = evaluate(s, alternative.arrangement);
      const search = { ...primary.search, projections: primary.search.projections + alternative.search.projections + planned.length,
        alternativeProjections: alternative.search.projections, selectedOutputOnly: scored.value > primary.proposed.value + 1e-7 };
      if (!search.selectedOutputOnly) return { ...primary, search };
      return { ...primary, proposed: scored, gain: scored.value - baseline.value, arrangement: alternative.arrangement,
        steps: alternative.steps, unused: alternative.unused, warnings: scored.warnings, search };
    }

    const maxRounds = 2 * people.length + manual.length + 10;
    while (search.rounds < maxRounds) {
      // Each swap pair is listed once, alternating its owner, so lists stay even.
      const lists = people.map(e => ({ e, partners: [] }));
      for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) {
          if (!movable(people[i]) || !movable(people[j]) || assign.get(people[i].id).company === assign.get(people[j].id).company) continue;
          ((i + j) % 2 ? lists[i] : lists[j]).partners.push(people[(i + j) % 2 ? j : i]);
        }
      }
      const queues = lists.map(({ e, partners }) => candidatesFor(e, partners));
      const start = search.rounds % Math.max(1, queues.length);
      let best = null, bestGain = 1e-7;
      outer: for (let depth = 0; queues.some(q => depth < q.length); depth++) {
        for (let n = 0; n < queues.length; n++) {
          const candidate = queues[(start + n) % queues.length][depth];
          if (!candidate) continue;
          if (P.misses >= maxProjections) { search.limited = true; search.stopped = 'budget'; break outer; }
          const gain = score(candidate);
          search.candidates++;
          if (gain == null) continue;
          if (gain > bestGain + 1e-9 || (best && Math.abs(gain - bestGain) <= 1e-9 && candidate.key < best.key)) { best = candidate; bestGain = gain; }
        }
      }
      search.rounds++;
      if (!best) return finish();
      apply(best);
      if (search.limited) return finish();
      onProgress?.(result(true));
    }
    search.limited = true; search.stopped = 'rounds';
    return finish();
  }
  // Canonical one-change neighbourhood. Tool choices are added by cardSession.
  // Coworker plans still apply when the subject is pinned.
  const CARD_PLAN_CAP = 256;
  const CARD_CACHE_CAP = 20000;
  // The short menu: the best plans overall, and the best at each place the
  // subject could work. Matched the full menu on a 36-employee, 12-company
  // workforce (2026-11-01) at a fraction of the projections.
  const SCREEN_TOP = 16, SCREEN_PER_PLACE = 3;
  const STATS = ['production', 'responsibility', 'luck'];
  function localPlans(s, subject, allowMoves) {
    const companies = s.companies.filter(c => !c.excluded).sort(byId);
    const people = s.employees.filter(e => companies.some(c => c.id === e.company)).sort(byId);
    const movable = e => allowMoves && !e.locked;
    const count = id => people.filter(e => e.company === id).length;
    const plans = [{ key: 'stay', kind: 'stay', changes: [] }], seen = new Set();
    const add = (kind, changes) => {
      changes.sort((a, b) => a[0].localeCompare(b[0]));
      const key = JSON.stringify(changes);
      if (!seen.has(key)) { seen.add(key); plans.push({ key, kind, changes }); }
    };
    const moves = e => {
      if (!movable(e)) return;
      for (const c of companies) if (c.id !== e.company && count(c.id) < c.capacity) add('move', [[e.id, c.id]]);
    };
    const swaps = (e, partners) => {
      if (!movable(e)) return;
      for (const f of partners) if (movable(f) && f.company !== e.company) add('swap', [[e.id, f.company], [f.id, e.company]]);
    };
    moves(subject); swaps(subject, people);
    const peers = people.filter(e => e.id !== subject.id && e.company === subject.company);
    peers.forEach(moves);
    people.filter(e => e.company !== subject.company && movable(e)).forEach(e => {
      if (count(subject.company) < companies.find(c => c.id === subject.company).capacity) add('move', [[e.id, subject.company]]);
    });
    peers.forEach(e => swaps(e, people));
    return { plans: plans.slice(0, CARD_PLAN_CAP), total: plans.length };
  }

  function cardSession(snapshot) {
    const prepared = withExclusions(snapshot);
    const horizon = Math.min(47, Math.max(1, Math.ceil(Math.max(0, ...prepared.employees
      .filter(e => !prepared.companies.find(c => c.id === e.company)?.excluded).map(e => EC.CFG.retireAge - e.age)))));
    // Card variants change Luck against this reference, so own Luck reaches
    // only toolbox loot (see instant) and the fingerprint can leave it out
    // without toolboxes.
    const s = { ...prepared, days: horizon, employees: prepared.employees.map(e => e.trainingBaseLuck == null ? { ...e, trainingBaseLuck: e.luck ?? 0 } : e) };
    const errors = validate(s, initial(s));
    // Projections, kept in two generations of half the cap each: when the
    // newer fills, the older is dropped and anything used again moves up.
    // (Evicting one key at a time from a Map scans its deleted slots.)
    const subjects = new Map();
    let cache = new Map(), older = new Map();
    const companies = s.companies.filter(c => !c.excluded).sort(byId);
    const tools = new Map(s.tools.map(t => [t.id, t]));
    const people = new Map(s.employees.map(x => [x.id, x]));
    // Fingerprints and layouts are long strings: each is numbered once, so
    // cache keys stay short.
    const numbers = new Map();
    const numberOf = text => numbers.get(text) ?? (numbers.set(text, numbers.size), numbers.size - 1);
    const fingerprints = new WeakMap();
    const fingerprint = e => {
      let f = fingerprints.get(e);
      if (f === undefined) fingerprints.set(e, f = numberOf(JSON.stringify([e.id, e.traits.filter(t => !(t.code === 'recruiter' && !s.companies.some(c => c.recruitmentValues)) && !(t.code === 'trainer' && !(s.trainingQuota > 1))), s.toolboxValue ? e.luck : null, e.potentialLeft,
        e.production, e.responsibility, e.wage, e.climberRaise])));
      return f;
    };
    // The assignment result includes nulls so removing an equipped tool is preserved.
    function price(subjectId, cards, { budget = 80000, employee = {}, context = {}, feed = false, assigned = {} } = {}) {
      const subject = s.employees.find(e => e.id === subjectId);
      const reason = errors[0] || !subject && 'Employee is not in this workforce.'
        || s.companies.find(c => c.id === subject?.company)?.excluded;
      if (reason) return { valid: false, basis: 'current-company', reason };
      let used = 0;
      const ctx = { ...context, ppValue: snapshot.ppValue || 1, situation: { ...context.situation,
        gender: subject.gender, product: companies.find(c => c.id === subject.company).product } };
      const e = { ...EC.DEFAULT_EMPLOYEE, ...employee, ...subject,
        wageExpectation: employee.wageExpectation ?? subject.wage / (subject.production / 4 * (snapshot.ppValue || 1)) };
      // Physical records carry timed happiness events; the calculator expects
      // today's numeric happiness. Keep that model separate for forecasts.
      const forecastEmployee = { ...e, luck: employee.luck ?? e.luck, happiness: employee.happiness ?? null };
      const toolOf = x => tools.get(Object.hasOwn(assigned, x.id) ? assigned[x.id] : x.equipped?.id) || null;
      const stateKey = JSON.stringify([subjectId, assigned]);
      let state = subjects.get(stateKey);
      if (!state) {
        const menu = localPlans(s, subject, snapshot.allowMoves !== false);
        const people = s.employees.filter(x => companies.some(c => c.id === x.company)).sort(byId);
        const available = s.tools.filter(t => t.hours > 0 && (!t.holder || people.some(x => x.id === t.holder))).sort(byId);
        const queues = [], seen = new Set();
        let queue;
        const add = (plan, equipment) => {
          const key = JSON.stringify([plan.changes, equipment]);
          if (!seen.has(key)) { seen.add(key); queue.push({ ...plan, key, equipment }); }
        };
        for (const plan of menu.plans) {
          queue = []; queues.push(queue);
          const changed = new Map(plan.changes);
          const companyOf = x => companies.find(c => c.id === (changed.get(x.id) || x.company));
          const equipment = Object.fromEntries(people.map(x => {
            const t = toolOf(x);
            return [x.id, t && (compatible(t, companyOf(x)) || companyOf(x).id === x.company) ? t.id : null];
          }));
          add(plan, equipment);
          if (plan.kind === 'swap') {
            const [[a], [b]] = plan.changes;
            const swapped = { ...equipment, [a]: toolOf(people.find(x => x.id === b))?.id || null,
              [b]: toolOf(people.find(x => x.id === a))?.id || null };
            for (const id of [a, b]) if (swapped[id] && !compatible(tools.get(swapped[id]), companyOf(people.find(x => x.id === id)))) swapped[id] = null;
            add(plan, swapped);
          }
          // Price the card with each compatible registered tool, including tools
          // currently held by another employee, and charge for the donor's loss.
          add(plan.kind === 'stay' ? { ...plan, kind: 'tool' } : plan, { ...equipment, [subjectId]: null });
          for (const t of available) {
            if (!compatible(t, companyOf(subject)) || equipment[subjectId] === t.id) continue;
            const donor = people.find(x => equipment[x.id] === t.id);
            const next = { ...equipment, [subjectId]: t.id };
            if (donor) {
              const old = tools.get(equipment[subjectId]);
              next[donor.id] = old && compatible(old, companyOf(donor)) ? old.id : null;
            }
            add(plan.kind === 'stay' ? { ...plan, kind: 'tool' } : plan, next);
          }
        }
        const plans = [];
        for (let depth = 0; plans.length < CARD_PLAN_CAP && queues.some(q => depth < q.length); depth++) {
          for (const q of queues) if (q[depth] && plans.length < CARD_PLAN_CAP) plans.push(q[depth]);
        }
        state = { plans, total: Math.max(menu.total, queues.reduce((n, q) => n + q.length, 0)), best: null, quotes: new Map(), layouts: new Map() };
        subjects.set(stateKey, state);
      }
      // Each plan's companies, members sorted and keyed with the subject left
      // as a gap: a projection then only fills in the subject's variant.
      const layoutOf = plan => {
        let layout = state.layouts.get(plan.key);
        if (layout) return layout;
        const stay = plan === state.plans[0] ? null : layoutOf(state.plans[0]);
        const changed = new Map(plan.changes);
        const toolIn = x => tools.get(plan.equipment[x.id]) || null;
        const part = m => (m.tool ? `@${m.tool.id}:${m.tool.hours}` : '');
        layout = companies.map(c => {
          const members = s.employees.filter(x => (changed.get(x.id) || x.company) === c.id)
            .map(x => ({ e: x, tool: toolIn(x) })).sort((a, b) => byId(a.e, b.e));
          const at = members.findIndex(m => m.e.id === subjectId);
          const keys = members.map((m, i) => (i === at ? '' : fingerprint(m.e)) + part(m));
          const head = c.id + ':' + (at < 0 ? keys.join('|') : keys.slice(0, at).map(k => k + '|').join(''));
          const tail = at < 0 ? '' : keys.slice(at).join('|');
          return { c, members, at, head, tail, key: numberOf(head + '\u0000' + tail) };
        });
        // The companies this plan arranges differently from staying.
        layout.touched = stay ? layout.flatMap((g, i) => g.head + g.tail !== stay[i].head + stay[i].tail ? [i] : []) : [];
        state.layouts.set(plan.key, layout);
        return layout;
      };
      const projectGroup = (g, members, key) => {
        let r = cache.get(key);
        if (r) return r;
        r = older.get(key);
        if (!r) {
          if (++used > budget) throw new Error('Projection budget reached.');
          r = projectCompany(s, g.c, members);
        }
        if (cache.size >= CARD_CACHE_CAP / 2) { older = cache; cache = new Map(); }
        cache.set(key, r);
        return r;
      };
      // Only the subject's company changes with the variant. The others are
      // projected once per layout, and their values summed in company order
      // around the subject's, as a plain sum over every company would.
      const project = (variant, plan) => {
        const layout = layoutOf(plan);
        if (layout.sub === undefined) {
          for (const g of layout) if (g.at < 0) g.fixed = projectGroup(g, g.members, `${g.key}`);
          layout.sub = layout.findIndex(g => g.at >= 0);
          let before = 0;
          for (let i = 0; i < layout.sub; i++) before += layout[i].fixed.value;
          layout.before = before;
          layout.after = layout.slice(layout.sub + 1).map(g => g.fixed.value);
        }
        const g = layout[layout.sub];
        let r = g.variants?.get(variant);
        if (!r) {
          r = projectGroup(g, g.members.map((m, i) => i === g.at ? { e: variant, tool: m.tool } : m), `${g.key}/${fingerprint(variant)}`);
          (g.variants ||= new WeakMap()).set(variant, r);
        }
        let value = layout.sub ? layout.before + r.value : r.value;
        for (const v of layout.after) value += v;
        return { value, layout, r, touched: layout.touched };
      };
      const groupOf = (p, i) => i === p.layout.sub ? p.r : p.layout[i].fixed;
      const rowsOf = p => p.layout.flatMap((g, i) => groupOf(p, i).employees);
      const best = (variant, plans = state.plans, scores = null) => {
        const stay = project(variant, state.plans[0]);
        let result = { ...stay, plan: state.plans[0] }, stayHappiness = null;
        for (const plan of plans) {
          if (plan.kind === 'stay') continue;
          const p = project(variant, plan);
          scores?.set(plan, p.value);
          if (!(p.value > result.value + EPS)) continue;
          // Companies arranged as when staying have the same rows, so only
          // those the plan changes can push someone below their threshold.
          stayHappiness ||= new Map(rowsOf(stay).map(row => [row.id, row.minHappiness]));
          const unsafe = p.touched.some(i => groupOf(p, i).employees.some(row => {
            const who = row.id === subjectId ? variant : people.get(row.id);
            const threshold = has(who, 'flightRisk') ? 50 : 30;
            return !has(who, 'anchor') && row.minHappiness < threshold && stayHappiness.get(row.id) >= threshold;
          }));
          if (!unsafe) result = { ...p, plan };
        }
        return result;
      };
      const nameOf = id => s.employees.find(x => x.id === id).name;
      const explain = plan => ({ ...plan, description: plan.kind === 'stay' ? 'stay in current arrangement'
        : plan.kind === 'tool' ? `reassign tools: ${Object.entries(plan.equipment).filter(([id, tool]) => tool !== (toolOf(s.employees.find(x => x.id === id))?.id || null)).map(([id, tool]) => `${nameOf(id)} ${tool ? `gets ${tools.get(tool).name}` : 'has no tool'}`).join('; ')}`
        : `${plan.kind}: ${plan.changes.map(([id, co]) => `${s.employees.find(x => x.id === id).name} to ${s.companies.find(c => c.id === co).name} (${s.companies.find(c => c.id === co).product})`).join('; ')}` });
      // A short menu for forecasts (the card pool behind Second Wind and the
      // energy feed): a card changes only the subject, so the plans that win
      // for a changed subject are, in practice, among the best for the
      // current one at each place they could work (company and tool), plus
      // the best few overall.
      const screened = () => {
        if (state.screened) return state.screened;
        const ranked = state.plans.slice(1).sort((a, b) => state.scores.get(b) - state.scores.get(a));
        const keep = new Set([state.plans[0], state.best.plan, ...ranked.slice(0, SCREEN_TOP)]);
        const seen = new Map();
        for (const plan of ranked) {
          const place = (new Map(plan.changes).get(subjectId) || subject.company) + '|' + (plan.equipment[subjectId] || '');
          const n = seen.get(place) || 0;
          if (n < SCREEN_PER_PLACE) { keep.add(plan); seen.set(place, n + 1); }
        }
        return state.screened = state.plans.filter(plan => keep.has(plan));
      };
      try {
        if (!state.best) { state.scores = new Map(); state.best = best(e, state.plans, state.scores); }
        const baselineStay = project(e, state.plans[0]).value;
        // `pool` prices a card as part of a forecast over the whole card pool
        // (the feed, and the trainings Second Wind adds) on the short menu.
        const quote = (c, pool = feed) => {
          const key = JSON.stringify([c, employee, context, pool]);
          if (state.quotes.has(key)) return state.quotes.get(key);
          let q;
          if (c.card === 'secondWind') {
            // Future hands have not been dealt. Like Luck, estimate their value
            // in the current company instead of searching placements for every
            // possible future trait pair under the live hand's finite budget.
            const value = EC.secondWindValue(forecastEmployee, c, ctx, 1);
            q = { value, stay: value, outcomes: [], plan: explain(state.plans[0]), forecast: true,
              note: 'Future training uses a bounded current-company estimate.' };
          } else if (pool && c.card === 'wildCard') {
            // A random trait and +1 to a random stat, in a forecast: the
            // trait's shift plus a +1 drill, apart. Pricing every pair cost
            // most of the feed; leaving out their interaction moved the
            // training outlooks of a 36-employee workforce by 0.2% on
            // average, 1.9% at most (2026-11-01).
            const traits = EC.eligibleTraits(e.traits.map(t => t.code), ctx.situation.gender, ['positive', 'mixed', 'negative']);
            const shifts = traits.map(t => traitShift(t.code));
            const drills = STATS.map(stat => quote({ card: 'drill', stat, delta: 1 }, true));
            const mean = k => shifts.reduce((v, x) => v + x[k], 0) / shifts.length + drills.reduce((v, x) => v + x[k], 0) / drills.length;
            q = { value: mean('value'), stay: mean('stay'), outcomes: [], plan: explain(state.best.plan), coverage: 'trait-plus-stat',
              note: 'Trait and stat priced apart. Unpriced non-output effects count as zero.' };
          } else {
            const codes = c.card === 'rehabAll' ? e.traits.filter(t => EC.TRAIT[t.code]?.polarity === 'negative').map(t => t.code)
              : c.card === 'mentoring' ? [c.code, c.to] : c.codes || [c.code].filter(Boolean);
            const unpriced = codes.find(code => !EC.TRAIT[code] || EC.TRAIT[code].unpriced && !(code === 'trainer' && s.trainingQuota > 0) && !(code === 'recruiter' && companies.some(c => c.recruitmentValues))
              || EC.TRAIT[code].partner && !e.traits.some(t => t.code === code));
            if (unpriced || c.card === 'rehab' && EC.TRAIT[c.code]?.polarity !== 'negative' || c.card === 'negotiation' && !EC.canNegotiate(e, c)) {
              q = { value: null, stay: null, outcomes: [], note: unpriced && !EC.TRAIT[unpriced] ? 'Trait not known to this tool.' : EC.TRAIT[unpriced]?.unpriced || (EC.TRAIT[unpriced]?.partner ? 'Linked employee is unknown; this trait is not a Habit outcome.' : 'Card is not available.'), plan: explain(state.plans[0]) };
            } else {
              let plans = pool ? screened() : state.plans;
              if (pool && c.card === 'habitPair') {
                const singles = c.codes.flatMap(code => {
                  const q = quote({ card: 'habit', code }, true);
                  return q.outcomes.length ? q.outcomes.map(o => o.plan) : [q.plan];
                });
                plans = [...new Map([state.plans[0], state.best.plan, ...singles].map(p => [p.key, p])).values()];
              }
              const outcomes = EC.cardOutcomes(e, c, ctx).map(o => {
                const b = best(o.employee, plans);
                const delta = o.employee.luck - e.luck;
                const future = delta ? EC.futureLuckValue(forecastEmployee, delta, ctx) : 0;
                return { p: o.p, arg: o.arg, value: (b.value - state.best.value) / ctx.ppValue + future,
                  stay: (project(o.employee, state.plans[0]).value - baselineStay) / ctx.ppValue + future, plan: explain(b.plan) };
              });
              const mean = k => outcomes.reduce((v, o) => v + o.p * o[k], 0);
              q = { value: mean('value'), stay: mean('stay'), outcomes: outcomes.length > 1 ? outcomes : [],
                plan: outcomes[0]?.plan || explain(state.plans[0]), coverage: pool ? c.card === 'habitPair' ? 'restricted-pair' : 'short-menu' : 'full-menu',
                note: codes.includes('anchor') ? "Anchor's output penalty is priced; protection against quitting is not." : codes.some(code => ['trainer', 'recruiter', 'luckyCharm', 'jinx'].includes(code)) ? coverage(s).join(' ') : c.card === 'wildCard' ? 'Unpriced non-output effects count as zero.' : null };
            }
          }
          state.quotes.set(key, q); return q;
        };
        // Gaining a trait, valued as the model sees it on the short menu,
        // unpriced effects included as zero. Shared by Wild Card forecasts.
        const traitShift = code => {
          const key = JSON.stringify(['shift', code, employee, context]);
          if (state.quotes.has(key)) return state.quotes.get(key);
          const outcomes = EC.cardOutcomes(e, { card: 'habit', code }, ctx).map(o => ({ p: o.p,
            value: (best(o.employee, screened()).value - state.best.value) / ctx.ppValue,
            stay: (project(o.employee, state.plans[0]).value - baselineStay) / ctx.ppValue }));
          const shift = { value: outcomes.reduce((v, o) => v + o.p * o.value, 0), stay: outcomes.reduce((v, o) => v + o.p * o.stay, 0) };
          state.quotes.set(key, shift);
          return shift;
        };
        const quotes = cards.map(c => quote(c));
        return { valid: true, basis: 'rearranged', horizon, quotes, baseline: explain(state.best.plan),
          coverage: { tested: state.plans.length, total: state.total }, projections: used,
          warnings: rowsOf(state.best).filter(r => r.minHappiness < 30).map(r => `${r.id} is already below 30 happiness.`) };
      } catch (error) { return { valid: false, basis: 'current-company', reason: error.message }; }
    }
    return { valid: !errors.length, horizon, price };
  }
  return { TOOL_TYPES, evaluate, recommend, cardSession, retentionSession, CARD_PLAN_CAP };
})();
if (typeof module !== 'undefined') module.exports = EmployeePlanner;
