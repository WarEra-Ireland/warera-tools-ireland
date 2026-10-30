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
    const frozen = e => !!companies.get(e.company)?.excluded;
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
      if (e.equipped && (a.company !== e.company || a.tool !== e.equipped.id)) errors.push(`Keep ${e.name}'s equipped tool and company unchanged.`);
      if (!a.tool) continue;
      const t = s.tools.find(t => t.id === a.tool);
      if (!t || used.has(a.tool) || (t.holder && t.holder !== e.id) || (!t.holder && !compatible(t, c))) errors.push('A tool must have one eligible employee.');
      used.add(a.tool);
    }
    for (const c of s.companies) if (arrangement.filter(a => a.company === c.id).length > c.capacity) errors.push(`${c.name} exceeds its Break Room capacity.`);
    return errors;
  }

  // The training callbacks supply the shared trait rules. Helpers collect
  // physical effects here, rather than converting each effect into money.
  // Algebraic/team effects whose callbacks value money need explicit handling.
  function effects(e, company, roster, hour, tool) {
    const moved = e.company !== company.id;
    const others = roster.filter(x => x.id !== e.id);
    // Tenure is continuous: Veteran, Diamond and Burnout switch at the exact
    // hour, which projectCompany adds as a boundary. Age, for Early Bloomer,
    // Late Bloomer and Worn Out, steps at the daily boundaries.
    const tenure = (moved ? 0 : e.tenure) + hour / 24 + EPS;
    const fx = { production: 0, responsibility: 0, bonus: 0, happiness: [], teamHappiness: [], teamProduction: 0, teamResponsibility: 0 };
    const add = (key, n) => { fx[key] += n; return 0; };
    const happy = n => { fx.happiness.push(n); return 0; };
    const s = {
      coworkers: others.length, femaleCoworkers: others.filter(x => x.gender === 'female').length,
      otherNationalities: new Set(others.map(x => x.nationality).filter(n => n !== e.nationality)).size,
      strongerCoworker: others.some(x => x.production > e.production), weakerCoworker: others.some(x => x.production < e.production),
      betterPaid: others.filter(x => wageAt(x, hour) > wageAt(e, hour) + 1e-9).length,
      place: company.country !== e.nationality ? 'abroad' : company.coreCountry === e.nationality ? 'homeCore' : 'home',
      itemType: company.type, product: company.product, incomeTax: company.tax,
      smallStorage: company.storage <= 2, storageFull: company.full, hasTool: !!tool,
    };
    const x = {
      s, e, age: e.age + Math.floor(hour / 24), tenure, held: true, loss: 0, male: others.length - s.femaleCoworkers,
      prod: n => add('production', n), pct: n => add('bonus', n), happy,
      resp: n => add('responsibility', n), luck: () => 0, boxes: () => 0, wage: () => 0,
      teamHappy: n => { fx.teamHappiness.push(n); return 0; },
      teamProd: n => add('teamProduction', n), teamResp: n => add('teamResponsibility', n), quickStudy: 0,
    };
    x.stat = (stat, n) => stat === 'production' ? x.prod(n) : stat === 'responsibility' ? x.resp(n) : 0;
    for (const t of e.traits) {
      if (['loyal', 'stockpiler', 'anchor', 'climber', 'luckyCharm', 'jinx'].includes(t.code)) continue;
      if (t.code === 'creatureOfHabit') {
        if ((moved ? hour : hour + e.moveAgeHours) < 72 - 1e-6) fx.bonus -= 30;
      } else if (EC.TRAIT[t.code]?.partner) {
        if (others.some(o => o.id === t.arg)) EC.TRAIT[t.code].hourly({ ...x, arg: t.arg });
      } else EC.TRAIT[t.code]?.hourly?.({ ...x, arg: t.arg });
    }
    return fx;
  }

  function instant(s, company, members, hour) {
    const roster = members.filter(({ e }) => hour < (EC.CFG.retireAge - e.age) * 24).map(({ e }) => e);
    const rows = members.filter(({ e }) => roster.includes(e)).map(({ e, tool }) => {
      const activeTool = tool && hour < tool.hours && compatible(tool, company) ? tool : null;
      return { e, tool: activeTool, fx: effects(e, company, roster, hour, activeTool) };
    });
    return rows.map(({ e, tool, fx }) => {
      const day = Math.floor(hour / 24);
      for (const other of rows) {
        if (other.e.id === e.id) continue;
        fx.happiness.push(...other.fx.teamHappiness);
        // Mentor: "Every coworker weaker than them gets +2" (paid Production).
        if (other.e.production > e.production) fx.production += other.fx.teamProduction;
        fx.responsibility += other.fx.teamResponsibility;
      }
      const production = Math.max(1, e.production + fx.production);
      const responsibility = Math.max(1, e.responsibility + fx.responsibility);
      const happiness = [...fx.happiness, -company.tax];
      if (company.full && !has(e, 'stockpiler')) happiness.push(-10);
      for (const h of e.happiness) if (hour < h.hours) happiness.push(h.delta);
      // Responsibility adds 3 happiness a point; Loyal halves every loss.
      const lossFactor = has(e, 'loyal') ? 0.5 : 1;
      const mood = clamp(50 + EC.CFG.respHappiness * responsibility + happiness.reduce((v, h) => v + h * (h < 0 ? lossFactor : 1), 0), 0, 100);
      const saved = e.specializations[company.product] || 0;
      const specialization = Math.min(20, saved + day * (has(e, 'quickStudy') ? 2 : 1));
      const anchor = has(e, 'anchor') && mood < 30 ? -50 : 0;
      const bonus = company.bonus + fx.bonus + specialization + mood - 50 + (tool?.bonus || 0) + anchor;
      const output = production / 4 * Math.max(0, 1 + bonus / 100);
      // Current pay already includes Greedy, Modest and past Climber raises.
      const wage = wageAt(e, hour);
      return { id: e.id, company: company.id, tool: tool?.id || null, production, responsibility, happiness: mood, specialization, bonus,
        parts: { company: company.bonus, traits: fx.bonus + anchor, specialization, happiness: mood - 50, tool: tool?.bonus || 0, traitProduction: production - e.production },
        output, wage, profit: output * company.margin - wage };
    });
  }

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

  function projectCompany(s, company, members) {
    const end = s.days * 24;
    const boundaries = new Set([0, end]);
    for (let h = 24; h < end; h += 24) boundaries.add(h);
    for (const { e, tool } of members) {
      const moved = e.company !== company.id;
      for (const h of [tool?.hours, (EC.CFG.retireAge - e.age) * 24, ...e.happiness.map(x => x.hours), ...traitHours(e, moved, end)]) {
        if (h > 0 && h < end) boundaries.add(h);
      }
    }
    const hours = [...boundaries].sort((a, b) => a - b), totals = new Map(members.map(({ e }) => [e.id, 0]));
    const minHappiness = new Map(members.map(({ e }) => [e.id, 100]));
    const daily = new Array(s.days).fill(0);
    let value = 0;
    for (let i = 0; i < hours.length - 1; i++) {
      const rows = instant(s, company, members, hours[i]);
      for (const row of rows) {
        const gain = row.profit * (hours[i + 1] - hours[i]);
        value += gain; daily[Math.floor(hours[i] / 24)] += gain; totals.set(row.id, totals.get(row.id) + gain);
        minHappiness.set(row.id, Math.min(minHappiness.get(row.id), row.happiness));
      }
    }
    return { value, daily, employees: instant(s, company, members, 0).map(r => ({ ...r, value: totals.get(r.id), minHappiness: minHappiness.get(r.id) })) };
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

  function evaluate(snapshot, arrangement = initial(snapshot)) {
    const errors = validate(snapshot, arrangement);
    if (errors.length) return { valid: false, errors };
    const assign = new Map(arrangement.map(a => [a.employee, a]));
    return { valid: true, ...totals(snapshot, projector(snapshot), assign), arrangement, excluded: excludedList(snapshot) };
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

  /* Best-improvement local search over moves, direct swaps and tool changes.
   * Every round scores each employee's options, interleaved so a budget cut
   * falls evenly on the workforce, and accepts the single best change. Ties
   * break on a canonical key, so input order does not change the result.
   * Identical available tools (same type, bonus and hours) are one option. */
  function recommend(snapshot, { maxProjections = 60000, allowMoves = true, onProgress = null } = {}) {
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
    const manual = s.tools.filter(t => !t.holder && t.hours > 0).sort(byId);
    const classOf = t => t ? `${t.type}|${t.bonus}|${t.hours}` : '-';
    const classes = [...new Set(manual.map(classOf))].sort();
    const sample = new Map(manual.map(t => [classOf(t), t]));
    const holder = new Map([...assign].filter(([, a]) => a.tool).map(([id, a]) => [a.tool, id]));
    const freeUnit = key => manual.find(t => classOf(t) === key && !holder.has(t.id)) || null;
    const roster = new Map(planned.map(c => [c.id, people.filter(e => e.company === c.id).map(e => e.id)]));
    const value = new Map(planned.map(c => [c.id, P.project(c, roster.get(c.id).map(id => ({ e: employees.get(id), tool: tools.get(assign.get(id).tool) }))).value]));
    const baseline = totals(s, P, assign);
    const steps = [], moved = new Set();
    const movable = e => allowMoves && !e.equipped && !e.locked && !moved.has(e.id);
    const search = { rounds: 0, candidates: 0, projections: 0, maxProjections, limited: false, stopped: 'converged' };

    const toolFor = (tool, company) => tool && compatible(tool, company) ? tool.id : null;
    function candidatesFor(e, partners) {
      const a = assign.get(e.id), here = companies.get(a.company), cur = tools.get(a.tool) || null, out = [];
      const add = (changes, key, step = null) => out.push({ changes, key, step });
      if (!e.equipped) {
        if (cur) add([[e.id, here.id, null]], `t:${e.id}:-`);
        for (const k of classes) {
          if (k === classOf(cur) || !compatible(sample.get(k), here)) continue;
          const unit = freeUnit(k);
          if (unit) { add([[e.id, here.id, unit.id]], `t:${e.id}:${k}`); continue; }
          // All units of this class are in use: exchange with each holder.
          for (const t of manual) {
            const other = holder.get(t.id);
            if (classOf(t) !== k || !other || employees.get(other).equipped) continue;
            const there = companies.get(assign.get(other).company);
            add([[e.id, here.id, t.id], [other, there.id, toolFor(cur, there)]], `t:${e.id}:${k}:${other}`);
          }
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
      const warnings = [];
      for (const r of proposed.employees) {
        const e = employees.get(r.id);
        if (!has(e, 'anchor') && r.minHappiness < (has(e, 'flightRisk') ? 50 : 30)) warnings.push(`${e.name}'s projected happiness reaches ${r.minHappiness.toFixed(1)} and they may quit.`);
      }
      return { valid: true, partial, baseline, proposed, gain: proposed.value - baseline.value,
        arrangement: s.employees.map(e => ({ employee: e.id, ...assign.get(e.id) })), steps: [...steps], warnings,
        unused: manual.filter(t => !holder.has(t.id)).map(t => t.id), excluded: excludedList(s),
        search: { ...search, projections: P.misses } };
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
      if (!best) return result(false);
      apply(best);
      if (search.limited) return result(false);
      onProgress?.(result(true));
    }
    search.limited = true; search.stopped = 'rounds';
    return result(false);
  }
  // Canonical one-change neighbourhood. Tools stay equipped; inventory is
  // deliberately absent. Coworker plans still apply when the subject is pinned.
  const CARD_PLAN_CAP = 256;
  const CARD_CACHE_CAP = 20000;
  function localPlans(s, subject, allowMoves) {
    const companies = s.companies.filter(c => !c.excluded).sort(byId);
    const people = s.employees.filter(e => companies.some(c => c.id === e.company)).sort(byId);
    const movable = e => allowMoves && !e.locked && !e.equipped;
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
    const s = { ...prepared, days: horizon };
    const errors = validate(s, initial(s));
    const subjects = new Map(), cache = new Map();
    const companies = s.companies.filter(c => !c.excluded).sort(byId);
    const tools = new Map(s.tools.map(t => [t.id, t]));
    const fingerprint = e => JSON.stringify([e.id, e.traits.filter(t => !['luckyCharm', 'jinx', 'recruiter', 'trainer'].includes(t.code)),
      e.production, e.responsibility, e.wage, e.climberRaise]);
    function price(subjectId, cards, { budget = 80000, employee = {}, context = {}, feed = false } = {}) {
      const subject = s.employees.find(e => e.id === subjectId);
      const reason = errors[0] || !subject && 'Employee is not in this workforce.'
        || s.companies.find(c => c.id === subject?.company)?.excluded
        || context.toolboxValue && 'Toolbox value requires current-company pricing.';
      if (reason) return { valid: false, basis: 'current-company', reason };
      let used = 0;
      const ctx = { ...context, ppValue: snapshot.ppValue || 1, situation: { ...context.situation,
        gender: subject.gender, product: companies.find(c => c.id === subject.company).product } };
      const e = { ...EC.DEFAULT_EMPLOYEE, ...employee, ...subject,
        wageExpectation: employee.wageExpectation ?? subject.wage / (subject.production / 4 * (snapshot.ppValue || 1)) };
      let state = subjects.get(subjectId);
      if (!state) {
        const menu = localPlans(s, subject, snapshot.allowMoves !== false);
        state = { ...menu, best: null, quotes: new Map() }; subjects.set(subjectId, state);
      }
      const project = (variant, plan) => {
        const changed = new Map(plan.changes);
        const groups = companies.map(c => {
          const members = s.employees.filter(x => (changed.get(x.id) || x.company) === c.id)
            .map(x => ({ e: x.id === subjectId ? variant : x, tool: tools.get(x.equipped?.id) })).sort((a, b) => byId(a.e, b.e));
          const key = c.id + ':' + members.map(m => fingerprint(m.e)).join('|');
          if (!cache.has(key)) {
            if (++used > budget) throw new Error('Projection budget reached.');
            if (cache.size >= CARD_CACHE_CAP) cache.delete(cache.keys().next().value);
            cache.set(key, projectCompany(s, c, members));
          }
          return cache.get(key);
        });
        return { value: groups.reduce((v, g) => v + g.value, 0), rows: groups.flatMap(g => g.employees) };
      };
      const best = (variant, plans = state.plans) => {
        const stay = project(variant, state.plans[0]);
        let result = { ...stay, plan: state.plans[0] };
        for (const plan of plans) {
          if (plan.kind === 'stay') continue;
          const p = project(variant, plan);
          const unsafe = p.rows.some(row => {
            const who = s.employees.find(x => x.id === row.id);
            const threshold = has(who.id === subjectId ? variant : who, 'flightRisk') ? 50 : 30;
            return !has(who.id === subjectId ? variant : who, 'anchor') && row.minHappiness < threshold
              && stay.rows.find(x => x.id === row.id)?.minHappiness >= threshold;
          });
          if (!unsafe && p.value > result.value + EPS) result = { ...p, plan };
        }
        return result;
      };
      const explain = plan => ({ ...plan, description: plan.kind === 'stay' ? 'stay in current arrangement'
        : `${plan.kind}: ${plan.changes.map(([id, co]) => `${s.employees.find(x => x.id === id).name} to ${s.companies.find(c => c.id === co).name} (${s.companies.find(c => c.id === co).product})`).join('; ')}` });
      try {
        state.best ||= best(e);
        const baselineStay = project(e, state.plans[0]).value;
        const quote = c => {
          const key = JSON.stringify([c, employee, context, feed]);
          if (state.quotes.has(key)) return state.quotes.get(key);
          let q;
          if (c.card === 'secondWind') {
            const numeric = x => x.card === 'secondWind' ? 0 : quote(x).value;
            q = { value: EC.secondWindValue(e, c, ctx, 1, numeric), stay: EC.secondWindValue(e, c, ctx, 1,
              x => x.card === 'secondWind' ? 0 : quote(x).stay), outcomes: [], plan: explain(state.best.plan), forecast: true };
          } else {
            const codes = c.card === 'rehabAll' ? e.traits.filter(t => EC.TRAIT[t.code]?.polarity === 'negative').map(t => t.code)
              : c.card === 'mentoring' ? [c.code, c.to] : c.codes || [c.code].filter(Boolean);
            const unpriced = codes.find(code => !EC.TRAIT[code] || EC.TRAIT[code].unpriced
              || EC.TRAIT[code].partner && !e.traits.some(t => t.code === code));
            if (unpriced || c.card === 'rehab' && EC.TRAIT[c.code]?.polarity !== 'negative' || c.card === 'negotiation' && !EC.canNegotiate(e, c)) {
              q = { value: null, stay: null, outcomes: [], note: unpriced && !EC.TRAIT[unpriced] ? 'Trait not known to this tool.' : EC.TRAIT[unpriced]?.unpriced || (EC.TRAIT[unpriced]?.partner ? 'Linked employee is unknown; this trait is not a Habit outcome.' : 'Card is not available.'), plan: explain(state.plans[0]) };
            } else {
              let plans = state.plans;
              if (feed && c.card === 'habitPair') {
                const singles = c.codes.flatMap(code => {
                  const q = quote({ card: 'habit', code });
                  return q.outcomes.length ? q.outcomes.map(o => o.plan) : [q.plan];
                });
                plans = [...new Map([state.plans[0], state.best.plan, ...singles].map(p => [p.key, p])).values()];
              }
              const outcomes = EC.cardOutcomes(e, c, ctx).map(o => {
                const b = best(o.employee, plans);
                return { p: o.p, arg: o.arg, value: (b.value - state.best.value) / ctx.ppValue,
                  stay: (project(o.employee, state.plans[0]).value - baselineStay) / ctx.ppValue, plan: explain(b.plan) };
              });
              const mean = k => outcomes.reduce((v, o) => v + o.p * o[k], 0);
              q = { value: mean('value'), stay: mean('stay'), outcomes: outcomes.length > 1 ? outcomes : [],
                plan: outcomes[0]?.plan || explain(state.plans[0]), coverage: feed && c.card === 'habitPair' ? 'restricted-pair' : 'full-menu',
                note: c.card === 'wildCard' ? 'Unpriced non-output effects count as zero.' : null };
            }
          }
          state.quotes.set(key, q); return q;
        };
        const quotes = cards.map(quote);
        return { valid: true, basis: 'rearranged', horizon, quotes, baseline: explain(state.best.plan),
          coverage: { tested: state.plans.length, total: state.total }, projections: used,
          warnings: state.best.rows.filter(r => r.minHappiness < 30).map(r => `${r.id} is already below 30 happiness.`) };
      } catch (error) { return { valid: false, basis: 'current-company', reason: error.message }; }
    }
    return { valid: !errors.length, horizon, price };
  }
  return { TOOL_TYPES, evaluate, recommend, cardSession, CARD_PLAN_CAP };
})();
if (typeof module !== 'undefined') module.exports = EmployeePlanner;
