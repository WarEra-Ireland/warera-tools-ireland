/* Complete-roster projections. Money is in game currency; percentage bonuses
 * are percentage points. Training valuations remain in EmployeeCore. */
const EmployeePlanner = (() => {
  const EC = typeof module !== 'undefined' ? require('./employee-core.js') : EmployeeCore;
  const has = (e, code) => e.traits.some(t => t.code === code);
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  // The tool types and the goods each fits are the module's (TOOL_TYPES).
  let toolOf = null;
  const TOOL_OF = () => toolOf ||= Object.fromEntries(Object.entries(MODEL.TOOL_TYPES).flatMap(([type, goods]) => goods.map(g => [g, type])));
  const compatible = (tool, company) => TOOL_OF()[company.product] === tool.type;
  // A move into a company the held tool does not fit sends it back to
  // inventory, where it is a spare for anyone else in the plan.
  const returnsTool = (e, a, tools, companies) => {
    const t = e.equipped && tools.find(t => t.id === e.equipped.id), c = companies.find(c => c.id === a.company);
    return t && c && a.company !== e.company && a.tool !== t.id && !compatible(t, c) ? t : null;
  };
  const initial = s => s.employees.map(e => ({ employee: e.id, company: e.company, tool: e.equipped?.id || null }));

  /* --- The employee model (wasm/src) ---
   * Projections, the planner's search, card pricing and the input checks
   * run in the crate. A snapshot goes over once per call or session: the
   * module decodes it into its own records, a `Snapshot` handle that every
   * module call of that call or session takes, freed when it ends. A
   * snapshot changed in place afterwards is read anew by the next call. */
  const MODEL = typeof EmployeeModel !== 'undefined' ? EmployeeModel : require('./employee-model.js');
  const api = () => {
    if (!MODEL?.api) throw Error('The employee model is not ready: wait for EmployeeModel.ready.');
    return MODEL.api;
  };
  // `s` decoded by the module; free() it when done.
  const decode = s => new (api().Snapshot)(s);
  // f(handle) over `s` decoded, freed afterwards.
  const decoded = (s, f) => {
    const h = decode(s);
    try { return f(h); } finally { h.free(); }
  };

  // --- Input checks (check::validate in the module), as text ---
  // By problem kind; `i` is the place in the snapshot the problem names.
  const VALIDATE_TEXT = {
    companyIds: () => 'Companies must have unique IDs.', employeeIds: () => 'Employees must have unique IDs.', toolIds: () => 'Tools must have unique IDs.',
    days: () => 'Choose a planning period from 1 to 47 whole days.',
    companyData: (s, i) => `Missing company data for ${s.companies[i].name}.`,
    employeeMissing: (s, i) => `Missing employee data for ${s.employees[i].name}.`,
    employeeData: (s, i) => `Missing employee data for ${s.employees[i].name}.`,
    climberRaise: (s, i) => `Missing weekly wage increase for ${s.employees[i].name}.`,
    toolData: (s, i) => `Invalid bonus or working hours for ${s.tools[i].name}.`,
    assignOnce: () => 'Assign each employee exactly once.', unknown: () => 'Unknown employee or company.',
    notPlanned: (s, i) => `${s.companies[i].name} is not being planned, so its roster and tools stay unchanged.`,
    locked: (s, i) => `${s.employees[i].name} is kept in their current company.`,
    tool: () => 'A tool must have one eligible employee.',
    capacity: (s, i) => `${s.companies[i].name} exceeds its Break Room capacity.`,
    disabled: (s, i) => `${s.companies[i].name} is disabled, so nobody is moved into it except in a swap.`,
  };
  // The snapshot's input errors under an arrangement, as text; `h` is `s` decoded.
  const check = (s, h, arrangement = initial(s)) => api().validate(h, arrangement).map(p => VALIDATE_TEXT[p.kind](s, p.place));
  // Effects the planner cannot reproduce (check::uncertainty): employee place → reason.
  const UNCERTAIN_TEXT = {
    hidden: () => 'has a hidden trait',
    unknown: t => `has a trait the planner does not know (${t.code})`,
    missingArgument: t => `has ${EC.TRAIT[t.code].name} without its stat or partner`,
  };
  const uncertainties = (s, h) => new Map(api().uncertainty(h).map(u => [u.employee, UNCERTAIN_TEXT[u.kind](s.employees[u.employee].traits[u.trait])]));

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
  // Who may quit (check::may_quit) of rows { id, minHappiness }, as text;
  // `h` is `s` decoded.
  function riskWarnings(s, rows, h) {
    const at = new Map(s.employees.map((e, i) => [e.id, i]));
    return Array.from(api().quitRisks(h, rows), k => {
      const r = rows[k];
      return `${s.employees[at.get(r.id)].name}'s projected happiness reaches ${r.minHappiness.toFixed(1)} and they may quit. Earnings assume they stay.`;
    });
  }

  function evaluate(snapshot, arrangement = initial(snapshot)) {
    return decoded(snapshot, h => {
      const errors = check(snapshot, h, arrangement);
      if (errors.length) return { valid: false, errors };
      const result = api().evaluate(h, arrangement);
      return { valid: true, ...result, warnings: riskWarnings(snapshot, result.employees, h), coverage: coverage(snapshot), arrangement, excluded: excludedList(snapshot) };
    });
  }

  // Companies whose roster cannot be reproduced are frozen: membership and
  // tools stay as they are, and their profit is left out of every total.
  // Who the planner can't reproduce (check::uncertainty) and the stat check
  // (rebuilt hour-0 rows against the game's,
  // planner::Env::observed_mismatches) run in the module; a company keeps
  // the first reason found. `h` is `snapshot` decoded: returns the snapshot
  // with the exclusions (`s`) and its handle (`h`, to free).
  function exclusions(snapshot, h) {
    const reasons = new Map(snapshot.companies.filter(c => c.excluded).map(c => [c.id, [c.excluded]]));
    const note = (id, reason) => reasons.set(id, [...(reasons.get(id) || []), reason]);
    const why = uncertainties(snapshot, h);
    snapshot.employees.forEach((e, i) => {
      if (!reasons.has(e.company) && why.has(i)) note(e.company, `${e.name} ${why.get(i)}.`);
    });
    const skip = Uint32Array.from(snapshot.companies.flatMap((c, i) => reasons.has(c.id) ? [i] : []));
    for (const m of api().observedMismatches(h, skip)) {
      note(snapshot.companies[m.company].id, `${snapshot.employees[m.employee].name}'s rebuilt stats or bonuses differ from the game, so an unmodelled effect may be present.`);
    }
    const s = { ...snapshot, companies: snapshot.companies.map(c => reasons.has(c.id) ? { ...c, excluded: reasons.get(c.id).join(' ') } : c) };
    return { s, h: h.exclude(Uint32Array.from(s.companies.flatMap((c, i) => c.excluded ? [i] : []))) };
  }
  function withExclusions(snapshot) {
    const { s, h } = decoded(snapshot, h => exclusions(snapshot, h));
    h.free();
    return s;
  }

  // What keeping employee `id` earns in their company and what their leaving
  // costs the rest: the same company's complete career with and without
  // them, `price(place)` (the module's projections). This shares retirement,
  // tool expiry, happiness and trait rules with assignments. `h` is `s`
  // decoded with its exclusions; `errors` its input checks.
  function retained(s, h, errors, id, price) {
    const e = s.employees.find(e => e.id === id);
    const company = s.companies.find(c => c.id === e?.company);
    const reason = errors[0] || !e && 'Employee not loaded.' || company?.excluded;
    if (reason) return { valid: false, reason };
    const { value, own, with: kept, without: left } = price(s.employees.indexOf(e));
    const rows = list => list.map(r => ({ id: s.employees[r.employee].id, minHappiness: r.minHappiness }));
    const baseline = rows(kept), without = rows(left);
    const members = s.employees.filter(x => x.company === company.id);
    return { valid: true, value, own, coworkers: value - own, warnings: [...new Set([...riskWarnings(s, baseline, h), ...riskWarnings(s, without, h)])], coverage: coverage(s),
      unpriced: [...new Set(members.flatMap(e => e.traits.filter(t => EC.TRAIT[t.code]?.unpriced && !(t.code === 'trainer' && s.trainingQuota) && !(t.code === 'recruiter' && company.recruitmentValues)).map(t => t.code)))] };
  }
  // Compare the same company's complete career with and without one employee
  // (pricing::Retention).
  function retentionSession(snapshot) {
    const { s, h } = decoded(snapshot, h => exclusions(snapshot, h));
    const errors = check(s, h);
    const session = new (api().RetentionSession)(h);
    return { price: id => retained(s, h, errors, id, i => session.price(i)), free: () => { session.free(); h.free(); } };
  }

  // The keep step (Keep or replace), recruiting and the employees' models
  // over a snapshot with its ppValue, in the module (wasm/src/keep.rs):
  //   model(id, { energyValue, coworkers })  the employee in their company
  //                   as the rules read them: { employee, context }, each
  //                   coworker a model in their own context unless
  //                   `coworkers` is false
  //   retention(id)   retentionSession's price
  //   prepare(id)     a generator: builds what row(id) reads, a step at a time
  //   row(id, feed)   keeping them against a fresh hire in their slot, in PP;
  //                   feed { alt, trainingValue, energyValue }; its
  //                   coworkers by name: leave.retires (who retires the
  //                   day before firing them later pays) and harm
  //                   [{ name, trait }] (the traits they hold back)
  // and in a company (by id), with all its employees or all but `without`:
  //   freshSet(company, { alt, slots, without })  { best, gross, days, rate,
  //                   average, coworkers, beat(bar) }
  //   impact(company, newcomer, without)  what a newcomer { nationality,
  //                   gender, production, wage } does to the coworkers'
  //                   traits: { value, notes: [{ name, trait }] }
  //   candidate(company, newcomer, cand, alt)  a typed candidate who is the
  //                   newcomer (candidateValue's, with `place`)
  function keepSession(snapshot) {
    const { s, h } = decoded(snapshot, h => exclusions(snapshot, h));
    let session;
    try { session = new (api().KeepSession)(h); } catch (error) { h.free(); throw error; }
    const errors = check(s, h);
    const place = new Map(s.employees.map((e, i) => [e.id, i]));
    const companyPlace = new Map(s.companies.map((c, i) => [c.id, i]));
    const roster = (company, without = null) => ({ company: companyPlace.get(company), without: without == null ? null : place.get(without) });
    const retentions = new Map();
    function retention(id) {
      if (!retentions.has(id)) retentions.set(id, retained(s, h, errors, id, i => session.retention(i)));
      return retentions.get(id);
    }
    function* prepare(id) {
      const i = place.get(id);
      while (!session.prepare(i)) yield;
    }
    function freshSet(company, { alt, slots, without = null } = {}) {
      const set = session.freshSet(roster(company, without), { alt, slots });
      const out = set.summary();
      out.beat = bar => set.beat(bar);
      return out;
    }
    function impact(company, newcomer, without = null) {
      const { value, notes } = session.impact(roster(company, without), newcomer);
      return { value, notes: notes.map(n => ({ name: s.employees[n.employee].name, trait: n.trait })) };
    }
    function candidate(company, newcomer, cand, alt) {
      const { value, place: where } = session.candidate(roster(company), newcomer, cand, { alt });
      return { ...value, place: where };
    }
    function model(id, options) {
      if (!place.has(id)) throw Error('Employee is not in this workforce.');
      return session.model(place.get(id), options);
    }
    function row(id, feed) {
      const r = session.row(place.get(id), feed);
      const name = i => i == null ? null : s.employees[i].name;
      return { ...r, leave: r.leave ? { ...r.leave, retires: name(r.leave.retires) } : null, harm: r.harm.map(x => ({ name: name(x.employee), trait: x.trait })) };
    }
    return { model, retention, prepare, row, freshSet, impact, candidate,
      free: () => { session.free(); h.free(); } };
  }

  /* Minimum gain. Prices are recent trades held flat for the horizon, so a
   * gain that hinges on them, or one too small to be worth the effort of
   * making it, is not recommended.
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
  // CHURN is the module's (planner::churn), read once it is ready: EmployeeModel.CHURN.

  /* Product switches. recommend searches
   * a change kind { company, product } with the moves, swaps and tool changes
   * when given `switches` (an option, or the snapshot's), plain data so it
   * can cross to the worker:
   *   market        { list: [{ code, perPP }], gameMargin, types } (the
   *                 Training page's market)
   *   concretePrice unit price of concrete, for the switch cost
   *   changeItemCost concrete a switch takes (gameConfig; default 5)
   *   regions       { companyId: { country, region } } raw API records, for
   *                 the regional bonus (needs computeProductionBonus)
   * Every company is a candidate on every other good with a live margin,
   * item type and tool type, re-tooled from its record; how the switches
   * are scored, bounded and pruned is in wasm/src/planner.rs. A change with
   * a switch is taken only if it gains at the worse of today's prices and
   * the game's average margins, after the churn floor. */
  const SWITCH_NOTE = "Product switches: every company is compared on every good with a market price, with the moves, swaps and tool changes that go with re-tooling it. A company is re-tooled only if the plan still gains at the worse of today's prices and the game's average margins, after the minimum gain, and the switch's concrete is paid at the start. Saved specialisation is kept per good; tools that don't fit the new good go back to inventory.";
  const SWITCH_CUT_NOTE = 'The projection budget ran out before every product switch was compared, so a better switch may exist.';

  /* The two price sets, built once per load: `live` from the market list
   * (order-book margin after inputs, market.list[].perPP) and `game`
   * from EmployeeCore.gameMargins (the game's slow multi-day average). Both
   * are { code: money per PP }. worse(code) is the lower of the two, or the
   * one known; spike(code) flags a live margin far above the game's;
   * ratio(code) is live / game, or null without both. */
  function priceSets({ list = [], gameMargin = {} } = {}, spikeRatio = MODEL.SPIKE_RATIO) {
    const { live, game, codes } = api().priceSets({ list, gameMargin, spikeRatio });
    const rows = new Map(codes.map(r => [r.code, r]));
    const worse = code => rows.get(code)?.worse ?? null;
    const ratio = code => rows.get(code)?.ratio ?? null;
    const spike = code => rows.get(code)?.spike ?? false;
    const worseSet = Object.fromEntries(codes.map(r => [r.code, r.worse]));
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
   * toolTypeChanges, engineDaily } (engineDaily: engine PP a day). Its margin
   * is the context's for the good, or on its own good the company's; null
   * when neither is known. The same product is no switch and costs nothing.
   * The game's switching rules are in wasm/src/switch.rs. */
  function retool(company, product, ctx = {}) {
    const bonusOf = ctx.productionBonus || (typeof computeProductionBonus === 'function' ? computeProductionBonus : null);
    const regional = bonusOf && ctx.country ? bonusOf(ctx.country, ctx.region, product) : null;
    const r = api().retool({ company, product, margin: ctx.margins?.[product], type: ctx.types?.[product],
      regional: regional ? (regional.total || 0) / 100 : undefined, changeItemCost: ctx.changeItemCost, concretePrice: ctx.concretePrice });
    return { ...company, product, type: r.type ?? undefined, margin: r.margin, engineBonus: r.engineBonus, switch: r.switch };
  }
  /* The switch options as the module reads them (switch::SwitchInput): both
   * price sets, the item types, concrete, and the regional bonus of each
   * company with a region on each good (the page's computeProductionBonus).
   * `codes`: the goods a company can be re-tooled onto, best at the worse
   * price first. */
  function switchContext(opts) {
    if (!opts?.market) return null;
    const sets = priceSets(opts.market), types = opts.market.types || {};
    const live = sets.live, game = sets.game;
    const bonusOf = typeof computeProductionBonus === 'function' ? computeProductionBonus : null;
    const regional = [];
    if (bonusOf) for (const [id, place] of Object.entries(opts.regions || {})) {
      if (!place?.country) continue;
      for (const code of Object.keys(live)) {
        const r = bonusOf(place.country, place.region, code);
        if (r) regional.push({ company: id, product: code, bonus: (r.total || 0) / 100 });
      }
    }
    const input = { live, game, types, concretePrice: opts.concretePrice, changeItemCost: opts.changeItemCost, regional };
    const codes = api().switchCodes(input);
    const retooled = (c, product) => retool(c, product, { types, margins: live, concretePrice: opts.concretePrice,
      changeItemCost: opts.changeItemCost, ...(opts.regions?.[c.id] || {}) });
    // The game's margin for a company's good, or its own (live) when the
    // game has none.
    const gameMargin = c => Number.isFinite(game[c.product]) ? game[c.product] : c.margin;
    // Every other good: no shortlist.
    const products = c => codes.filter(code => code !== c.product);
    return { sets, codes, retool: retooled, gameMargin, products, input };
  }

  /* Best-improvement local search over moves, direct swaps, tool changes
   * and product switches, in the module (planner::Search, which describes
   * the method). Every round scores each employee's options and accepts
   * the single best change, by gain less price exposure among those
   * clearing the minimum gain (CHURN; `minMax` takes any gain). The module
   * runs a round per step(), so `onProgress` gets the plan after each
   * accepted change; notes, warnings and names are added here.
   * `compareOutputOnly`: afterwards, the module searches for output alone
   * with the projections left and keeps that plan if the full model scores
   * it higher (planner::output_only); this assembles the result.
   * Once no change clears the minimum gain, a round also weighs each
   * switch with a follow-up (another change at that company);
   * `followUps`: false skips those rounds. */
  function recommend(snapshot, options = {}) {
    const run = recommendRun(snapshot, options);
    try {
      let step = run.next();
      while (!step.done) step = run.next(step.value.outputOnly());
      return step.value;
    } finally { run.return(); }
  }
  /* recommend, with the output-only comparison made alongside the search
   * in another worker: `compare(terms)` hands the search's
   * outputOnlyTerms() to an outputOnlySearch of the same snapshot and
   * options and resolves to its result(), or to null, which makes the
   * comparison here instead. Resolves to recommend's result. */
  async function recommendWith(snapshot, options, compare) {
    const run = recommendRun(snapshot, options);
    try {
      let step = run.next();
      if (!step.done) {
        const search = step.value, terms = search.outputOnlyTerms();
        step = run.next(terms && ((await compare(terms)) ?? search.outputOnly()));
      }
      return step.value;
    } finally { run.return(); }
  }
  // recommend's body: yields the finished search when it needs the
  // output-only comparison, and takes what search.outputOnly() gives.
  // The module fills in the other options' defaults (planner::RecommendInput).
  function* recommendRun(snapshot, { maxProjections, allowMoves, onProgress = null, compareOutputOnly = true, minMax = !!snapshot.minMax, floorAt, switches = snapshot.switches, followUps } = {}) {
    const h = decode(snapshot);
    let h0 = null, search = null;
    try {
      let errors = check(snapshot, h);
      if (errors.length) return { valid: false, errors };
      // Exclusions compare hour-0 rows with the game's stats, so they run on
      // the snapshot as it is, before any company is re-tooled.
      const x = exclusions(snapshot, h), s0 = x.s;
      h0 = x.h;
      errors = check(s0, h0);
      if (errors.length) return { valid: false, errors };
      const sw = switchContext(switches);
      search = new (api().Recommend)(h0, { switches: sw ? sw.input : null, maxProjections, allowMoves, minMax, floorAt, followUps });
      const names = new Map(s0.companies.map(c => [c.id, c.name]));
      // A change's key as text: `t:` a tool, `m:` a move, `s:` a swap, `p:` a
      // company's good (with `|` its follow-up); a tool by its class.
      const toolById = new Map(s0.tools.map(t => [t.id, t]));
      const classOf = id => { const t = toolById.get(id); return t ? `${t.type}|${t.bonus}|${t.hours}` : '-'; };
      const keyText = k => !k ? null
        : k.kind === 'tool' ? `t:${k.employee}:${classOf(k.tool)}${k.from ? `:${k.from}` : ''}`
        : k.kind === 'move' ? `m:${k.employee}:${k.company}:${classOf(k.tool)}`
        : k.kind === 'swap' ? `s:${k.employees.join(':')}:${typeof k.tools === 'string' ? k.tools : `${k.tools.employee}:${classOf(k.tools.tool)}`}`
        : k.kind === 'product' ? `p:${k.company}:${k.product}${k.tools ? ':tools' : ''}${k.followUp ? `|${keyText(k.followUp)}` : ''}`
        : `o:${k.company}:${k.toolType}|${keyText(k.followUp)}`;
      const name = r => {
        if (r.switches) for (const w of r.switches) { w.name = names.get(w.company); w.followUp = keyText(w.followUp); }
        for (const a of r.search.accepted) a.key = keyText(a.key);
        for (const h of r.search.switchHolds || []) h.key = keyText(h.key);
        return r;
      };
      const dress = r => {
        const threshold = r.search.threshold;
        r.coverage = sw ? [...coverage(s0, threshold), SWITCH_NOTE, ...(r.search.switchSearch.cut ? [SWITCH_CUT_NOTE] : [])] : coverage(s0, threshold);
        r.warnings = riskWarnings(s0, r.proposed.employees, h0);
        r.excluded = excludedList(s0);
        return name(r);
      };
      while (search.step()) if (onProgress) onProgress(dress(search.result(true)));
      const primary = dress(search.result(false));
      const comparison = compareOutputOnly ? yield search : null;
      if (!comparison) return primary;
      const alternative = name(comparison.alternative);
      const stats = { ...primary.search, projections: primary.search.projections + alternative.search.projections + comparison.planned,
        alternativeProjections: alternative.search.projections, selectedOutputOnly: comparison.selected };
      if (!comparison.selected) return { ...primary, search: stats };
      const scored = { valid: true, ...comparison.scored, warnings: riskWarnings(s0, comparison.scored.employees, h0), coverage: coverage(s0), arrangement: alternative.arrangement, excluded: excludedList(s0) };
      return { ...primary, proposed: scored, gain: scored.value - primary.baseline.value, arrangement: alternative.arrangement,
        steps: alternative.steps, unused: alternative.unused, warnings: scored.warnings,
        ...(sw ? { switched: alternative.switched, switches: alternative.switches } : {}),
        search: { ...stats, accepted: alternative.search.accepted, switchHolds: alternative.search.switchHolds } };
    } finally {
      // Freeing a search's caches takes about as long as a round: after the
      // caller has the result (a worker ended after a run skips it).
      if (search) setTimeout(() => search.free(), 0);
      h0?.free(); h.free();
    }
  }

  /* recommend's output-only comparison, searched in another worker
   * alongside recommendWith's search (OutputOnlySearch in the module), for
   * the same snapshot and options: step() runs a round and says whether to
   * go on, settle(terms) takes the search's terms once it has finished,
   * result() gives the comparison; free() it when done. Null when
   * recommend would stop at an input error. */
  function outputOnlySearch(snapshot, { maxProjections, allowMoves, minMax = !!snapshot.minMax, floorAt, switches = snapshot.switches, followUps } = {}) {
    const h = decode(snapshot);
    let h0 = null;
    try {
      if (check(snapshot, h).length) return null;
      const x = exclusions(snapshot, h);
      h0 = x.h;
      if (check(x.s, h0).length) return null;
      const sw = switchContext(switches);
      return new (api().OutputOnlySearch)(h0, { switches: sw ? sw.input : null, maxProjections, allowMoves, minMax, floorAt, followUps });
    } finally { h0?.free(); h.free(); }
  }

  /* Each company's best switch on its own (Top
   * Products), in the module (switch::single_switches): the company
   * re-tooled alone and the whole snapshot evaluated at both price sets,
   * against the snapshot as it is, each good alone and with free fitting
   * tools for members left without one; free tools go first to the switch
   * that gains most at the worse price. `opts` is the snapshot's `switches`.
   * Returns null without options, { errors } if the snapshot doesn't
   * validate, else { days, floor, rows } with one row per company in
   * snapshot order: { id, product, verdict, to, tools and toolIds, gain:
   * { live, game } a day net of the concrete, spike, ratio, cost, concrete,
   * payback (days), excluded (reason), candidates (every good tried, best
   * worse-of-two first) }. Verdicts as EmployeeProducts: switch | spike |
   * hold | stay | off. */
  function singleSwitches(snapshot, opts = snapshot.switches) {
    const sw = switchContext(opts);
    if (!sw) return null;
    const { s: s0, h } = decoded(snapshot, h => exclusions(snapshot, h));
    try {
      const errors = check(s0, h);
      if (errors.length) return { errors };
      const out = api().singleSwitches(h, sw.input);
      out.rows.forEach((row, i) => { row.excluded = s0.companies[i].excluded || null; });
      return out;
    } finally { h.free(); }
  }

  // Why a company can't be projected on a good (switch::RetooledTotals).
  const RETOOL_TEXT = { unknownCompany: 'Unknown company.', noMargin: 'The good has no known margin, so the company cannot be planned on it.',
    notPlannable: 'The company cannot be planned on the good.' };
  /* Company `companyId` re-tooled where it stands onto `product`, as Top
   * Products tries it, and projected like `evaluate`: its employees read
   * their saved days on the good, capped, and held tools that don't fit
   * the good come off (`spares`: their ids). With `arrangement`, that
   * arrangement is projected instead of the roster as it stands.
   * `switches` as singleSwitches takes them. `company` is the company
   * re-tooled (`retool`). */
  function evaluateRetooled(snapshot, companyId, product, { switches = snapshot.switches, arrangement = null } = {}) {
    const sw = switchContext(switches);
    if (!sw) throw Error('Switch options with a market are required.');
    const place = snapshot.companies.findIndex(c => c.id === companyId);
    if (place < 0) throw Error(`Unknown company ${companyId}`);
    return decoded(snapshot, h => {
      const errors = check(snapshot, h, arrangement || initial(snapshot));
      if (errors.length) return { valid: false, errors };
      const r = api().evaluateRetooled(h, { company: place, product, switches: sw.input, arrangement });
      if (r.problem) return { valid: false, errors: [RETOOL_TEXT[r.problem]] };
      return { valid: true, ...r.totals, company: sw.retool(snapshot.companies[place], product), spares: r.spares,
        warnings: riskWarnings(snapshot, r.totals.employees, h), coverage: coverage(snapshot) };
    });
  }
  /* Card prices for the planner worker (`cards:begin`, `cards`): what a
   * card is worth with the workforce rearranged around the subject. Plans,
   * projections and quotes run in the module (wasm/src/pricing.rs, which
   * describes the method); this merges the inputs, keys the caller's
   * options and cards, and adds the plans' descriptions and the notes.
   * A session keeps its caches for its life; free() it when done. */
  const CARD_PLAN_CAP = 256;
  // By quote kind: the forecasts' notes.
  const QUOTE_NOTES = {
    reroll: 'A fresh hand, including further Rerolls, with rarity rolled again.',
    secondWind: 'Future training uses a bounded current-company estimate, net of what the energy earns elsewhere.',
    wildCard: 'Trait and stat priced apart. Unpriced non-output effects count as zero.',
  };
  // By outcome quote note; `assumptions` is the planner's coverage notes.
  const OUTCOME_NOTES = {
    anchor: "Anchor's output penalty is priced; protection against quitting is not.",
    wildCard: 'Unpriced non-output effects count as zero.',
  };
  function cardSession(snapshot) {
    const { s: prepared, h: excluded } = decoded(snapshot, h => exclusions(snapshot, h));
    let s, errors, session;
    try {
      const horizon = api().cardHorizon(prepared.employees
        .filter(e => !prepared.companies.find(c => c.id === e.company)?.excluded).map(e => EC.workingDays(e)));
      s = { ...prepared, days: horizon };
      // The session copies what it reads: the handles go once it is made.
      const h = excluded.withDays(horizon);
      try {
        errors = check(s, h);
        const unpriced = MODEL.TRAIT_RULES.flatMap((r, i) => EC.TRAIT[r.code]?.unpriced ? [i] : []);
        session = new (api().CardSession)(h, snapshot.allowMoves !== false, Uint8Array.from(unpriced));
      } finally { h.free(); }
    } finally { excluded.free(); }
    const horizon = s.days;
    const companies = s.companies.filter(c => !c.excluded).sort(byId);
    const tools = new Map(s.tools.map(t => [t.id, t]));
    const toolAt = new Map(s.tools.map((t, i) => [t.id, i]));
    const people = Array.from(session.people(), i => s.employees[i]);
    // Plans as the module numbers them: by state, then index.
    const plans = new Map();
    let notes = null;
    // `budget`: projections the price may run (the module's default 80,000).
    function price(subjectId, cards, { budget, employee = {}, context = {}, feed = false, assigned = {} } = {}) {
      const subject = s.employees.find(e => e.id === subjectId);
      const reason = errors[0] || !subject && 'Employee is not in this workforce.'
        || s.companies.find(c => c.id === subject?.company)?.excluded;
      if (reason) return { valid: false, basis: 'current-company', reason };
      const ctx = { ...context, ppValue: snapshot.ppValue || 1, situation: { ...context.situation,
        gender: subject.gender, product: companies.find(c => c.id === subject.company).product } };
      // The subject's record carries timed happiness events; the rules read
      // today's happiness, unknown unless the options give it. The module
      // fills in the defaults.
      const e = { ...employee, ...subject, happiness: employee.happiness ?? null,
        wageExpectation: employee.wageExpectation ?? api().wageExpectation(subject.wage, EC.paidProduction(subject), snapshot.ppValue || 1) };
      const forecastEmployee = { ...e, luck: employee.luck ?? e.luck };
      const toolOf = x => tools.get(Object.hasOwn(assigned, x.id) ? assigned[x.id] : x.equipped?.id) || null;
      const out = session.price({ subject: s.employees.indexOf(subject), tools: s.employees.map(x => { const t = toolOf(x); return t ? toolAt.get(t.id) : null; }),
        budget, feed, employee: e, forecastEmployee, context: ctx, cards });
      if (out.failure) return { valid: false, basis: 'current-company', reason: out.failure };
      const { state } = out;
      const nameOf = id => s.employees.find(x => x.id === id).name;
      // A state's plan, as the JS objects were: { key, kind, changes,
      // equipment, description }.
      const explain = i => {
        let byState = plans.get(state);
        if (!byState) plans.set(state, byState = new Map());
        let plan = byState.get(i);
        if (plan) return plan;
        const { kind, ...d } = session.plan(state, i);
        const changes = d.changes.map(m => [s.employees[m.employee].id, s.companies[m.company].id]);
        const equipment = Object.fromEntries(people.map((x, j) => [x.id, d.equipment[j] != null ? s.tools[d.equipment[j]].id : null]));
        plan = { key: JSON.stringify([changes, equipment]), kind, changes, equipment, description: kind === 'stay' ? 'stay in current arrangement'
          : kind === 'tool' ? `reassign tools: ${Object.entries(equipment).filter(([id, tool]) => tool !== (toolOf(s.employees.find(x => x.id === id))?.id || null)).map(([id, tool]) => `${nameOf(id)} ${tool ? `gets ${tools.get(tool).name}` : 'has no tool'}`).join('; ')}`
          : `${kind}: ${changes.map(([id, co]) => `${s.employees.find(x => x.id === id).name} to ${s.companies.find(c => c.id === co).name} (${s.companies.find(c => c.id === co).product})`).join('; ')}` };
        byState.set(i, plan);
        return plan;
      };
      const quoteOf = q => {
        if (q.kind === 'reroll' || q.kind === 'secondWind') return { value: q.value, stay: q.stay, outcomes: [], plan: explain(q.plan), forecast: true, note: QUOTE_NOTES[q.kind] };
        if (q.kind === 'wildCard') return { value: q.value, stay: q.stay, outcomes: [], plan: explain(q.plan), coverage: 'trait-plus-stat', note: QUOTE_NOTES.wildCard };
        if (q.kind === 'unpriced') {
          const u = q.unpriced, row = u ? EC.TRAIT[u] : undefined;
          return { value: null, stay: null, outcomes: [], note: u && !row ? 'Trait not known to this tool.'
            : row?.unpriced || (row?.partner ? 'Linked employee is unknown; this trait is not a Habit outcome.' : 'Card is not available.'), plan: explain(q.plan) };
        }
        return { value: q.value, stay: q.stay, outcomes: q.outcomes.map(o => ({ p: o.p, arg: o.arg, value: o.value, stay: o.stay, plan: explain(o.plan) })),
          plan: explain(q.plan), coverage: q.coverage, note: q.note === 'assumptions' ? (notes ??= coverage(s).join(' ')) : OUTCOME_NOTES[q.note] ?? null };
      };
      return { valid: true, basis: 'rearranged', horizon, quotes: out.quotes.map(quoteOf), baseline: explain(out.baseline),
        coverage: { tested: out.tested, total: out.total }, projections: out.projections,
        warnings: out.warnings.map(i => `${s.employees[i].id} is already below 30 happiness.`) };
    }
    return { valid: !errors.length, horizon, price, free: () => session.free() };
  }
  // The career simulation of `subjectId` taking each card in `hand` (and
  // taking nothing), as EmployeeCareer.batch runs it: the subject's company
  // projected a step at a time, every card in `hand` and taking nothing as
  // a paired arm. It runs in the module (wasm/src/career.rs) over the
  // subject's company alone: this checks the inputs. `career` is the
  // module's handle; its caches last across batches. `rules` reads the
  // first state (`employee`), and `hand` the state one card after it too,
  // for inspection.
  // With `arrangement` (the planner's: [{ employee, company, tool }]), the
  // career runs where it puts the subject, among the coworkers and with the
  // tools it gives them, as if the moves were made now: whoever moves starts
  // a new tenure, and a roster that changes drops the game's reported Luck
  // and training allowance, which held for the old one. Product switches
  // are not applied: the company keeps its good.
  function careerOptions(snapshot, subjectId, hand, { seed = 1729, start = 0, count = 64, energyValue = 0, arrangement = null } = {}) {
    const placed = arrangement && new Map(arrangement.map(a => [a.employee, a]));
    const companyOf = e => placed?.get(e.id)?.company ?? e.company;
    const found = snapshot.employees.find(e => e.id === subjectId);
    const company = found && snapshot.companies.find(c => c.id === companyOf(found));
    if (!found || !company || company.disabled || company.excluded) throw Error('An active employee is required.');
    const pp = snapshot.ppValue;
    if (!(pp > 0)) throw Error('Market production-point value is required.');
    // Only the subject's company is projected, so only its data must be complete.
    let roster = snapshot.employees.filter(e => companyOf(e) === company.id);
    let tools;
    if (placed) {
      const changed = roster.some(e => e.company !== company.id) || roster.length !== snapshot.employees.filter(e => e.company === company.id).length;
      roster = roster.map(e => {
        const at = placed.get(e.id);
        const tool = at ? snapshot.tools.find(t => t.id === at.tool) : e.equipped;
        return { ...e, equipped: tool ? { ...tool, holder: e.id } : null,
          ...(e.company !== company.id ? { company: company.id, tenure: 0, moveAgeHours: 0 } : {}),
          ...(changed ? { observed: { ...e.observed, luck: undefined, trainingsPerDay: undefined } } : {}) };
      });
      tools = roster.flatMap(e => e.equipped ? [e.equipped] : []);
    } else {
      const ids = new Set(roster.map(e => e.id));
      tools = snapshot.tools.filter(t => ids.has(t.holder) || roster.some(e => e.equipped?.id === t.id));
    }
    const subject = roster.find(e => e.id === subjectId);
    const local = { ...snapshot, days: 1, companies: [company], employees: roster, tools };
    const employee = { ...subject, trainingBaseLuck: subject.luck, elapsed: 0 };
    const horizon = EC.workingDays(subject);
    const career = decoded(local, h => {
      const errors = check(local, h);
      if (errors.length) throw Error(errors[0]);
      for (const [i, reason] of uncertainties(local, h)) throw Error(`${local.employees[i].name} ${reason}.`);
      if (!Number.isFinite(horizon)) throw Error('Working days left are required.');
      // The record's happiness is its events; the career's rules don't read today's.
      return new (api().Career)(h, roster.indexOf(subject), { employee: { ...employee, happiness: null }, energyValue, hand: hand.map(c => c || null) });
    });
    const arms = [{ slot: null, card: null }, ...Array.from(career.slots(), slot => ({ slot, card: hand[slot] }))];
    const first = e => { if (e !== employee) throw Error('Career rules read the first state only.'); };
    // States one card after the first: the card and its outcome's draw.
    const afterFirst = new WeakMap();
    const rules = {
      retirement: () => horizon,
      next: (e, time) => { first(e); return career.next(time); },
      energyCost: time => career.energyCost(time),
      apply: (e, c, draw) => { first(e); const next = EC.inputs.after(e, career.applyFirst(c, draw)); afterFirst.set(next, { c, draw }); return next; },
      // A step from day `from` to `to`: { employee (clocks and events at `to`), profit }.
      advance: (e, from, to) => { first(e); const { profit, ...at } = career.advanceFirst(from, to); return { employee: { ...e, ...at }, profit }; },
      // The hand dealt when every draw is random(0), in the first state or one
      // card after it.
      hand: (e, random) => {
        const taken = afterFirst.get(e);
        if (!taken) first(e);
        const cards = taken ? career.handAfter(taken.c, taken.draw, random(0)) : career.handFirst(random(0));
        return cards.map(({ value, ...card }) => card);
      },
      metrics: () => career.metrics(),
    };
    return { employee, arms, skipped: Array.from(career.skipped()), seed, start, count, rules, horizon, career };
  }

  const EP = { careerOptions, returnsTool, evaluate, withExclusions, switchContext, recommend, recommendWith, outputOnlySearch, priceSets, retool, singleSwitches, evaluateRetooled, cardSession, retentionSession, keepSession, CARD_PLAN_CAP };
  // The module's tables, read once it is ready.
  for (const k of ['CHURN', 'TOOL_TYPES', 'SPECIALIZATION', 'CHANGE_ITEM_COST', 'SPIKE_RATIO']) Object.defineProperty(EP, k, { enumerable: true, get: () => MODEL[k] });
  return EP;
})();
if (typeof module !== 'undefined') module.exports = EmployeePlanner;
