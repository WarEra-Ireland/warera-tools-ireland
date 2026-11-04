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
  // The wage as reported, paid on today's paid Production (EC.paidProduction),
  // plus Climber raises to come.
  const wageAt = (e, hour) => !e.climberRaise ? e.wage
    : e.wage + e.climberRaise * (Math.floor((e.employedDays + hour / 24 + EPS) / 7) - Math.floor((e.employedDays + EPS) / 7));
  // The wage on `traitProduction` own-trait Production instead. When own
  // traits' flat Production is paid, it moves with the company and the hour.
  const paidWageAt = (e, hour, traitProduction) => wageAt(e, hour)
    * EC.paidProduction({ production: e.production, traitProduction }) / EC.paidProduction(e);
  // A move into a company the held tool does not fit sends it back to
  // inventory, where it is a spare for anyone else in the plan.
  const returnsTool = (e, a, tools, companies) => {
    const t = e.equipped && tools.find(t => t.id === e.equipped.id), c = companies.find(c => c.id === a.company);
    return t && c && a.company !== e.company && a.tool !== t.id && !compatible(t, c) ? t : null;
  };
  const initial = s => s.employees.map(e => ({ employee: e.id, company: e.company, tool: e.equipped?.id || null }));

  /* Tools are a pool that outlives any one holder. When a tool runs out,
   * its holder can get a free compatible tool (a spare, or one freed by a
   * retirement); a retiring holder's tool returns to the pool with its hours
   * left, for anyone compatible without a working tool. Spares go only to
   * those whose tool ran out: someone the plan leaves without a tool gets
   * none until a retirement frees one.
   * Tool-hours go by value, not by who asks first: the pair (employee in
   * need, free tool) that raises output most per hour is settled first, at
   * the later of the need and the tool's return, and so on. Output is
   * today's: Production / 4 x margin x (tool bonus + Handy - Improviser). A
   * tool wears only while held, so one handed on at hour 300 with 200 hours
   * left runs to hour 500. Disabled companies take no part.
   * `groups` is [{ company, members: [{ e, tool }] }]; returns a timeline
   * [{ tool, from, to }] (hours) per employee id. */
  const TOOL_TRAITS = { handy: 40, improviser: -25 };
  // Per employee: hours to retirement, output per point of margin, and the
  // trait points a tool adds. Records do not change during a search.
  const toolNeeds = new WeakMap();
  const needsOf = e => {
    let n = toolNeeds.get(e);
    if (!n) toolNeeds.set(e, n = { retire: EC.workingDays(e) * 24, output: (e.production + (e.traitProduction || 0)) / 4,
      extra: e.traits.reduce((v, t) => v + (TOOL_TRAITS[t.code] || 0), 0) });
    return n;
  };
  function handoffs(s, groups, spares) {
    const end = s.days * 24, lines = new Map(), waiting = [], pool = [];
    for (const t of spares) if (t.hours > 0) pool.push({ tool: t, at: 0, left: t.hours, freed: false });
    // After a segment: wait for the next tool, or hand this one back.
    const settle = p => {
      const seg = p.seg;
      if (seg.to < p.retire - EPS) {
        if (seg.to < end - EPS) { p.need = seg.to; p.ranOut = true; return true; }
      } else if (seg.to > p.retire + EPS && p.retire < end - EPS) {
        pool.push({ tool: seg.tool, at: p.retire, left: seg.to - p.retire, freed: true });
        seg.to = p.retire;
      }
      return false;
    };
    for (const { company, members } of groups) for (const { e, tool } of members) {
      const seg = tool ? { tool, from: 0, to: tool.hours } : null, line = seg ? [seg] : [];
      lines.set(e.id, line);
      if (company.disabled) continue;
      const n = needsOf(e);
      const p = { e, company, line, seg, need: 0, retire: n.retire, worth: n.output * company.margin, extra: n.extra, ranOut: false };
      if (!seg || settle(p)) waiting.push(p);
    }
    while (pool.length && waiting.length) {
      let best = null, bestGain = EPS, bestStart = 0;
      for (const q of pool) for (const p of waiting) {
        if (!(q.freed || p.ranOut) || !compatible(q.tool, p.company)) continue;
        const start = Math.max(p.need, q.at);
        if (!(start < Math.min(p.retire, end) - EPS)) continue;
        const gain = p.worth * (q.tool.bonus + p.extra);
        if (gain > bestGain + 1e-12 || (best && Math.abs(gain - bestGain) <= 1e-12 && (start < bestStart - EPS
          || Math.abs(start - bestStart) <= EPS && (q.left > best.q.left + EPS
          || Math.abs(q.left - best.q.left) <= EPS && (q.tool.id + '/' + p.e.id) < (best.q.tool.id + '/' + best.p.e.id))))) { best = { q, p }; bestGain = gain; bestStart = start; }
      }
      if (!best) break;
      const { q, p } = best;
      pool.splice(pool.indexOf(q), 1);
      p.line.push(p.seg = { tool: q.tool, from: bestStart, to: bestStart + q.left });
      if (!settle(p)) waiting.splice(waiting.indexOf(p), 1);
    }
    return lines;
  }
  // The tool a member holds at `hour`: their timeline's, or the one tool
  // held from hour 0 until it runs out.
  const toolAt = (m, hour) => {
    if (!m.timeline) return m.tool && hour < m.tool.hours ? m.tool : null;
    for (const x of m.timeline) if (x.from <= hour && hour < x.to) return x.tool;
    return null;
  };
  // A timeline's first segment, from hour 0, follows from the employee and
  // tool alone; later ones carry their hours.
  const memberKey = m => {
    const line = m.timeline;
    if (!line) return `${m.e.id}/${m.tool?.id || ''}`;
    let key = m.e.id + '/';
    for (let i = 0; i < line.length; i++) key += line[i].from ? `+${line[i].tool.id}@${line[i].from}-${line[i].to}` : line[i].tool.id;
    return key;
  };

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
      if (c.disabled && a.company !== e.company) errors.push(`${c.name} is disabled, so nobody is moved into it.`);
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
    const fx = { engine: 0, production: 0, responsibility: 0, luck: 0, bonus: 0, happiness: [], teamHappiness: [], teamProduction: 0, teamResponsibility: 0 };
    if (!hourly || !e.traits.length) return fx;
    // Pay as reported: a move's change to own-trait Production isn't in it.
    const own = wageAt(e, hour) + 1e-9;
    let betterPaid = 0;
    for (const x of others) if (wageAt(x, hour) > own) betterPaid++;
    // The trait rules only read what they are handed, so one record per
    // employee and roster is reused, its hourly fields set afresh.
    if (!sc.x) {
      const add = (key, n) => { sc.fx[key] += n; return 0; };
      const x = sc.x = {
        s: { ...fixed }, e, age: 0, tenure: 0, held: true, loss: 0, male: others.length - femaleCoworkers,
        engine: () => add('engine', (company.engineDailyProd || 0) / 24 * (1 + (company.engineBonus || 0))),
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
    let roster = members.filter(({ e }) => hour < EC.workingDays(e) * 24).map(({ e }) => e);
    if (rosters) {
      const key = roster.map(e => e.id).join(',');
      roster = rosters.get(key) || (rosters.set(key, roster), roster);
    }
    const rows = members.filter(({ e }) => roster.includes(e)).map(m => {
      const e = m.e, heldTool = toolAt(m, hour);
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
      let toolboxes = company.full && !f.salvager ? 0 : EC.toolboxRate(luck) * (f.scavenger ? 2 : 1);
      let loot = toolboxes * (s.toolboxValue || 0);
      const trainingsPerDay = Number.isFinite(o.trainingsPerDay) ? o.trainingsPerDay : 1 + 2 * trainers;
      let trainingRate = Math.min(s.trainingQuota || 0, trainingsPerDay);
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
      // A disabled company's employees don't work, train or get paid there
      // (nor age: they leave only by moving, and then start working).
      const off = !!company.disabled;
      const output = off ? 0 : production / 4 * Math.max(0, 1 + bonus / 100);
      // Current pay already includes Greedy, Modest and past Climber raises.
      const wage = off ? 0 : paidWageAt(e, hour, fx.production);
      const engine = off ? 0 : fx.engine;
      if (off) toolboxes = loot = trainingRate = 0;
      const row = { luck, learningLuck, toolboxes, loot, trainingRate, trainingsPerDay, id: e.id, company: company.id, tool: tool?.id || null, production, responsibility, happiness: mood, specialization, bonus,
        parts: { company: company.bonus, traits: fx.bonus + anchor, events, specialization, happiness: mood - 50, tool: tool?.bonus || 0, traitProduction: production - e.production },
        output, engineOutput: engine, wage, profit: (output + engine) * company.margin - wage + loot };
      calc.push({ engine, production: off ? 0 : production, pre: company.bonus + fx.bonus + events, mood, tool: tool?.bonus || 0, anchor, saved, loot, rate: f.quickStudy ? 2 : 1, wage });
      return row;
    });
    result.calc = calc;
    return result;
  }
  // A row's profit on a later day of the same stretch, where only
  // specialization moves: instant's arithmetic in the same order.
  const profitOn = (c, d, margin) =>
    c.production / 4 * Math.max(0, 1 + (c.pre + Math.min(20, c.saved + d * c.rate) + c.mood - 50 + c.tool + c.anchor) / 100) * margin + c.engine * margin - c.wage + c.loot;
  // The production points behind profitOn: its output and engine terms.
  const ppOn = (c, d) =>
    c.production / 4 * Math.max(0, 1 + (c.pre + Math.min(20, c.saved + d * c.rate) + c.mood - 50 + c.tool + c.anchor) / 100) + c.engine;
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
    // s.hours, when given, replaces whole days (a career step can be part of one).
    const end = s.hours ?? s.days * 24, span = end / 24, days = Math.max(1, Math.ceil(span - EPS));
    // Effects are worked out afresh only where something other than
    // specialization can change; days in between reuse them (profitOn).
    const boundaries = new Set([0, end]);
    for (const m of members) {
      const { e } = m, moved = e.company !== company.id;
      if (m.timeline) for (const x of m.timeline) { if (x.from > 0) boundaries.add(x.from); if (x.to < end) boundaries.add(x.to); }
      for (const h of [m.timeline ? 0 : m.tool?.hours, EC.workingDays(e) * 24, ...e.happiness.map(x => x.hours), ...(e.productionEvents || []).map(x => x.hours), ...traitHours(e, moved, end)]) {
        if (h > 0 && h < end) boundaries.add(h);
      }
      if (e.traits.some(t => AGE_TRAITS.has(t.code))) {
        for (let d = 1; d < days; d++) if (Math.floor((e.age + d) / 10) !== Math.floor((e.age + d - 1) / 10)) boundaries.add(d * 24);
      }
    }
    const hours = [...boundaries].sort((a, b) => a - b);
    // Per member, by their place in `members`.
    const slot = new Map(members.map(({ e }, i) => [e.id, i]));
    const totals = members.map(() => 0), trainingProgress = members.map(() => 0), trainingValues = members.map(() => 0);
    const minHappiness = members.map(() => 100);
    const daily = new Array(days).fill(0);
    // pp: production points made (output + engine) x hours, for price exposure.
    let value = 0, pp = 0;
    const rosters = new Map(), flags = flagsFor(members);
    let first = null;
    for (let i = 0; i < hours.length - 1; i++) {
      const rows = instant(s, company, members, hours[i], rosters, flags);
      if (i === 0) first = rows;
      const at = rows.map(row => slot.get(row.id));
      if (s.trainingQuota > 0) for (let r = 0; r < rows.length; r++) {
        const row = rows[r], m = at[r], e = members[m].e, daysLeft = EC.workingDays(e);
        if (!(e.potentialLeft > 0) || !e.trainingValues) continue;
        const from = hours[i] / 24, to = hours[i + 1] / 24;
        const before = trainingProgress[m], after = Math.min(e.potentialLeft, before + row.trainingRate * (to - from));
        if (row.trainingRate === Math.min(1, s.trainingQuota) && row.learningLuck === e.trainingLuck && Math.abs(before - Math.min(e.potentialLeft, from * row.trainingRate)) < 1e-9) {
          trainingProgress[m] = after;
          continue;
        }
        const mean = trainingMean(e, Math.max(1, row.learningLuck), s.management || 0), baseMean = trainingMean(e, e.trainingLuck ?? row.learningLuck, s.management || 0);
        const credit = (at, amount) => {
          const benefit = amount * Math.max(0, Math.min(daysLeft, span) - at) / daysLeft;
          if (!benefit) return;
          value += benefit; daily[Math.min(days - 1, Math.floor(at))] += benefit;
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
          pp += (day === start ? row.output + row.engineOutput : ppOn(rows.calc[r], day)) * (next - h);
          value += gain; daily[day] += gain; totals[at[r]] += gain;
          if (row.happiness < minHappiness[at[r]]) minHappiness[at[r]] = row.happiness;
        }
        h = next;
      }
    }
    if (company.recruitmentValues && !company.disabled) {
      const recruiters = members.filter(({ e }) => has(e, 'recruiter') && EC.workingDays(e) > 0);
      const benefit = company.recruitmentValues[Math.min(3, recruiters.length)] - company.recruitmentValues[0];
      value += benefit; daily[0] += benefit;
      for (const { e } of recruiters) totals[slot.get(e.id)] += benefit / recruiters.length;
    }
    return { value, pp, daily, employees: (first || instant(s, company, members, 0, rosters, flags)).map(r => ({ ...r, value: totals[slot.get(r.id)], trainingValue: trainingValues[slot.get(r.id)], minHappiness: minHappiness[slot.get(r.id)] })) };
  }

  // Projections are cached per (company, roster, tool timelines); `misses`
  // counts the projections actually run, which is what the search budget limits.
  function projector(s) {
    const cache = new Map();
    const p = { misses: 0 };
    p.key = (company, members) => company.id + ':' + members.map(memberKey).join(',');
    p.project = (company, members, key) => {
      if (!key) { members = [...members].sort((a, b) => byId(a.e, b.e)); key = p.key(company, members); }
      let r = cache.get(key);
      if (!r) { p.misses++; r = projectCompany(s, company, members); cache.set(key, r); }
      return r;
    };
    return p;
  }

  const indexes = new WeakMap();
  function indexOf(s) {
    let x = indexes.get(s);
    if (!x) indexes.set(s, x = { employees: [...s.employees].sort(byId), tools: new Map(s.tools.map(t => [t.id, t])),
      planned: s.companies.filter(c => !c.excluded).sort(byId) });
    return x;
  }
  const toolTypeOf = product => Object.keys(TOOL_TYPES).find(k => TOOL_TYPES[k].includes(product)) || null;
  // The planned companies' rosters under an assignment (Map id -> { company,
  // tool }), members sorted by id, each with its tool timeline. Every tool
  // the assignment leaves unheld is a spare.
  function arrange(s, assign) {
    const { employees, tools, planned } = indexOf(s);
    const at = new Map(planned.map(c => [c.id, []])), held = new Set();
    for (const e of employees) {
      const a = assign.get(e.id);
      if (a.tool) held.add(a.tool);
      at.get(a.company)?.push({ e, tool: tools.get(a.tool) || null });
    }
    const groups = planned.map(company => ({ company, members: at.get(company.id) }));
    const lines = handoffs(s, groups, s.tools.filter(t => !held.has(t.id)));
    for (const g of groups) for (const m of g.members) m.timeline = lines.get(m.e.id);
    groups.lines = lines;
    return groups;
  }

  // Projects an assignment over the companies being planned. Each row also
  // lists the tools its employee gets later (`handoffs`).
  function totals(s, P, assign) {
    const groups = arrange(s, assign).map(g => {
      const r = P.project(g.company, g.members), later = new Map(g.members.map(m => [m.e.id, m.timeline.slice(m.timeline[0]?.from === 0 ? 1 : 0)]));
      return { ...r, employees: r.employees.map(row => ({ ...row, handoffs: later.get(row.id).map(x => ({ tool: x.tool.id, from: x.from, to: x.to })) })) };
    });
    const daily = new Array(s.days).fill(0);
    for (const g of groups) g.daily.forEach((v, i) => { daily[i] += v; });
    return { value: groups.reduce((a, g) => a + g.value, 0), daily, employees: groups.flatMap(g => g.employees) };
  }

  const excludedList = s => s.companies.filter(c => c.excluded).map(c => ({ company: c.id, name: c.name, reason: c.excluded }));

  function coverage(s, threshold = null) {
    const notes = ['Earnings assume employees stay. Quit probabilities and future price changes are not valued.'];
    if (threshold) notes.push(`Minimum gain: prices are recent trades, so a change is recommended only if it still gains ${threshold.floor.toFixed(2)} (${100 * threshold.floorShare}% of the planned companies' profit over the horizon) after ${100 * threshold.priceUncertainty}% of the output whose value depends on prices comes off, netted by product. A move or swap of someone moved in the last ${threshold.recentHours / 24} days needs ${threshold.recentFactor} times as much.`);
    if (s.tools.length) notes.push("Tools are a pool: a tool that runs out is replaced by the best free compatible tool, and a retiring employee's tool passes on with its hours left, to whoever it raises output most. Spares replace only tools that ran out.");
    if (!s.toolboxValue) notes.push('Toolbox income is excluded: set a toolbox value to include Luck, Scavenger and Salvager loot benefits.');
    if (!s.trainingQuota) notes.push('Trainer and coworker Luck training benefits are excluded: set a daily training budget.');
    else notes.push('Trainer and coworker Luck use a bounded numeric-card estimate, fixed current training values and an equal share of the daily energy budget.');
    if (s.toolboxValue || s.trainingQuota) notes.push("Unchanged rosters keep the game's reported Luck and training allowance. A changed roster gets Lucky Charm, Jinx and Trainer effects at once. A Trainer gained from a card works at once in the game; how soon moves and the Luck traits take effect is not yet known.");
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
          || (!c.disabled && Number.isFinite(o.output) && Math.abs(row.output - o.output) > 0.011)) {
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
      const members = s.employees.filter(x => x.company === company.id).map(e => ({ e, tool: tools.get(e.equipped?.id) || null }));
      const days = Math.min(47, Math.max(1, ...members.map(({ e }) => Math.ceil(EC.workingDays(e)))));
      // Handoffs within this company, with the spares and, without the
      // employee, their tool back in inventory.
      const project = rows => {
        const sd = { ...s, days }, held = new Set(rows.map(m => m.tool?.id));
        const lines = handoffs(sd, [{ company, members: rows }], s.tools.filter(t => (!t.holder || t.holder === id) && !held.has(t.id)));
        return projectCompany(sd, company, rows.map(m => ({ ...m, timeline: lines.get(m.e.id) })));
      };
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

  /* Minimum gain. Prices are recent trades held flat for the horizon, so a
   * gain that hinges on them, or one too small to be worth the effort of
   * making it, is not recommended (planner-churn ticket 02).
   * - Price exposure: a change's value is linear in margins, gain =
   *   sum over products of margin x change in production points, plus wages,
   *   loot and training. Netted by product, `priceUncertainty` of that sum
   *   comes off the gain: a cross-product swap carries both products' output,
   *   a tool change inside a company only its extra output.
   * - Churn floor: what is left must reach `floorShare` of the planned
   *   companies' baseline profit over the horizon, and at least `floorMin`.
   * - A move or swap of someone moved within `recentHours` needs
   *   `recentFactor` x the floor. Records carry no earlier company, so a move
   *   back is caught only while it is this recent.
   * `minMax` (or a snapshot's `minMax`) turns all of it off: the search then
   * takes any gain, the pure maximum. */
  const CHURN = { priceUncertainty: 0.05, floorShare: 0.002, floorMin: 1, recentHours: 72, recentFactor: 3 };

  /* Best-improvement local search over moves, direct swaps and tool changes.
   * Every round scores each employee's options, interleaved so a budget cut
   * falls evenly on the workforce, and accepts the single best change (by
   * gain less price exposure, among those clearing the floor). Ties break on
   * a canonical key, so input order does not change the result. Identical
   * available tools (same type, bonus and hours) are one option. */
  function recommend(snapshot, { maxProjections = 60000, allowMoves = true, onProgress = null, compareOutputOnly = true, minMax = !!snapshot.minMax, floorAt = null } = {}) {
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
    // Each planned company's current projection key and value. A change can
    // move tools on to other companies (handoffs), so every company whose
    // key changes is re-projected, not just those the change touches.
    // `money`: margin x production points, the price-exposed part.
    const keys = new Map(), value = new Map(), money = new Map();
    let lines = new Map();
    const refresh = () => {
      const groups = arrange(s, assign);
      for (const g of groups) {
        const key = P.key(g.company, g.members);
        if (keys.get(g.company.id) !== key) {
          const r = P.project(g.company, g.members, key);
          keys.set(g.company.id, key); value.set(g.company.id, r.value); money.set(g.company.id, g.company.margin * r.pp);
        }
      }
      lines = groups.lines;
      for (const g of groups) { current.set(g.company.id, g.members); heldTypes.set(g.company.id, [...new Set(g.members.flatMap(m => m.tool ? [m.tool.type] : []))]); }
    };
    // Tools only go to compatible companies, so handoffs split by tool type:
    // a candidate reschedules only the companies its tool types reach (a
    // tool held outside its type's companies links two types).
    const typeOf = new Map(planned.map(c => [c.id, toolTypeOf(c.product)]));
    const heldTypes = new Map(), current = new Map(), toolsOfType = new Map();
    for (const t of s.tools) { if (!toolsOfType.has(t.type)) toolsOfType.set(t.type, []); toolsOfType.get(t.type).push(t); }
    refresh();
    const sameLine = (a, b) => a.length === b.length && a.every((x, i) => x.tool === b[i].tool && x.from === b[i].from && x.to === b[i].to);
    const baseline = totals(s, P, assign);
    // floorAt: the output-only comparison search keeps the full model's floor.
    const floor = minMax ? 0 : floorAt ?? Math.max(CHURN.floorMin, CHURN.floorShare * baseline.value);
    // The floor a candidate must clear: higher if it moves someone moved lately.
    const floorFor = changes => changes.some(([id, company]) => company !== assign.get(id).company && employees.get(id).moveAgeHours < CHURN.recentHours)
      ? CHURN.recentFactor * floor : floor;
    const steps = [], moved = new Set();
    const movable = e => allowMoves && !e.locked && !moved.has(e.id);
    const search = { rounds: 0, candidates: 0, projections: 0, maxProjections, limited: false, stopped: 'converged',
      threshold: minMax ? null : { floor, ...CHURN }, dropped: null, accepted: [] };

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
        if (c.id === here.id || c.disabled || roster.get(c.id).length >= c.capacity) continue;
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
        if (here.disabled || there.disabled) continue;
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

    // Gain of a candidate: companies whose rosters or tool timelines it
    // changes are re-projected. Leaves its price exposure, the change in
    // margin x production points netted by product, in `exposure`, and that
    // change per product in `byProduct`.
    let exposure = 0, byProduct = new Map();
    function score(candidate) {
      const over = new Map(), touched = new Set(), types = new Set(), taken = new Set();
      // A type with no tools has nothing to hand on.
      const note = x => { if (toolsOfType.has(x)) types.add(x); };
      for (const [id, company, tool] of candidate.changes) {
        const was = assign.get(id);
        over.set(id, { company, tool }); touched.add(was.company).add(company);
        if (tool) taken.add(tool);
        note(typeOf.get(was.company)); note(typeOf.get(company)); note(tools.get(was.tool)?.type); note(tools.get(tool)?.type);
      }
      const membersOf = c => {
        const ids = roster.get(c).filter(x => !over.has(x) || over.get(x).company === c);
        for (const [x, a] of over) if (a.company === c && assign.get(x).company !== c) ids.push(x);
        return ids.sort().map(x => ({ e: employees.get(x), tool: tools.get((over.get(x) || assign.get(x)).tool) || null }));
      };
      const groups = [], held = new Map();
      for (const id of touched) {
        const members = membersOf(id), company = companies.get(id);
        if (members.length > company.capacity) return null;
        groups.push({ company, members });
        held.set(id, members.flatMap(m => m.tool ? [m.tool.type] : []));
      }
      for (const g of groups) for (const t of held.get(g.company.id)) note(t);
      for (let grew = types.size > 0; grew;) {
        grew = false;
        for (const c of planned) {
          if (touched.has(c.id) || held.has(c.id)) continue;
          const own = heldTypes.get(c.id);
          if (!types.has(typeOf.get(c.id)) && !own.some(t => types.has(t))) continue;
          held.set(c.id, own); groups.push({ company: c, members: current.get(c.id), same: true });
          note(typeOf.get(c.id)); for (const t of own) note(t);
          grew = true;
        }
      }
      const spares = [];
      for (const type of types) for (const t of toolsOfType.get(type) || []) {
        const h = holder.get(t.id);
        if (!taken.has(t.id) && !(h && !over.has(h))) spares.push(t);
      }
      groups.sort((a, b) => byId(a.company, b.company));
      // Without tool types in play, nobody holds or gets a tool.
      const next = types.size ? handoffs(s, groups, spares) : { get: () => [] };
      let gain = 0;
      byProduct = new Map();
      for (const g of groups) {
        if (g.same) {
          if (g.members.every(m => sameLine(next.get(m.e.id), m.timeline))) continue;
          g.members = g.members.map(m => ({ e: m.e, tool: m.tool }));
        }
        for (const m of g.members) m.timeline = next.get(m.e.id);
        const key = P.key(g.company, g.members);
        if (key === keys.get(g.company.id)) continue;
        const r = P.project(g.company, g.members, key), c = g.company;
        gain += r.value - value.get(c.id);
        byProduct.set(c.product, (byProduct.get(c.product) || 0) + c.margin * r.pp - money.get(c.id));
      }
      exposure = 0;
      for (const x of byProduct.values()) exposure += Math.abs(x);
      return gain;
    }

    function apply({ changes, step }) {
      for (const [id, company, tool] of changes) {
        const was = assign.get(id);
        if (was.tool) holder.delete(was.tool);
        roster.set(was.company, roster.get(was.company).filter(x => x !== id));
        roster.get(company).push(id);
        assign.set(id, { company, tool });
      }
      for (const [id, , tool] of changes) if (tool) holder.set(tool, id);
      refresh();
      if (step) { steps.push(step); step.employees.forEach(id => moved.add(id)); }
    }

    function result(partial) {
      const proposed = totals(s, P, assign);
      const warnings = riskWarnings(s, proposed.employees);
      return { valid: true, partial, baseline, proposed, gain: proposed.value - baseline.value,
        coverage: coverage(s, search.threshold), arrangement: s.employees.map(e => ({ employee: e.id, ...assign.get(e.id) })), steps: [...steps], warnings,
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
        { maxProjections: remaining, allowMoves, compareOutputOnly: false, minMax, floorAt: floor });
      const scored = evaluate(s, alternative.arrangement);
      const search = { ...primary.search, projections: primary.search.projections + alternative.search.projections + planned.length,
        alternativeProjections: alternative.search.projections, selectedOutputOnly: scored.value > primary.proposed.value + 1e-7 };
      if (!search.selectedOutputOnly) return { ...primary, search };
      return { ...primary, proposed: scored, gain: scored.value - baseline.value, arrangement: alternative.arrangement,
        steps: alternative.steps, unused: alternative.unused, warnings: scored.warnings, search: { ...search, accepted: alternative.search.accepted } };
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
      let best = null, bestGain = 1e-7, bestProducts = null;
      // Gains left out by the threshold this round, best per set of people.
      const dropped = new Map();
      outer: for (let depth = 0; queues.some(q => depth < q.length); depth++) {
        for (let n = 0; n < queues.length; n++) {
          const candidate = queues[(start + n) % queues.length][depth];
          if (!candidate) continue;
          if (P.misses >= maxProjections) { search.limited = true; search.stopped = 'budget'; break outer; }
          let gain = score(candidate);
          search.candidates++;
          if (gain == null) continue;
          if (!minMax) {
            const robust = gain - CHURN.priceUncertainty * exposure, need = floorFor(candidate.changes);
            if (robust < need) {
              if (gain > 1e-7) {
                const who = [...new Set(candidate.changes.map(c => c[0]))].sort().join();
                const was = dropped.get(who);
                if (!was || gain > was.gain) dropped.set(who, { gain, robust, need, changes: candidate.changes });
              }
              continue;
            }
            candidate.priced = { gain, exposure, need };
            gain = robust;
          }
          if (gain > bestGain + 1e-9 || (best && Math.abs(gain - bestGain) <= 1e-9 && candidate.key < best.key)) { best = candidate; bestGain = gain; bestProducts = byProduct; }
        }
      }
      search.rounds++;
      if (!minMax) {
        const left = [...dropped.values()].sort((x, y) => y.gain - x.gain);
        search.dropped = { count: left.length, best: left[0]?.gain || 0, top: left.slice(0, 5) };
      }
      if (!best) return finish();
      // Each accepted change, with its gain, price exposure, floor, and
      // margin x production points change per product (also under minMax).
      search.accepted.push({ key: best.key, changes: best.changes, gain: best.priced?.gain ?? bestGain, exposure: best.priced?.exposure ?? null, need: best.priced?.need ?? 0,
        byProduct: Object.fromEntries(bestProducts) });
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
      for (const c of companies) if (c.id !== e.company && !c.disabled && count(c.id) < c.capacity) add('move', [[e.id, c.id]]);
    };
    const swaps = (e, partners) => {
      if (!movable(e)) return;
      const off = id => companies.find(c => c.id === id)?.disabled;
      if (off(e.company)) return;
      for (const f of partners) if (movable(f) && f.company !== e.company && !off(f.company)) add('swap', [[e.id, f.company], [f.id, e.company]]);
    };
    moves(subject); swaps(subject, people);
    const peers = people.filter(e => e.id !== subject.id && e.company === subject.company);
    peers.forEach(moves);
    const home = companies.find(c => c.id === subject.company);
    people.filter(e => e.company !== subject.company && movable(e)).forEach(e => {
      if (!home.disabled && count(subject.company) < home.capacity) add('move', [[e.id, subject.company]]);
    });
    peers.forEach(e => swaps(e, people));
    return { plans: plans.slice(0, CARD_PLAN_CAP), total: plans.length };
  }

  function cardSession(snapshot) {
    const prepared = withExclusions(snapshot);
    const horizon = Math.min(47, Math.max(1, Math.ceil(Math.max(0, ...prepared.employees
      .filter(e => !prepared.companies.find(c => c.id === e.company)?.excluded).map(e => EC.workingDays(e))))));
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
        e.production, e.traitProduction, e.responsibility, e.wage, e.climberRaise])));
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
        wageExpectation: employee.wageExpectation ?? subject.wage / (EC.paidProduction(subject) / 4 * (snapshot.ppValue || 1)) };
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
        const part = m => m.timeline.map(x => `@${x.tool.id}:${x.from}-${x.to}`).join('');
        // Handoffs follow the current subject; a card's variant keeps them.
        const groups = companies.map(c => ({ company: c, members: s.employees.filter(x => (changed.get(x.id) || x.company) === c.id)
          .map(x => ({ e: x, tool: toolIn(x) })).sort((a, b) => byId(a.e, b.e)) }));
        const held = new Set(Object.values(plan.equipment));
        const lines = handoffs(s, groups, s.tools.filter(t => !held.has(t.id) && (!t.holder || people.has(t.holder) && companies.some(c => c.id === people.get(t.holder).company))));
        layout = groups.map(({ company: c, members }) => {
          for (const m of members) m.timeline = lines.get(m.e.id);
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
          r = projectGroup(g, g.members.map((m, i) => i === g.at ? { ...m, e: variant } : m), `${g.key}/${fingerprint(variant)}`);
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
          if (c.card === 'reroll') {
            const value = EC.trainingOutlook(e, ctx, { price: card => quote(card, true).value }).value;
            const stay = EC.cardValue(e, c, ctx);
            q = { value, stay, outcomes: [], plan: explain(state.best.plan), forecast: true,
              note: 'A fresh hand, including further Rerolls, with rarity rolled again.' };
          } else if (c.card === 'secondWind') {
            // Future hands have not been dealt. Like Luck, estimate their value
            // in the current company instead of searching placements for every
            // possible future trait pair under the live hand's finite budget.
            const value = EC.secondWindValue(forecastEmployee, c, ctx, 1);
            q = { value, stay: value, outcomes: [], plan: explain(state.plans[0]), forecast: true,
              note: 'Future training uses a bounded current-company estimate, net of what the energy earns elsewhere.' };
          } else if (pool && c.card === 'wildCard') {
            // A random trait and +2 to a random stat, in a forecast: the
            // trait's shift plus a +2 drill, apart. Pricing every pair cost
            // most of the feed; leaving out their interaction moved the
            // training outlooks of a 36-employee workforce by 0.2% on
            // average, 1.9% at most (2026-11-01).
            const traits = EC.eligibleTraits(e.traits.map(t => t.code), ctx.situation.gender, ['positive', 'mixed', 'negative']);
            const shifts = traits.map(t => traitShift(t.code));
            const drills = STATS.map(stat => quote({ card: 'drill', stat, delta: EC.CFG.wildCardStatGain }, true));
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
  // Rules for EmployeeCareer: the subject's company projected a step at a
  // time, with every card in `hand` (and taking nothing) as a paired arm.
  // Card scores are the planner's own profit projections, so cards of every
  // kind compare on one footing. Second Wind values its extra trainings at a
  // fresh hand's expected best card, in which a further Second Wind counts 0:
  // one level of lookahead, so chains of Second Winds stay finite.
  function careerOptions(snapshot, subjectId, hand, { seed = 1729, start = 0, count = 64, energyValue = 0 } = {}) {
    const subject = snapshot.employees.find(e => e.id === subjectId);
    const company = snapshot.companies.find(c => c.id === subject?.company);
    if (!subject || !company || company.disabled || company.excluded) throw Error('An active employee is required.');
    const pp = snapshot.ppValue;
    if (!(pp > 0)) throw Error('Market production-point value is required.');
    // Only the subject's company is projected, so only its data must be complete.
    const roster = snapshot.employees.filter(e => e.company === company.id);
    const ids = new Set(roster.map(e => e.id));
    const local = { ...snapshot, days: 1, companies: [company], employees: roster,
      tools: snapshot.tools.filter(t => ids.has(t.holder) || roster.some(e => e.equipped?.id === t.id)) };
    const errors = validate(local, initial(local));
    if (errors.length) throw Error(errors[0]);
    for (const e of roster) { const reason = uncertainty(e); if (reason) throw Error(`${e.name} ${reason}.`); }
    const horizon = EC.workingDays(subject);
    if (!Number.isFinite(horizon)) throw Error('Working days left are required.');
    const peers = roster.filter(e => e.id !== subjectId);
    const fixed = { ...local, trainingQuota: 0 };
    const co = { ...company, recruitmentValues: null };
    const energyCost = t => EC.energyOn({ energyValue }, t);
    // Career states are never mutated, so each one's derived values are kept.
    const memo = f => { const m = new WeakMap(); return e => { let v = m.get(e); if (v === undefined) m.set(e, v = f(e)); return v; }; };
    // Many sampled careers pass through the same state (same day, same cards
    // taken). Values that depend only on what cards change, and on the day,
    // are shared between them by this signature. Potential left is not part
    // of it: nothing shared depends on it.
    const signature = memo(e => JSON.stringify([e.elapsed, e.production, e.responsibility, e.luck, e.traits, e.wage,
      e.negotiationExpectation, e.climberRaise, e.traitProduction, e.potentialMax]));
    const SHARED_LIMIT = 50000;
    const shared = f => {
      const m = new Map();
      return e => {
        const k = signature(e);
        let v = m.get(k);
        if (v === undefined) { if (m.size >= SHARED_LIMIT) m.clear(); m.set(k, v = f(e)); }
        return v;
      };
    };
    const shifted = (e, days) => ({ ...e, age: e.age + days,
      retireInDays: Math.max(0, EC.workingDays(e) - days), tenure: e.tenure + days,
      employedDays: e.employedDays + days, moveAgeHours: e.moveAgeHours + days * 24,
      wage: wageAt(e, days * 24),
      negotiationExpectation: e.negotiationExpectation == null ? undefined : e.negotiationExpectation + (has(e, 'climber') ? 0.02 * (Math.floor((e.employedDays + days + EPS) / 7) - Math.floor((e.employedDays + EPS) / 7)) : 0),
      specializations: Object.fromEntries(Object.entries(e.specializations).map(([good, n]) =>
        [good, good === co.product ? Math.min(20, n + days * (has(e, 'quickStudy') ? 2 : 1)) : n])),
      happiness: e.happiness.map(x => ({ ...x, hours: x.hours - days * 24 })).filter(x => x.hours > 0),
      productionEvents: (e.productionEvents || []).map(x => ({ ...x, hours: x.hours - days * 24 })).filter(x => x.hours > 0),
    });
    const members = memo(e => [e, ...peers.map(p => shifted(p, e.elapsed))].map(p => {
      const tool = snapshot.tools.find(t => t.id === p.equipped?.id);
      return { e: p, tool: tool ? { ...tool, hours: Math.max(0, tool.hours - e.elapsed * 24) } : null };
    }));
    let projections = 0, pools = 0;
    const project = (e, days = 1) => { projections++; return projectCompany({ ...fixed, hours: days * 24 }, co, members(e)).value / pp; };
    const base = shared(e => project(e));
    const ctx = memo(e => ({ ppValue: pp, situation: { ...scene(e, co, members(e).map(m => m.e).filter(p => EC.workingDays(p) > 0)).s,
      gender: e.gender, tenureDays: e.tenure, employedDays: e.employedDays,
      coworkerIds: peers.filter(p => EC.workingDays(p) > e.elapsed).map(p => p.id) } }));
    // Wage per paid point, which cards move (paidProduction is at least 1).
    const model = memo(e => ({ ...e, wageExpectation: e.wage / (EC.paidProduction(e) / 4 * pp) }));
    const self = shared(e => instant(fixed, co, members(e), 0).find(r => r.id === e.id));
    // Trainer coworkers add trainings; the game's reported allowance stands
    // while the roster is the reported one (see instant).
    const rate = e => self(e)?.trainingsPerDay ?? 1;
    const outcomes = (e, c) => EC.cardOutcomes(model(e), c, ctx(e));
    const pool = shared(e => { pools++; return EC.cardPool(model(e), ctx(e), { price: c => c.card === 'negotiation' && !EC.canNegotiate(model(e), c) ? null : 0 }); });
    const odds = shared(e => {
      const p = pool(e), all = EC.rarityOdds(self(e)?.luck ?? e.luck, snapshot.management || 0);
      const open = EC.RARITIES.filter(r => p[r].length >= EC.CFG.handSize);
      const total = open.reduce((sum, r) => sum + all[r], 0);
      return open.map(r => ({ rarity: r, p: all[r] / total }));
    });
    const stepMemo = shared(() => new Map());
    const key = c => [c.card, c.stat, c.delta, c.drop, c.gain, c.code, c.codes?.join('+'), c.to].join('|');
    const cardMemo = shared(() => new Map());
    // Career PP of a card taken now, against taking nothing: a day's change in
    // company profit over the working days left. null if it can't be taken.
    const lasting = (e, c) => {
      const m = cardMemo(e), k = key(c);
      if (!m.has(k)) {
        const o = outcomes(e, c);
        m.set(k, o.length ? (o.reduce((sum, x) => sum + x.p * project(x.employee), 0) - base(e)) * EC.workingDays(e) : null);
      }
      return m.get(k);
    };
    // A fresh hand's expected best card, Reroll left out and Second Wind at 0.
    // Two new habits count as the sum of each alone, as in the core model:
    // projecting every pair (about a hundred) would dominate the run.
    const estimate = (e, c) => c.card === 'secondWind' ? 0
      : c.card === 'habitPair' ? c.codes.reduce((sum, code) => sum + (lasting(e, { card: 'habit', code }) ?? 0), 0)
      : lasting(e, c) ?? 0;
    const fresh = shared(e => {
      const p = pool(e);
      return odds(e).reduce((sum, { rarity, p: w }) => sum + w * EC.expectedMax(p[rarity].filter(c => c.card !== 'reroll')
        .map(c => estimate(e, c)), EC.CFG.handSize), 0);
    });
    const reference = shared(e => Math.max(0, ...['production', 'responsibility', 'luck'].map(stat => lasting(e, EC.drill(stat, 1)) ?? 0),
      EC.canNegotiate(model(e), EC.neg(0.05)) ? lasting(e, EC.neg(0.05)) ?? 0 : 0));
    const capped = (e, c) => c.card === 'secondWind' && (!Number.isFinite(e.potentialMax) || e.potentialMax + c.gain > EC.CFG.potentialMaxCap);
    // Each extra training comes after the potential already left, so it is
    // worth a fresh hand discounted to the working days then remaining, less
    // what its energy would earn that day.
    const windValue = (e, c, time) => {
      const days = EC.workingDays(e), r = rate(e);
      if (!(days > 0) || !(r > 0)) return 0;
      const v = fresh(e);
      let total = 0;
      for (let j = 1; j <= c.gain; j++) {
        const until = (e.potentialLeft + j) / r;
        total += Math.max(0, v * Math.max(0, days - until) / days - energyCost(time + until));
      }
      return total;
    };
    const apply = (e, c, draw) => {
      const options = outcomes(e, c);
      if (!options.length) throw Error('Ineligible career card.');
      let remaining = draw;
      for (const o of options) { remaining -= o.p; if (remaining < 0) return o.employee; }
      return options[options.length - 1].employee;
    };
    const rules = {
      metrics: () => ({ projections, pools }),
      retirement: () => horizon,
      next: (e, time) => { const r = rate(e); return r > 0 ? time + 1 / r : Infinity; },
      energyCost,
      advance: (e, from, to) => {
        const m = stepMemo(e), k = to - from;
        if (!m.has(k)) m.set(k, k ? project(e, k) : 0);
        return { employee: { ...shifted(e, k), elapsed: to }, profit: m.get(k) };
      },
      // Train when an ordinary hand's typical best card pays for the energy.
      shouldTrain: (e, time, cost) => reference(e) > cost,
      hand: (e, rand) => {
        const p = pool(e), open = odds(e);
        if (!open.length) return [];
        let roll = rand(0), rarity = open[open.length - 1].rarity;
        for (const o of open) { roll -= o.p; if (roll < 0) { rarity = o.rarity; break; } }
        const cards = [...p[rarity]], dealt = [];
        for (let i = 0; i < EC.CFG.handSize; i++) dealt.push(cards.splice(Math.floor(rand(i + 1) * cards.length), 1)[0]);
        return dealt;
      },
      score: (e, c, time) => c.card === 'reroll' ? fresh(e) : capped(e, c) ? null
        : c.card === 'secondWind' ? windValue(e, c, time) : lasting(e, c),
      apply,
    };
    const employee = { ...subject, trainingBaseLuck: subject.luck, elapsed: 0 };
    const arms = [{ slot: null, card: null }], skipped = [];
    hand.forEach((card, slot) => {
      const ok = card && (card.card === 'reroll' || (!capped(employee, card) && outcomes(employee, card).length));
      (ok ? arms : skipped).push(ok ? { slot, card } : slot);
    });
    return { employee, arms, skipped, seed, start, count, rules, horizon };
  }

  return { careerOptions, TOOL_TYPES, CHURN, returnsTool, evaluate, recommend, cardSession, retentionSession, CARD_PLAN_CAP };
})();
if (typeof module !== 'undefined') module.exports = EmployeePlanner;
