/* Tools from the game, and the advisory workforce planner. No game mutations. */
const EmployeeAssignments = (() => {
  const EP = typeof module !== 'undefined' ? require('./employee-planner.js') : EmployeePlanner;
  const EC = typeof module !== 'undefined' ? require('./employee-core.js') : EmployeeCore;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = code => EC.TRAIT[code]?.name || code;
  const finite = value => Number.isFinite(value) ? value : null;
  const hoursUntil = (date, now) => date ? Math.max(0, (Date.parse(date) - now) / 36e5) : Infinity;
  const toolType = code => Object.keys(EP.TOOL_TYPES).find(t => code?.startsWith(t));
  // 'career' values changes until the last planned employee retires.
  const HORIZONS = ['career', '30', '14', '7'];
  const MAX_TOOLS = 100;
  // The game shows a tool's capacity left as a percentage; a new tool lasts
  // 500 working hours. Inputs are percentages, saved and planned as hours.
  const TOOL_HOURS = 500;
  const toHours = pct => String(pct ?? '').trim() === '' ? '' : String(Number(pct) * TOOL_HOURS / 100);
  const toPct = hours => String(hours ?? '').trim() === '' ? '' : String(Math.round(Number(hours) / TOOL_HOURS * 1e4) / 100);
  const ITEM_ID = /^[\w-]{1,64}$/;
  // seenEquipped: by game item ID, each tool's capacity when last seen
  // equipped, which it keeps once unequipped. gone: spares marked as no longer
  // owned, for losses the transaction log does not show.
  const defaults = () => ({ horizon: 'career', equippedHours: {}, pinned: [], seenEquipped: {}, gone: [], toolboxValue: 0, dailyTrainings: null, recruiting: [] });

  /* Saved settings are untrusted: rebuild them field by field and say what
   * was dropped, rather than failing later on a malformed value. */
  function sanitize(raw) {
    const settings = defaults(), notices = [];
    if (raw == null) return { settings, notices };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { settings, notices: ['Saved planner inputs were unreadable and have been reset.'] };
    // A saved `days` predates horizons; it was almost always the old default, so careers replace it.
    if (raw.horizon !== undefined) {
      if (HORIZONS.includes(String(raw.horizon))) settings.horizon = String(raw.horizon);
      else notices.push('The saved horizon was invalid; valuing changes over careers.');
    }
    // Spare tools were typed in before they came from the transaction log.
    if (Array.isArray(raw.inventory) && raw.inventory.length) notices.push('Spare tools now come from your toolbox history, so the tools entered by hand were removed.');
    for (const key of ['toolboxValue', 'dailyTrainings']) {
      if (raw[key] != null && raw[key] !== '' && Number.isFinite(Number(raw[key])) && Number(raw[key]) >= 0 && Number(raw[key]) <= 100000) settings[key] = Number(raw[key]);
    }
    if (Array.isArray(raw.recruiting)) settings.recruiting = [...new Set(raw.recruiting.filter(id => typeof id === 'string' && ITEM_ID.test(id)))];
    const object = v => v && typeof v === 'object' && !Array.isArray(v);
    if (object(raw.equippedHours)) {
      for (const [id, v] of Object.entries(raw.equippedHours)) {
        const n = Number(v);
        if (v !== '' && v !== null && Number.isFinite(n) && n >= 0 && n <= TOOL_HOURS) settings.equippedHours[id] = String(n);
      }
    }
    if (object(raw.seenEquipped)) {
      for (const [id, t] of Object.entries(raw.seenEquipped)) {
        if (!ITEM_ID.test(id) || !object(t) || !Number.isFinite(t.hours) || t.hours < 0 || t.hours > TOOL_HOURS) continue;
        settings.seenEquipped[id] = { hours: t.hours, at: Number.isFinite(t.at) ? t.at : 0,
          holder: typeof t.holder === 'string' ? t.holder.slice(0, 60) : '', company: typeof t.company === 'string' ? t.company.slice(0, 64) : '' };
      }
    }
    if (Array.isArray(raw.gone)) settings.gone = [...new Set(raw.gone.filter(id => typeof id === 'string' && ITEM_ID.test(id)))].slice(0, 500);
    if (Array.isArray(raw.pinned)) settings.pinned = [...new Set(raw.pinned.filter(id => typeof id === 'string' && id.length <= 64))];
    return { settings, notices };
  }

  // Per-field problems, keyed by input ID.
  function fieldErrors(settings, equippedIds = []) {
    const errors = [];
    for (const id of equippedIds) {
      const v = settings.equippedHours[id], hours = String(v ?? '').trim() === '' ? NaN : Number(v);
      if (v !== undefined && !(hours >= 0 && hours <= TOOL_HOURS)) errors.push([`plan-equipped-${id}`, 'Enter the capacity left, from 0 to 100 %.']);
    }
    return errors;
  }

  const activeOf = entry => entry.employees.filter(e => !e.leftAt);
  const unloadedOf = team => new Set(team.companies.filter(x => x.rosterMissing).map(x => x.company._id));

  /* The transaction log lists each tool an account gets (toolbox openings,
   * crafting, item market buys) and loses (dismantling, item market sales),
   * with the game item ID its employees later show. Rows may come in any
   * order. Returns the tools still owned: [{ id, type, bonus, at, how }]. */
  function toolLogOf(userId, rows) {
    const owned = new Map();
    const sorted = rows.filter(x => x && typeof x === 'object' && Number.isFinite(Date.parse(x.createdAt)))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const x of sorted) {
      const item = x.item, type = /^([a-z]+)\d*$/.exec(item?.code || '')?.[1];
      if (!EP.TOOL_TYPES[type] || typeof item._id !== 'string' || !ITEM_ID.test(item._id)) continue;
      const kind = x.transactionType;
      if (kind === 'dismantleItem' || (kind === 'itemMarket' && x.sellerId === userId && x.buyerId !== userId)) owned.delete(item._id);
      else if (['openCase', 'craftItem', 'itemMarket'].includes(kind)) {
        owned.set(item._id, { id: item._id, type, bonus: Number(item.skills?.production) || 0, at: x.createdAt,
          how: kind === 'openCase' ? 'toolbox' : kind === 'craftItem' ? 'crafted' : 'bought' });
      }
    }
    return [...owned.values()];
  }

  /* Spare tools: those the account owns, less the ones equipped now and those
   * marked gone. A tool last seen equipped in a company whose roster did not
   * load is taken as still there. Capacity left is the last reading while
   * equipped; a tool never seen equipped is taken as new. Spent tools are left out. */
  function sparesOf(owned, equippedIds, settings, unloaded = new Set()) {
    if (!owned) return [];
    const skip = new Set([...equippedIds, ...settings.gone]);
    return owned.filter(t => !skip.has(t.id) && !unloaded.has(settings.seenEquipped[t.id]?.company)).map(t => {
      const seen = settings.seenEquipped[t.id] || null;
      return { ...t, hours: seen ? seen.hours : TOOL_HOURS, seen };
    }).filter(t => t.hours > 0);
  }

  /* Records each equipped tool's capacity, so it is known once unequipped.
   * An unchanged reading keeps its time. With the full list of owned tools,
   * readings for tools no longer owned are dropped. */
  function observeEquipped(seen, equipped, owned = null, now = Date.now()) {
    const next = { ...seen };
    for (const t of equipped) {
      const old = next[t.id];
      if (old?.hours === t.hours && old.holder === t.holder && old.company === t.company) continue;
      next[t.id] = { hours: t.hours, at: now, holder: t.holder, company: t.company };
    }
    if (owned) {
      const keep = new Set([...owned.map(t => t.id), ...equipped.map(t => t.id)]);
      for (const id of Object.keys(next)) if (!keep.has(id)) delete next[id];
    }
    return next;
  }
  const equippedToolIds = team => team.companies.flatMap(activeOf).filter(e => e.toolItem?._id).map(e => e.toolItem._id);
  // team.toolLog: { owned, complete } from the page's load, or null when it failed.
  const sparesFor = (team, settings) => sparesOf(team.toolLog?.owned || null, equippedToolIds(team), settings, unloadedOf(team));
  // Remaining working days from the API, or age for manually supplied employees.
  const careerDays = employees => Math.min(47, Math.max(1, ...employees.map(EC.workingDays).filter(Number.isFinite).map(Math.ceil)));

  function snapshotOf(team, market, settings, now = Date.now()) {
    if (!team || !market?.ppValue) return { errors: ['Load your employees and product prices first.'] };
    const errors = [];
    const missing = (entry, active) => {
      const { company: c, region } = entry, p = market.list.find(p => p.code === c.itemCode), out = [];
      if (entry.rosterMissing) out.push('its employee list did not load');
      else if (!active.length) out.push('it has no active employees, so its production bonus cannot be checked against the game');
      if (!region?.country || !region?.initialCountry) out.push('its region did not load');
      if (!p) out.push('its product has no current price');
      if (!market.types?.[c.itemCode]) out.push('its product type is unknown');
      if (!Number.isFinite(entry.incomeTax)) out.push('its income tax did not load');
      return out;
    };
    const excluded = new Map();
    const companies = team.companies.map(entry => {
      const { company: c, region } = entry, active = activeOf(entry);
      const p = market.list.find(p => p.code === c.itemCode);
      // Management, manager and core-region bonuses, as an active employee gets them.
      const known = active.find(e => Array.isArray(e.productionBonus?.contributions))?.productionBonus.contributions;
      // A disabled company produces nothing: its employees can only move out.
      const disabled = !!c.disabledAt || active.some(e => e.companyDisabled);
      const bonus = known ? known.filter(x => ['management', 'manager', 'coreRegion'].includes(x.source)).reduce((n, x) => n + x.percent, 0) : disabled ? 0 : null;
      const reasons = missing(entry, active);
      if (active.length && !known && !disabled) reasons.push('its production bonus did not load');
      if (reasons.length) excluded.set(c._id, reasons);
      return { id: c._id, name: c.name || c.itemCode, product: c.itemCode, type: market.types?.[c.itemCode], margin: p?.perPP, disabled,
        engineDailyProd: market.engineLevels?.[c.activeUpgradeLevels?.automatedEngine]?.stats?.dailyProd || 0,
        engineBonus: entry.engineBonus || 0,
        bonus, tax: entry.incomeTax, country: region?.country, coreCountry: region?.initialCountry,
        storage: c.activeUpgradeLevels?.storage ?? 0, full: !!c.isFull, capacity: c.activeUpgradeLevels?.breakRoom ?? 1 };
    });
    const pinned = new Set(settings.pinned);
    const employees = team.companies.flatMap(entry => activeOf(entry).map(e => {
      const company = entry.company;
      const currentSpec = e.productionBonus?.contributions?.find(c => c.source === 'specialization')?.percent ?? 0;
      const tenure = Math.max(0, (now - Date.parse(e.lastMovedAt || e.createdAt)) / 864e5);
      const external = (e.happinessBreakdown?.contributions || []).filter(h => !h.code && !['responsibility', 'incomeTax', 'storageFull', 'comicCoworker', 'bullyCoworker', 'trait'].includes(h.reason));
      const tool = e.toolItem;
      const saved = Number(settings.equippedHours[e._id]);
      const equipped = tool ? { id: `equipped:${e._id}`, holder: e._id, name: `${e.name}'s equipped tool`, type: toolType(tool.code),
        bonus: e.toolStatus?.rolledPercent ?? tool.skills?.production,
        hours: settings.equippedHours[e._id] !== undefined && Number.isFinite(saved) ? saved : Math.max(0, tool.state / (tool.maxState || 100) * 500) } : null;
      const reasons = [];
      if (![e.base?.production, e.base?.responsibility, e.breakdown?.production?.total, e.breakdown?.responsibility?.total,
        e.productionBonus?.total, e.happinessBreakdown?.value, e.estimate?.production, e.age, e.wage].every(Number.isFinite) || !e.nationality || !Number.isFinite(tenure)) reasons.push(`${e.name}'s current stats did not load`);
      if (e.eventModifiers?.some(event => event.kind === 'away' && hoursUntil(event.until, now) > 0)) reasons.push(`${e.name} is temporarily away; absence forecasts are not supported`);
      if (!e.specializations) reasons.push(`${e.name}'s saved specializations did not load`);
      if (reasons.length) excluded.set(company._id, [...(excluded.get(company._id) || []), ...reasons]);
      const traitProduction = EC.ownTraitProduction(e);
      const paid = EC.paidProduction({ production: e.base?.production || 0, traitProduction });
      return { id: e._id, name: e.name, company: company._id, age: e.age, retireInDays: e.retireInDays, locked: pinned.has(e._id),
        production: e.base?.production, traitProduction, responsibility: e.base?.responsibility, luck: e.base?.luck ?? 0, trainingBaseLuck: e.base?.luck ?? 0, trainingLuck: e.breakdown?.luck?.total ?? 0,
        potentialLeft: Math.max(0, (e.potentialMax || 0) - (e.potential || 0)), wage: e.wage, negotiationExpectation: e.wageExpectation,
        climberRaise: e.traits?.some(t => t.code === 'climber') ? paid / 4 * market.ppValue * 0.02
          * (e.traits.some(t => t.code === 'greedy') ? 1.2 : e.traits.some(t => t.code === 'modest') ? 0.85 : 1) : 0,
        gender: e.gender, nationality: e.nationality, traits: e.traits || [], specializations: { ...e.specializations, [company.itemCode]: currentSpec },
        tenure, employedDays: Math.max(0, (now - Date.parse(e.createdAt)) / 864e5),
        moveAgeHours: e.lastMovedAt ? Math.max(0, (now - Date.parse(e.lastMovedAt)) / 36e5) : Infinity,
        productionEvents: (e.productionBonus?.contributions || []).filter(x => x.source === 'event')
          .map(x => ({ delta: x.percent, hours: hoursUntil(x.until, now) })),
        happiness: external.map(h => ({ delta: h.delta, hours: hoursUntil(h.until, now), reason: h.reason })),
        observed: { luck: e.breakdown?.luck?.total, trainingsPerDay: e.trainingsPerDay, production: e.breakdown?.production?.total, responsibility: e.breakdown?.responsibility?.total,
          happiness: e.happinessBreakdown?.value, bonus: e.productionBonus?.total, output: e.estimate?.production }, equipped };
    }));
    for (const c of companies) if (excluded.has(c.id)) c.excluded = `Not planned: ${excluded.get(c.id).join('; ')}.`;
    const tools = employees.flatMap(e => e.equipped ? [e.equipped] : []);
    for (const t of sparesFor(team, settings)) tools.push({ id: `spare:${t.id}`, name: `${cap(t.type)} (+${t.bonus}%)`, type: t.type, bonus: t.bonus, hours: t.hours });
    if (tools.length > MAX_TOOLS) errors.push(`Plan at most ${MAX_TOOLS} tools at a time, counting equipped and spare tools.`);
    const learners = employees.filter(e => e.potentialLeft > 0);
    const dailyTrainings = settings.dailyTrainings ?? Math.floor((team.energy || 0) / 10);
    const trainingQuota = learners.length ? dailyTrainings / learners.length : 0;
    for (const e of learners) {
      const c = companies.find(c => c.id === e.company);
      // Only paid Production (EC.paidProduction) carries the wage; Rival, Mentor and coworkers' never does.
      const model = { ...EC.DEFAULT_EMPLOYEE, ...e, extraProduction: e.observed.production - e.production - e.traitProduction,
        bonus: e.observed.bonus / 100, happiness: e.observed.happiness, specialization: 20,
        wageExpectation: e.wage / (EC.paidProduction(e) / 4 * market.ppValue) };
      const context = { sellRatio: c.margin / market.ppValue, toolboxValue: (settings.toolboxValue || 0) / market.ppValue, futureTraining: false };
      e.trainingValues = EC.RARITIES.map(r => Math.max(0, ...EC.NUMERIC_CARDS[r].map(card => EC.cardValue(model, card, context, 0) ?? 0)))
        .map(value => value * market.ppValue);
    }
    for (const c of companies) if ((settings.recruiting || []).includes(c.id) && !c.excluded) {
      const groups = [{ bonus: c.bonus / 100, happinessLoss: c.tax,
        ctx: { sellRatio: c.margin / market.ppValue, management: team.management || 0, futureTraining: false,
          situation: { itemType: c.type, product: c.product, incomeTax: c.tax } } }];
      const first = EC.freshSetValue(groups, { slots: 3, rate: 'slot' });
      c.recruitmentValues = [first.best, ...[4, 5, 6].map(slots => EC.freshSetValue(groups, { slots, rate: first.rate }).best)].map(value => value * market.ppValue);
    }
    const days = settings.horizon === 'career' ? careerDays(employees.filter(e => !excluded.has(e.company))) : Number(settings.horizon);
    return { errors, snapshot: { companies, employees, tools, days, toolboxValue: settings.toolboxValue || 0, trainingQuota, management: team.management || 0 } };
  }

  /* ── Rendering ─────────────────────────────────────────────── */
  const num = (v, d) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (v, d = 2) => `${v > 5e-7 ? '+' : v < -5e-7 ? '−' : ''}${num(Math.abs(v), d)}`;
  const pct = v => `${num(v, 1)}%`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const ICON = {
    swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    move: '<path d="M4 12h15l-4-4M19 12l-4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  // Tool types use the game's own item art; the rest are line glyphs.
  const icon = k => ICON[k] ? `<svg class="tr-asg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`
    : `<img class="tr-asg-icon" src="images/${EP.TOOL_TYPES[k] ? k : 'hammer'}.png" alt="" aria-hidden="true">`;

  // Short reason tags for an employee's change.
  function reasons(e, from, to, before, after, productName) {
    const out = [], moved = from.id !== to.id, raw = c => c.type === 'raw';
    const tag = (tone, text, hint = '') => out.push({ tone, text, hint });
    for (const [code, onRaw] of [['craftsman', false], ['laborer', true]]) {
      if (!e.traits.some(t => t.code === code) || raw(from) === raw(to)) continue;
      const v = c => raw(c) === onRaw ? 3 : -1;
      tag(v(to) > v(from) ? 'up' : 'down', `${title(code)} ${v(from) > 0 ? '+' : '−'}${Math.abs(v(from))} → ${v(to) > 0 ? '+' : '−'}${Math.abs(v(to))} Production`);
    }
    if (!!before.tool !== !!after.tool) {
      if (e.traits.some(t => t.code === 'handy')) tag(after.tool ? 'up' : 'down', `Handy ${after.tool ? 'gains' : 'loses'} +40%`);
      if (e.traits.some(t => t.code === 'improviser')) tag(after.tool ? 'down' : 'up', `Improviser ${after.tool ? 'loses' : 'gains'} +25%`);
    }
    if (moved) {
      if (e.traits.some(t => t.code === 'creatureOfHabit')) tag('down', 'Creature of Habit −30% for 3 days');
      if (e.traits.some(t => ['veteran', 'diamondInTheRough', 'burnout'].includes(t.code))) tag('down', 'Tenure restarts', 'Resets Veteran, Diamond in the Rough and Burnout.');
      if (from.product !== to.product) tag(after.specialization >= before.specialization ? 'up' : 'down', `Specialization ${pct(before.specialization)} → ${pct(after.specialization)}`, `Saved progress for ${productName(to.product)}.`);
    }
    tag('', `Output ${num(before.output, 2)} → ${num(after.output, 2)} PP/h`, 'Right after the change.');
    return out;
  }

  // Cumulative profit, current against proposed, with retirements and tool wear-out marked.
  function chart(baseline, proposed, days, events) {
    const cum = a => a.reduce((o, v) => (o.push(o[o.length - 1] + v), o), [0]);
    const now = cum(baseline.daily), plan = cum(proposed.daily);
    const W = 640, H = 190, L = 46, R = 70, T = 10, B = 24;
    const hi = Math.max(...now, ...plan, 1e-9), lo = Math.min(0, ...now, ...plan);
    const x = d => L + d / days * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const path = a => a.map((v, d) => `${d ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const gap = path(plan) + now.map((v, d) => `L${x(d).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('') + 'Z';
    const step = days <= 10 ? 1 : 7, ticks = [];
    for (let d = 0; d <= days; d += step) ticks.push(d);
    // Gridlines at round values that stay inside the plotted range.
    const round = v => { if (!v) return 0; const m = 10 ** Math.floor(Math.log10(Math.abs(v)) - 1); return Math.trunc(v / m) * m; };
    const yTicks = [...new Set([lo, 0, hi / 2, hi].map(round))];
    const [py, ny] = [y(plan[days]), y(now[days])];
    const apart = Math.abs(py - ny) < 14 ? (py <= ny ? [-5, 9] : [9, -5]) : [0, 0];
    const label = `Cumulative profit over ${plural(days, 'day')}: ${num(plan[days], 0)} proposed against ${num(now[days], 0)} if kept as is.`;
    return {
      data: { now, plan, x, y, W, days, events },
      html: `<div class="tr-asg-legend"><span><i class="is-plan"></i>Proposed, cumulative</span><span><i class="is-now"></i>Keep as is</span><span><i class="is-tick"></i>Retires or a tool wears out</span></div>
        <div class="tr-asg-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
          ${yTicks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${num(v, 0)}</text>`).join('')}
          ${ticks.map(d => `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">${d ? `day ${d}` : 'now'}</text>`).join('')}
          <path d="${gap}" class="gap"/>
          ${events.map(e => `<line x1="${x(e.day)}" x2="${x(e.day)}" y1="${H - B}" y2="${H - B - 6}" class="tick"/>`).join('')}
          <path d="${path(now)}" class="now"/><path d="${path(plan)}" class="plan"/>
          <text x="${W - R + 6}" y="${py + 4 + apart[0]}" class="end-plan">Proposed</text><text x="${W - R + 6}" y="${ny + 4 + apart[1]}">Now</text>
          <g data-chart-cross style="display: none"><line y1="${T}" y2="${H - B}" class="cross"/><circle r="4" class="dot-plan"/><circle r="4" class="dot-now"/></g>
          <rect data-chart-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg><div class="tr-asg-tip" hidden></div></div>`,
    };
  }

  // onResult hears the latest comparison for the page's Next actions and card values:
  // { running: true } while it searches, then { gain, days, horizon, changes,
  // cancelled, moves, tools } (tools: the registered tools it gives out), or null when there is none (inputs changed, or it failed).
  function mount(root, { getTeam, getMarket, productName = code => code, productIcon = code => esc(productName(code)), companyName = () => null, onResult = () => {}, onSettings = () => {} }) {
    let account = null, settings = defaults(), notices = [], worker = null, runId = 0, best = null, running = null, chartData = null;
    let draft = null;
    const key = () => `tr-assignments-v1:${account}`;
    const persist = () => { try { localStorage.setItem(key(), JSON.stringify(settings)); } catch { /* storage blocked */ } };
    const save = () => { notices = []; persist(); };
    const $ = sel => root.querySelector(sel);
    const dialog = document.createElement('dialog');
    dialog.className = 'tr-asg-dialog';
    dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
    root.after(dialog);
    const equippedOf = team => team.companies.flatMap(activeOf).filter(e => e.toolItem);
    const equippedIds = team => equippedOf(team).map(e => e._id);
    const estimateHours = e => String(Math.round(e.toolItem.state / (e.toolItem.maxState || 100) * 5000) / 10);
    const equippedHours = e => settings.equippedHours[e._id] ?? estimateHours(e);
    const over = days => settings.horizon === 'career' ? 'over their careers' : `over ${plural(days, 'day')}`;
    const products = type => (EP.TOOL_TYPES[type] || []).map(productIcon).join('');

    function stop() { worker?.terminate(); worker = null; running = null; }
    function setRunning(on) {
      $('[data-plan-run]').disabled = on;
      $('[data-plan-cancel]').hidden = !on;
      $('.tr-plan-actions').setAttribute('aria-busy', String(on));
    }
    function status(html) { $('[data-plan-status]').innerHTML = html; }
    // Inputs changed: compare again once typing pauses. A tool with an
    // error waits for the fix, without taking focus.
    let rerun = null;
    function stale() {
      clearTimeout(rerun);
      runId++; stop(); best = null; setRunning(false); onResult(null);
      status('<span class="tr-muted">Inputs changed. Comparing again…</span>');
      rerun = setTimeout(() => run({ auto: true }), 700);
      onSettings();
    }

    /* Tool cards. `holders` maps a tool ID to the employee who gets it. */
    function shelf(team, { holders = null, unusedWhy = () => '' } = {}) {
      const invalid = new Set(fieldErrors(settings, equippedIds(team)).map(([id]) => id.replace(/^plan-equipped-/, '')));
      const life = hours => `<span class="tr-asg-life" title="About ${esc(num(Number(hours) || 0, 0))} of ${TOOL_HOURS} working hours left"><span style="width:${Math.max(0, Math.min(100, (Number(hours) || 0) / TOOL_HOURS * 100))}%"></span></span>`;
      const spare = t => {
        const got = holders?.get(`spare:${t.id}`);
        const who = !holders ? '' : got ? `<small class="tr-asg-who">→ <b>${esc(got)}</b></small>` : `<small class="tr-asg-who is-warn">${esc(unusedWhy(t))}</small>`;
        return `<button type="button" class="tr-asg-tool" data-spare="${esc(t.id)}" aria-label="${esc(cap(t.type))} +${esc(num(t.bonus, 0))}%, spare: details">
          <span class="tr-asg-tool-top">${icon(t.type)}<span><b>+${esc(num(t.bonus, 0))}%</b><small>${esc(cap(t.type))} · spare</small></span></span>
          ${life(t.hours)}<small>${esc(toPct(t.hours))}% left${t.seen ? '' : ' · unused'} · <span class="tr-asg-products">${products(t.type)}</span></small>${who}</button>`;
      };
      const eq = e => {
        const type = toolType(e.toolItem.code) || 'hammer', hours = equippedHours(e);
        return `<button type="button" class="tr-asg-tool${invalid.has(e._id) ? ' is-invalid' : ''}" data-equipped-edit="${esc(e._id)}" aria-label="Correct the capacity left on ${esc(e.name)}'s ${esc(type)}">
          <span class="tr-asg-tool-top">${icon(type)}<span><b>+${esc(num(e.toolStatus?.rolledPercent ?? e.toolItem.skills?.production ?? 0, 0))}%</b><small>${esc(cap(type))} · equipped</small></span></span>
          ${life(hours)}<small>${esc(toPct(hours))}% left</small><small class="tr-asg-who">${holders ? (holders.has(`equipped:${e._id}`) ? `Assigned to <b>${esc(holders.get(`equipped:${e._id}`))}</b>` : 'Unused') : `Currently with <b>${esc(e.name)}</b>`}</small></button>`;
      };
      const cards = [...sparesFor(team, settings).map(spare), ...equippedOf(team).map(eq)];
      return cards.length ? cards.join('') : '<p class="tr-muted">No tools yet. Tools you open from toolboxes appear here.</p>';
    }

    // Where spares come from, and whether the log loaded.
    function toolSource(team) {
      const log = team.toolLog, owned = log?.owned || [];
      const hidden = owned.filter(t => settings.gone.includes(t.id)).length;
      const restore = hidden ? ` <button type="button" class="tr-link" data-spares-restore>Show ${plural(hidden, 'tool')} marked as gone</button>` : '';
      if (!log) return '<p class="tr-warn">Your toolbox history did not load, so spare tools are left out. Reload employees to try again.</p>';
      return `<p class="tr-muted">Spares are tools from your toolboxes that no employee holds. Each keeps its capacity from when it was last seen equipped; one never seen equipped counts as new.${restore}</p>
        ${log.complete ? '' : '<p class="tr-warn">Only your most recent tool history loaded, so older tools may be missing.</p>'}`;
    }

    // Only the tool cards change, so the page keeps its scroll position.
    function redrawShelf(focus) {
      const team = getTeam();
      $('[data-plan-source]').innerHTML = toolSource(team);
      $('[data-plan-shelf]').innerHTML = shelf(team);
      (root.querySelector(focus) || $('[data-plan-shelf] button'))?.focus({ preventScroll: true });
    }

    function refresh(focus = null) {
      runId++; stop(); best = null;
      const team = getTeam();
      if (!team) { onResult(null); root.innerHTML = '<p class="tr-muted">Load your employees above to compare company and tool assignments.</p>'; return; }
      const nextAccount = team.userId || team.username.toLowerCase();
      if (account !== nextAccount) {
        account = nextAccount;
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(key()) || 'null'); } catch { notices = ['Saved planner inputs were unreadable and have been reset.']; }
        ({ settings, notices } = sanitize(raw));
        if (raw?.inventory) persist();
      }
      const equipped = team.companies.flatMap(entry => activeOf(entry).filter(e => e.toolItem?._id).map(e => ({ id: e.toolItem._id,
        hours: Math.max(0, Math.min(TOOL_HOURS, Number(equippedHours(e)) || 0)), holder: e.name, company: entry.company._id })));
      const seen = observeEquipped(settings.seenEquipped, equipped, team.toolLog?.complete ? team.toolLog.owned : null);
      if (JSON.stringify(seen) !== JSON.stringify(settings.seenEquipped)) { settings.seenEquipped = seen; persist(); }
      // After recording, so the page's card values see this load's spares.
      onResult(null);
      const people = team.companies.flatMap(entry => activeOf(entry).map(e => ({ e, company: entry.company })));
      const career = careerDays(people.map(({ e }) => e));
      const horizon = h => h === 'career' ? `Careers · ${career} d` : `${h} d`;
      root.innerHTML = `${notices.length ? `<ul class="tr-warn" role="status">${notices.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="tr-asg-head">
          <p class="tr-calc-sub">Who works where, and who holds which tool, to earn the most at today's prices. Inputs are saved in this browser for ${esc(team.username)}.</p>
          <div class="tr-asg-controls">
            <span class="tr-asg-label" id="plan-horizon-label">Value over</span>
            <div class="tr-asg-seg" role="group" aria-labelledby="plan-horizon-label">${HORIZONS.map(h => `<button type="button" data-plan-horizon="${h}" aria-pressed="${settings.horizon === h}" title="${h === 'career' ? `Until the last planned employee retires at ${EC.CFG.retireAge}` : `Ignore anything after ${h} days`}">${horizon(h)}</button>`).join('')}</div>
            <span class="tr-plan-actions"><button type="button" class="btn-primary" data-plan-run>Compare again</button><button type="button" data-plan-cancel hidden>Cancel</button></span>
          </div>
        </div>
        <details class="tr-more"><summary>Valuation assumptions</summary>
          <label>Value per toolbox, in money <input type="number" min="0" max="100000" step="any" data-plan-value="toolboxValue" value="${settings.toolboxValue}"></label>
          <label>Trainings budget per day <input type="number" min="0" max="100000" step="any" data-plan-value="dailyTrainings" value="${settings.dailyTrainings ?? Math.floor((team.energy || 0) / 10)}"></label>
          <p class="tr-muted">Zero toolbox value excludes loot income. The training budget defaults to one full energy bar a day, shared equally among employees with potential. Training benefits use a bounded numeric-card estimate; they do not simulate future trait choices.</p>
          <p>Value Recruiter for one planned candidate set in:</p>${team.companies.map(({ company: c }) => `<label><input type="checkbox" data-plan-recruit="${esc(c._id)}" ${settings.recruiting.includes(c._id) ? 'checked' : ''}>${esc(companyName(c._id) || c.name || c.itemCode)}</label>`).join('')}
          <p class="tr-muted">Recruiter estimates compare extra candidates in one set at the current product margin. They exclude future rerolls and coworker effects of the eventual hire.</p>
        </details>
        <div data-plan-status role="status" aria-live="polite"></div>
        <div data-plan-hero></div>
        <div class="tr-asg-grid">
          <div class="tr-asg-main" data-plan-result></div>
          <div class="tr-asg-side">
            <section class="tr-asg-box tr-asg-tools" aria-labelledby="plan-tools-heading"><h4 id="plan-tools-heading">Your tools</h4>
              <div data-plan-source>${toolSource(team)}</div>
              <div class="tr-asg-shelf" data-plan-shelf>${shelf(team)}</div></section>
            <section class="tr-asg-box" aria-labelledby="plan-pins-heading"><h4 id="plan-pins-heading">Keep in place</h4>
              <p class="tr-muted">Selected employees stay in their company. They can still get a tool.</p>
              <div class="tr-asg-pins">${people.map(({ e, company }) => `<button type="button" class="tr-asg-pin" data-plan-pin="${esc(e._id)}" aria-pressed="${settings.pinned.includes(e._id)}" title="${esc(companyName(company._id) || company.name || '')}">${productIcon(company.itemCode)}${esc(e.name)}</button>`).join('')}</div></section>
            <details class="tr-more"><summary>What the comparison includes</summary><p class="tr-calc-sub">The planner scores whole company rosters: Craftsman on manufactured goods and weapons, Laborer on raw resources, Handy and Improviser, coworker traits, company bonuses and taxes, happiness, saved specialization, tenure and retirement. Moving an employee between your companies costs no happiness, but Creature of Habit loses 30 bonus points for three days. Company tenure restarts; the same product keeps its specialization, and another product restores that product's saved progress. Tools stop when their capacity runs out and are not replaced. A disabled company's employees don't work, train or get paid there, so moving them out to a working company can pay; nobody is moved into a disabled company.</p><p class="tr-calc-sub">Careers value every change until the last planned employee retires at ${EC.CFG.retireAge}, one year older per day worked or trained. A retired employee's place stays empty: hiring a replacement is not valued. A shorter window ignores everything after it, so it favours quick wins over moves that pay back later.</p><p class="tr-calc-sub">This is a bounded search for a better arrangement, not a guarantee of the best one. Each employee moves at most once. A company with a hidden or unknown trait, or whose current numbers the planner cannot reproduce, is left exactly as it is and is not part of the totals. Toolboxes use your entered value. Trainer and coworker Luck use a bounded training estimate and your daily budget. Recruiter is valued only for a planned candidate set. Earnings assume employees stay; quitting probabilities and future price changes are not modeled. Equipped tools can be reassigned to any compatible employee. Nothing is changed in the game.</p></details>
          </div>
        </div>`;
      if (focus) root.querySelector(focus)?.focus();
    }

    /* ── Tool dialog ───────────────────────────────────────────── */
    function showFieldErrors(errors, scope = root) {
      for (const el of scope.querySelectorAll('[aria-invalid="true"]')) clearError(el);
      for (const [id, message] of errors) { const input = scope.querySelector(`#${CSS.escape(id)}`); if (input) markError(input, message); }
    }
    function markError(input, message) {
      const note = document.getElementById(`${input.id}-err`);
      input.setAttribute('aria-invalid', 'true');
      if (note) { note.textContent = message; note.hidden = false; }
    }
    function clearError(input) {
      input.removeAttribute('aria-invalid');
      const note = document.getElementById(`${input.id}-err`);
      if (note) { note.textContent = ''; note.hidden = true; }
    }
    const field = (id, label, input, hint = '') => `<div class="tr-field"><label for="${id}">${label}</label>${input}${hint}<small class="tr-plan-err" id="${id}-err" hidden></small></div>`;
    const day = at => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const close = '<button type="button" class="tr-asg-close" data-dialog-close aria-label="Close">✕</button>';

    function drawDialog() {
      const team = getTeam(), d = draft;
      if (d.spare) {
        const t = sparesFor(team, settings).find(t => t.id === d.spare), how = { toolbox: 'Opened from a toolbox', crafted: 'Crafted', bought: 'Bought' }[t.how];
        dialog.innerHTML = `<form method="dialog" data-dialog-form novalidate><header><h3 id="plan-dialog-title">${esc(cap(t.type))} +${esc(num(t.bonus, 0))}%</h3>${close}</header>
          <div class="tr-asg-dialog-body"><p>${how} on ${esc(day(t.at))}. ${t.seen ? `Last seen equipped${t.seen.holder ? ` by ${esc(t.seen.holder)}` : ''} with ${esc(toPct(t.hours))}% left${t.seen.at ? `, on ${esc(day(t.seen.at))}` : ''}.` : 'Not seen equipped yet, so it counts as new.'}</p>
          <p class="tr-muted">If you no longer have it, mark it as gone so the planner stops offering it.</p></div>
          <footer><span class="tr-asg-preview">${icon(t.type)}<span><b>${esc(cap(t.type))} · spare</b><br><small class="tr-muted">${esc(toPct(t.hours))}% left</small></span></span>
          <span class="tr-asg-buttons"><button type="button" data-dialog-close>Cancel</button><button type="button" data-dialog-gone>Mark as gone</button></span></footer></form>`;
        return;
      }
      const e = equippedOf(team).find(e => e._id === d.equipped), type = toolType(e.toolItem.code) || 'hammer', id = `plan-equipped-${e._id}`;
      dialog.innerHTML = `<form method="dialog" data-dialog-form novalidate><header><h3 id="plan-dialog-title">${esc(e.name)}'s ${esc(type)}</h3>${close}</header>
        <div class="tr-asg-dialog-body"><p class="tr-muted">Equipped tools can be reassigned to compatible employees. Capacity left starts from the game; a new tool lasts ${TOOL_HOURS} working hours. Correct it if it has changed.</p>
        ${field(id, 'Capacity left %', `<input id="${id}" type="number" inputmode="decimal" autocomplete="off" min="0" max="100" step="any" data-dialog-field="hours" value="${esc(toPct(d.hours))}" aria-describedby="${id}-err">`, `<small class="tr-muted">From the game: ${esc(toPct(estimateHours(e)))}%</small>`)}</div>
        <footer><span class="tr-asg-preview">${icon(type)}<span><b>${esc(cap(type))} · equipped</b><br><small class="tr-muted">Currently with ${esc(e.name)}</small></span></span>
        <span class="tr-asg-buttons"><button type="button" data-dialog-close>Cancel</button><button type="submit" class="btn-primary" data-dialog-save>Save</button></span></footer></form>`;
    }
    function openSpare(id) {
      draft = { spare: id, back: `[data-spare="${CSS.escape(id)}"]` };
      drawDialog(); dialog.showModal();
      dialog.querySelector('[data-dialog-close]:not(.tr-asg-close)')?.focus();
    }
    function openEquipped(id, errors = []) {
      const e = equippedOf(getTeam()).find(e => e._id === id);
      draft = { equipped: id, hours: equippedHours(e), back: `[data-equipped-edit="${CSS.escape(id)}"]` };
      drawDialog(); dialog.showModal();
      showFieldErrors(errors, dialog);
      dialog.querySelector('[data-dialog-field]')?.select();
    }
    function commit() {
      if (!draft?.equipped) return;
      const errors = fieldErrors({ equippedHours: { [draft.equipped]: draft.hours } }, [draft.equipped]);
      if (errors.length) { showFieldErrors(errors, dialog); dialog.querySelector('[aria-invalid="true"]')?.focus(); return; }
      settings.equippedHours[draft.equipped] = String(Number(draft.hours));
      const back = draft.back;
      draft = null; dialog.close(); save();
      if (getTeam()) { redrawShelf(back); stale(); }
    }
    dialog.addEventListener('click', ev => {
      const t = ev.target;
      if (t === dialog || t.closest('[data-dialog-close]')) return dialog.close();
      if (t.closest('[data-dialog-gone]')) {
        const team = getTeam(), list = sparesFor(team, settings), i = list.findIndex(x => x.id === draft.spare);
        settings.gone = [...new Set([...settings.gone, draft.spare])];
        draft = null; dialog.close(); save();
        const next = list[i + 1] || list[i - 1];
        redrawShelf(next ? `[data-spare="${CSS.escape(next.id)}"]` : null); stale();
      }
    });
    dialog.addEventListener('submit', ev => { ev.preventDefault(); commit(); });
    dialog.addEventListener('input', ev => {
      const t = ev.target;
      if (!t.dataset.dialogField || !draft?.equipped) return;
      draft.hours = toHours(t.value);
      if (t.getAttribute('aria-invalid')) clearError(t);
    });
    dialog.addEventListener('close', () => {
      const back = draft?.back; draft = null;
      if (back) root.querySelector(back)?.focus();
    });

    /* ── Result ────────────────────────────────────────────────── */
    function renderResult(result, snapshot, { cancelled = false } = {}) {
      const out = $('[data-plan-result]'), hero = $('[data-plan-hero]');
      out.classList.remove('is-stale'); hero.classList.remove('is-stale');
      chartData = null;
      if (!result.valid) { onResult(null); hero.innerHTML = ''; out.innerHTML = `<ul class="tr-warn">${result.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`; return; }
      const { baseline, proposed } = result, days = snapshot.days;
      const emp = id => snapshot.employees.find(e => e.id === id);
      const co = id => snapshot.companies.find(c => c.id === id);
      // Company names repeat (new companies share a default), so add the product.
      const place = id => `<span class="tr-asg-place">${productIcon(co(id).product)}${esc(companyName(id) || co(id).name)}</span>`;
      const tool = id => snapshot.tools.find(t => t.id === id);
      const row = (rows, id) => rows.employees.find(r => r.id === id);
      const final = new Map(result.arrangement.map(a => [a.employee, a]));
      const changed = result.arrangement.filter(a => a.company !== emp(a.employee).company || a.tool !== (emp(a.employee).equipped?.id || null));
      const changedIds = new Set(changed.map(a => a.employee));
      const moved = changed.filter(a => a.company !== emp(a.employee).company);
      onResult({ coverage: result.coverage, warnings: result.warnings, excluded: result.excluded, gain: result.gain, days, horizon: settings.horizon, changes: changed.length, cancelled,
        moves: moved.map(a => ({ employee: a.employee, to: a.company })),
        tools: result.arrangement.map(a => ({ employee: a.employee, tool: a.tool ? tool(a.tool) : null })) });
      const delta = id => row(proposed, id).value - row(baseline, id).value;
      const newTool = id => { const a = final.get(id); return a.tool && a.tool !== (emp(id).equipped?.id || null) ? tool(a.tool) : null; };
      const toolText = t => `${esc(cap(t.type))} +${esc(num(t.bonus, 0))}%`;
      const toolLife = t => `${num(t.hours, 0)} h of use`;

      // One step per move or swap, carrying the tools its people then get; tool-only changes follow.
      const inSteps = new Set(result.steps.flatMap(s => s.employees));
      const items = [...result.steps, ...changed.filter(a => !inSteps.has(a.employee)).map(a => ({ kind: 'tool', employees: [a.employee] }))];
      const tags = id => {
        const e = emp(id), list = reasons(e, co(e.company), co(final.get(id).company), row(baseline, id), row(proposed, id), productName);
        return list.map(r => `<span class="tr-asg-tag${r.tone ? ` is-${r.tone}` : ''}"${r.hint ? ` title="${esc(r.hint)}"` : ''}>${esc(r.text)}</span>`).join('');
      };
      // A tool that does not fit the new company returns to inventory by itself.
      const equip = id => {
        const t = newTool(id), back = EP.returnsTool(emp(id), final.get(id), snapshot.tools, snapshot.companies);
        return `${back ? `<span class="tr-muted">${esc(emp(id).name)}'s ${toolText(back)} goes back to inventory</span>` : ''}${t ? `<span>then give ${esc(emp(id).name)} the <b>${toolText(t)}</b> · ${toolLife(t)}</span>`
          : !back && emp(id).equipped && !final.get(id).tool ? `<span>Remove ${esc(emp(id).name)}'s current tool</span>` : ''}`;
      };
      const stepHtml = (item, i) => {
        const [a, b] = item.employees.map(emp), value = item.employees.reduce((v, id) => v + delta(id), 0);
        let glyph, head, detail;
        if (item.kind === 'swap') {
          glyph = icon('swap'); head = `Swap ${esc(a.name)} ↔ ${esc(b.name)}`;
          detail = `<span>${esc(a.name)}: ${place(a.company)} <span class="tr-muted">→</span> ${place(b.company)}</span><span>${esc(b.name)}: ${place(b.company)} <span class="tr-muted">→</span> ${place(a.company)}</span><span class="tr-muted">Use the game's Swap option</span>${equip(a.id)}${equip(b.id)}`;
        } else if (item.kind === 'move') {
          glyph = icon('move'); head = `Move ${esc(a.name)}`;
          detail = `<span>${place(a.company)} <span class="tr-muted">→</span> ${place(item.to)}</span>${equip(a.id)}`;
        } else {
          const t = newTool(a.id);
          glyph = icon(t?.type || 'move'); head = t ? `Give ${esc(a.name)} the ${toolText(t)}` : `Remove ${esc(a.name)}'s current tool`;
          detail = `<span>in ${place(final.get(a.id).company)}</span>${t ? `<span class="tr-muted">${toolLife(t)}</span>` : ''}`;
        }
        return `<li class="tr-asg-step" data-emps="${esc(item.employees.join(' '))}"><span class="tr-asg-n" aria-hidden="true">${i + 1}</span><span class="tr-asg-glyph">${glyph}</span>
          <div><div class="tr-asg-step-head">${head}</div><div class="tr-asg-step-detail">${detail}</div>${item.employees.map(id => `<div class="tr-asg-tags">${item.employees.length > 1 ? `<b>${esc(emp(id).name)}</b>` : ''}${tags(id)}</div>`).join('')}</div>
          <div class="tr-asg-value${value < 0 ? ' is-neg' : ''}">${signed(value)}<small>${signed(value / days, 2)}/day</small></div></li>`;
      };

      const coworkers = proposed.employees.filter(r => !changedIds.has(r.id)).map(r => ({ r, b: row(baseline, r.id) }))
        .filter(({ r, b }) => Math.abs(r.value - b.value) > 0.005);
      const coworkerHtml = ({ r, b }) => {
        const e = emp(r.id), bits = [];
        if (r.production !== b.production) bits.push(`Production ${num(b.production, 0)} → ${num(r.production, 0)}`);
        if (Math.abs(r.bonus - b.bonus) > 0.05) bits.push(`bonus ${pct(b.bonus)} → ${pct(r.bonus)}`);
        if (Math.abs(r.happiness - b.happiness) > 0.05) bits.push(`happiness ${num(b.happiness, 1)} → ${num(r.happiness, 1)}`);
        return `<li><span><strong>${esc(e.name)}</strong> <span class="tr-muted">in</span> ${place(r.company)}<small class="tr-muted">${bits.length ? bits.join(' · ') : 'Effects that start later, such as coworker pay or tenure'}</small></span>
          <span class="tr-asg-value${r.value - b.value < 0 ? ' is-neg' : ''}">${signed(r.value - b.value)}</span></li>`;
      };

      // Headline figures.
      const gainDaily = proposed.daily.map((v, i) => v - baseline.daily[i]);
      let sum = 0, payback = 0;
      gainDaily.forEach((v, i) => { sum += v; if (sum < -1e-9) payback = i + 2; });
      const manual = snapshot.tools.filter(t => t.hours > 0 && (!t.holder || !result.excluded.some(x => x.company === emp(t.holder).company)));
      const used = manual.length - result.unused.filter(id => manual.some(t => t.id === id)).length;
      const planned = snapshot.companies.filter(c => !result.excluded.some(x => x.company === c.id));
      const plannedPeople = snapshot.employees.filter(e => planned.some(c => c.id === e.company));
      const last = plannedPeople.reduce((a, e) => !a || EC.workingDays(e) > EC.workingDays(a) ? e : a, null);
      const pinned = plannedPeople.filter(e => e.locked).length;
      const good = result.gain > 1e-7;
      const tile = (k, v, s, cls = '') => `<div class="tr-asg-tile${cls}"><div class="tr-asg-k">${k}</div><div class="tr-asg-v">${v}</div><div class="tr-asg-s">${s}</div></div>`;
      hero.innerHTML = `<div class="tr-asg-hero">
        ${tile(`Extra profit · ${settings.horizon === 'career' ? 'over their careers' : `next ${plural(days, 'day')}`}`, good ? signed(result.gain) : 'Keep as is',
          good ? `≈ ${signed(result.gain / days)} a day · game money after wages, at today's prices` : 'No more profitable arrangement found', good ? ' is-big' : ' is-big is-flat')}
        ${tile('Moves', moved.length, moved.length ? (payback > 1 ? `pays back by day ${payback}` : 'pays off from day 1') : 'none worth it')}
        ${tile('Tools used', `${used}<span class="tr-muted"> / ${manual.length}</span>`, !manual.length ? 'none available' : used < manual.length ? `${manual.length - used} left unused` : 'all in use')}
        ${tile('Horizon', `${days} d`, settings.horizon === 'career' ? (last ? `${esc(last.name)} retires last, after ${EC.workingDays(last)} working days` : 'until retirement') : 'fixed window')}
        ${tile('Planned', `${planned.length}<span class="tr-muted"> / ${snapshot.companies.length}</span>`, `companies · ${plural(plannedPeople.length, 'employee')}${pinned ? ` · ${pinned} kept in place` : ''}`)}</div>`;

      // Chart markers: retirements, and tools wearing out, inside the horizon.
      const events = [];
      for (const e of plannedPeople) { const d = EC.workingDays(e); if (d > 0 && d < days) events.push({ day: d, text: `${e.name} retires` }); }
      for (const a of result.arrangement) {
        const t = a.tool && tool(a.tool), d = t && t.hours / 24;
        if (d > 0 && d < days && planned.some(c => c.id === a.company)) events.push({ day: d, text: `${emp(a.employee).name}'s ${t.type} wears out` });
      }
      const drawn = days > 1 ? chart(baseline, proposed, days, events) : null;
      chartData = drawn?.data || null;
      const head = cancelled ? '<p class="tr-warn">Search cancelled. This is the best arrangement found before cancelling: every step is valid, but a finished search may find more.</p>' : '';
      out.innerHTML = `${head}<details class="tr-more"><summary>Valuation coverage and assumptions</summary><ul>${(result.coverage || []).map(note => `<li>${esc(note)}</li>`).join('')}</ul></details>${drawn ? `<section class="tr-asg-box">${drawn.html}</section>` : ''}
        <section class="tr-asg-box" aria-labelledby="plan-steps-heading"><h4 id="plan-steps-heading">${items.length ? 'Recommended moves and tool assignments <span class="tr-muted">· then reload employees</span>' : 'No changes'}</h4>
          ${items.length ? `<ol class="tr-asg-steps">${items.map(stepHtml).join('')}</ol>` : `<p class="tr-muted">No profitable change found ${over(days)}. Tools can remain unused.</p>`}
          ${coworkers.length ? `<details class="tr-more"><summary>${plural(coworkers.length, 'coworker')} ${coworkers.length === 1 ? 'is' : 'are'} affected <em>· ${signed(coworkers.reduce((v, { r, b }) => v + r.value - b.value, 0))}, included above</em></summary>
            <p class="tr-muted">They stay where they are, but who joins or leaves changes their traits, happiness or pay comparisons.</p><ul class="tr-asg-coworkers">${coworkers.map(coworkerHtml).join('')}</ul></details>` : ''}
        </section>
        ${result.excluded.length ? `<section class="tr-plan-excluded"><h4>Not planned</h4><p class="tr-muted">These companies keep their employees and tools exactly as they are. Their profit is not in the totals above.</p><ul>${result.excluded.map(x => `<li><strong>${place(x.company)}</strong>: ${esc(x.reason.replace(/^Not planned: /, ''))}</li>`).join('')}</ul></section>` : ''}
        ${result.warnings.length ? `<ul class="tr-warn">${result.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <p class="tr-muted tr-asg-foot">${result.partial ? 'Partial search' : 'Best arrangement found'} after ${result.search.candidates.toLocaleString()} comparisons in ${plural(result.search.rounds, 'round')} (${result.search.projections.toLocaleString()} of at most ${result.search.maxProjections.toLocaleString()} roster projections)${result.search.limited ? '. The search limit was reached, so further improvements may exist' : ''}.</p>`;

      // Tool cards learn who gets each tool, or why it stays unused.
      const holders = new Map(result.arrangement.filter(a => a.tool).map(a => [a.tool, emp(a.employee).name]));
      const fits = type => planned.some(c => EP.TOOL_TYPES[type]?.includes(c.product));
      const unusedWhy = r => fits(r.type) ? 'No gain found' : `None of your planned companies makes ${EP.TOOL_TYPES[r.type].map(productName).join(', ')}`;
      $('[data-plan-shelf]').innerHTML = shelf(getTeam(), { holders, unusedWhy });
    }

    function hoverChart(ev) {
      const hit = ev.target.closest?.('[data-chart-hit]');
      const wrap = root.querySelector('.tr-asg-chart');
      if (!wrap || !chartData) return;
      const tip = wrap.querySelector('.tr-asg-tip'), cross = wrap.querySelector('[data-chart-cross]');
      if (!hit) { tip.hidden = true; cross.style.display = 'none'; return; }
      const { now, plan, x, y, W, days, events } = chartData, svg = wrap.querySelector('svg'), r = svg.getBoundingClientRect();
      const vx = (ev.clientX - r.left) / r.width * W;
      let d = 0;
      for (let i = 0; i <= days; i++) if (Math.abs(x(i) - vx) < Math.abs(x(d) - vx)) d = i;
      cross.style.display = '';
      const line = cross.querySelector('line'), [p, n] = cross.querySelectorAll('circle');
      line.setAttribute('x1', x(d)); line.setAttribute('x2', x(d));
      p.setAttribute('cx', x(d)); p.setAttribute('cy', y(plan[d])); n.setAttribute('cx', x(d)); n.setAttribute('cy', y(now[d]));
      const notes = events.filter(e => e.day > d - 1 && e.day <= d).map(e => `<div class="tr-muted">${esc(e.text)}</div>`).join('');
      tip.innerHTML = `<b>${d ? `Day ${d}` : 'Now'}</b><div>Proposed <b>${num(plan[d], 1)}</b></div><div class="tr-muted">Keep as is <b>${num(now[d], 1)}</b></div>
        <div class="${plan[d] - now[d] < 0 ? 'tr-asg-neg' : 'tr-asg-pos'}">Gain <b>${signed(plan[d] - now[d], 1)}</b></div>${notes}`;
      tip.hidden = false;
      const px = x(d) / W * r.width;
      tip.style.left = `${px > r.width * 0.6 ? px - tip.offsetWidth - 12 : px + 12}px`;
    }
    root.addEventListener('pointermove', hoverChart);
    root.addEventListener('pointerleave', hoverChart);

    function fail(message) {
      stop(); setRunning(false);
      if (best) { renderResult(best.result, best.snapshot, { cancelled: true }); status(`<span class="tr-warn">${esc(message)} Showing the best arrangement found before the error.</span>`); }
      else { status(''); renderResult({ valid: false, errors: [message] }); }
    }

    // auto: started by the page after a load, so a field error doesn't open the editor.
    function run({ auto = false } = {}) {
      const team = getTeam();
      if (!team || !getMarket()?.ppValue) return;
      const errors = fieldErrors(settings, equippedIds(team));
      if (errors.length) {
        status(`<span class="tr-warn">Fix ${plural(errors.length, 'tool')} marked below${auto ? ', then compare' : ' before comparing'}.</span>`);
        if (auto) return;
        const [first] = errors[0];
        openEquipped(first.replace(/^plan-equipped-/, ''), errors.filter(([id]) => id === first));
        return;
      }
      const prepared = snapshotOf(team, getMarket(), settings);
      if (prepared.errors.length) { status(''); renderResult({ valid: false, errors: prepared.errors }); return; }
      runId++; stop(); best = null;
      const id = runId, snapshot = prepared.snapshot;
      const started = Date.now();
      $('[data-plan-result]').classList.add('is-stale'); $('[data-plan-hero]').classList.add('is-stale');
      status(`<span class="tr-muted">Comparing employee placements and tools ${over(snapshot.days)}…</span>`);
      setRunning(true);
      onResult({ running: true });
      const tag = name => document.querySelector(`script[src*="js/${name}.js"]`)?.getAttribute('src')?.match(/[?&]v=([\w.-]+)/)?.[1] || '';
      try {
        worker = new Worker(`${root.dataset.worker}&core=${tag('employee-core')}&planner=${tag('employee-planner')}`);
      } catch (err) { console.warn('[planner] worker failed', err); fail('The planner could not start in this browser.'); return; }
      running = id;
      worker.onmessage = ({ data }) => {
        if (data?.runId !== id || running !== id) return;
        if (data.type === 'progress') {
          best = { result: data.result, snapshot };
          const seconds = Math.round((Date.now() - started) / 1000);
          status(`<span class="tr-muted">Searching… round ${data.result.search.rounds}, ${data.result.search.candidates.toLocaleString()} comparisons${seconds ? `, ${seconds} s` : ''}. Best so far ${signed(data.result.gain)} ${over(snapshot.days)}.</span>`);
          return;
        }
        stop(); setRunning(false); status('');
        renderResult(data.result, snapshot);
      };
      worker.onerror = ev => { ev.preventDefault?.(); console.warn('[planner] worker error', ev.message); if (running === id) fail('The planner stopped unexpectedly. Reload the page and try again.'); };
      worker.onmessageerror = () => { if (running === id) fail('The planner sent an unreadable result. Reload the page and try again.'); };
      try { worker.postMessage({ runId: id, snapshot }); }
      catch (err) { console.warn('[planner] postMessage failed', err); fail('The planner could not receive the employee data.'); }
    }

    function cancel() {
      if (!worker) return;
      runId++; stop(); setRunning(false);
      if (best) { renderResult(best.result, best.snapshot, { cancelled: true }); status(''); }
      else {
        status('<span class="tr-muted">Search cancelled before any improvement was found.</span>');
        for (const el of [$('[data-plan-result]'), $('[data-plan-hero]')]) { el.innerHTML = ''; el.classList.remove('is-stale'); }
        chartData = null;
      }
      $('[data-plan-run]').focus();
    }

    root.addEventListener('change', ev => {
      const el = ev.target;
      if (el.dataset.planValue) {
        if (!el.checkValidity() || el.value === '') { el.reportValidity(); return; }
        settings[el.dataset.planValue] = Number(el.value);
      } else if (el.dataset.planRecruit) {
        const id = el.dataset.planRecruit;
        settings.recruiting = el.checked ? [...new Set([...settings.recruiting, id])] : settings.recruiting.filter(x => x !== id);
      } else return;
      save(); stale();
    });
    root.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.spare) openSpare(b.dataset.spare);
      else if (b.dataset.sparesRestore !== undefined) { settings.gone = []; save(); redrawShelf(null); stale(); }
      else if (b.dataset.equippedEdit) openEquipped(b.dataset.equippedEdit, fieldErrors({ equippedHours: settings.equippedHours }, [b.dataset.equippedEdit]));
      else if (b.dataset.planHorizon) {
        if (settings.horizon === b.dataset.planHorizon) return;
        settings.horizon = b.dataset.planHorizon;
        for (const x of root.querySelectorAll('[data-plan-horizon]')) x.setAttribute('aria-pressed', String(x === b));
        save(); stale();
      } else if (b.dataset.planPin) {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        settings.pinned = on ? [...new Set([...settings.pinned, b.dataset.planPin])] : settings.pinned.filter(id => id !== b.dataset.planPin);
        save(); stale();
      } else if (b.dataset.planRun !== undefined) run();
      else if (b.dataset.planCancel !== undefined) cancel();
    });
    refresh();
    return {
      refresh,
      run,
      cardSettings: () => JSON.parse(JSON.stringify(settings)),
      // Opened from the roster: focus the planner's Compare button.
      reveal() {
        root.querySelector('[data-plan-run]')?.focus({ preventScroll: true });
      },
    };
  }
  // Card valuations run on a few workers, each with its own session of the
  // same snapshot. A batch is split by employee, and each idle worker takes
  // the most urgent employee left, preferring ones it has priced before
  // (its caches hold them). Revision changes discard every quote, including
  // replies already queued by a terminated worker. Settled batches are kept
  // for reuse, least recently asked for first, up to this many; pending ones
  // stay until answered or cancelled.
  const SETTLED_KEPT = 200;
  const cardWorkers = () => Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
  function createCardPricer({ workerFactory, onUpdate = () => {}, workers: size = cardWorkers() }) {
    let pool = [], queue = [], revision = null, generation = 0, serial = 0, order = 0, failure = null;
    const batches = new Map();
    function prune() {
      let settled = 0;
      for (const b of batches.values()) if (b.status !== 'pending') settled++;
      for (const [key, b] of batches) {
        if (settled <= SETTLED_KEPT) break;
        if (b.status !== 'pending') { batches.delete(key); settled--; }
      }
    }
    const stopAll = () => { for (const w of pool) w.worker.terminate(); pool = []; queue = []; };
    const fail = reason => {
      stopAll();
      failure = reason;
      for (const batch of batches.values()) if (batch.status === 'pending') Object.assign(batch, { status: 'fallback', reason });
      onUpdate();
    };
    function settle(batch) {
      const [only] = batch.groups;
      Object.assign(batch, batch.jobs.length === 1 && only.valid === false
        ? { status: 'fallback', reason: only.reason || 'Projection could not finish.' }
        : { status: 'done', result: { valid: true, groups: batch.groups } });
      batch.jobs = null;
      prune();
      onUpdate();
    }
    function pump() {
      for (const slot of pool) {
        if (slot.task || !queue.length) continue;
        const fresh = t => slot.seen.has(t.job.subjectId) ? 0 : 1;
        const before = (x, y) => x.batch.priority - y.batch.priority || fresh(x) - fresh(y) || x.order - y.order;
        let at = 0;
        for (let i = 1; i < queue.length; i++) if (before(queue[i], queue[at]) < 0) at = i;
        const [task] = queue.splice(at, 1);
        slot.task = task; slot.seen.add(task.job.subjectId);
        try { slot.worker.postMessage({ kind: 'cards', generation, id: task.batch.id, index: task.index, job: task.job }); }
        catch { slot.task = null; task.batch.groups[task.index] = { valid: false, reason: 'The worker could not receive this batch.' }; if (!--task.batch.left) settle(task.batch); }
      }
    }
    function spawn(gen, snapshot) {
      const slot = { worker: workerFactory(), task: null, seen: new Set() };
      slot.worker.onmessage = ({ data }) => {
        if (gen !== generation || data.generation !== gen) return;
        const task = slot.task;
        slot.task = null;
        if (task && task.batch.id === data.id && task.index === data.index && task.batch.status === 'pending' && !task.batch.cancelled) {
          task.batch.groups[task.index] = data.result;
          if (!--task.batch.left) settle(task.batch);
        }
        pump();
      };
      slot.worker.onerror = () => { if (gen === generation) fail('The valuation worker failed.'); };
      slot.worker.onmessageerror = () => { if (gen === generation) fail('The valuation worker returned an unreadable batch.'); };
      slot.worker.postMessage({ kind: 'cards:begin', generation: gen, snapshot });
      return slot;
    }
    function reset(key, snapshot) {
      if (revision === key) return;
      revision = key; generation++; stopAll(); batches.clear(); failure = null;
      if (!snapshot) { failure = 'No verified workforce is loaded.'; return; }
      try { for (let i = 0; i < size; i++) pool.push(spawn(generation, snapshot)); }
      catch { if (!pool.length) failure = 'A valuation worker is unavailable in this browser.'; }
    }
    // Move a queued batch: up when a prefetched hand comes on screen, back when superseded.
    function reprioritize(key, priority) {
      const batch = batches.get(key);
      if (batch?.status === 'pending') batch.priority = priority;
    }
    // Drop a batch nothing shows any more; asking again re-queues it.
    // Employees already being priced finish unseen.
    function cancel(key) {
      const batch = batches.get(key);
      if (!batch) return;
      batches.delete(key);
      if (batch.status !== 'pending') return;
      batch.cancelled = true;
      queue = queue.filter(t => t.batch !== batch);
    }
    function request(key, jobs, priority = 2) {
      const known = batches.get(key);
      if (known) {
        batches.delete(key); batches.set(key, known);
        if (priority < known.priority) reprioritize(key, priority);
        return known;
      }
      const batch = { id: ++serial, status: failure ? 'fallback' : 'pending', reason: failure, priority };
      batches.set(key, batch);
      if (!failure) {
        Object.assign(batch, { jobs, groups: new Array(jobs.length), left: jobs.length });
        for (const [index, job] of jobs.entries()) queue.push({ batch, index, job, order: ++order });
        if (!jobs.length) settle(batch);
        pump();
      }
      prune();
      return batch;
    }
    return { reset, request, reprioritize, cancel, get generation() { return generation; },
      dispose() { generation++; stopAll(); batches.clear(); } };
  }
  return { mount, sanitize, fieldErrors, snapshotOf, careerDays, createCardPricer, toolLogOf, sparesOf, observeEquipped };
})();
if (typeof module !== 'undefined') module.exports = EmployeeAssignments;
