/* Management points, manager pricing and the Irish buddy pool. */
const ManagerCore = (() => {
  /*
   *  Management points are the skill's value at a level: gameConfig
   *  skills.management.levels[n].value, 1–11 for levels 0–10. Prestige
   *  and strategic-resource bonuses add levels on top, and past the table
   *  the game carries on by its last step (its skill value lookup), so a
   *  manager contract's `managementLevel` of 11 is 12 points and nothing
   *  here is capped. A profile's management total already counts them.
   *  `levels` is that config object; without it, the game's own table.
   */
  const GAME_LEVELS = Object.fromEntries(Array.from({ length: 11 }, (_, n) => [n, { value: n + 1 }]));
  const topLevel = levels => Math.max(...Object.keys(levels).map(Number));
  function levelPoints(level, levels) {
    if (levels[level] !== undefined) return levels[level].value;
    const top = topLevel(levels);
    if (level <= 0 || top < 1) return levels[0]?.value ?? 0;
    return levels[top].value + (level - top) * (levels[top].value - levels[top - 1].value);
  }
  const points = user => Math.max(1, user.skills?.management?.total ?? 1);
  function pointsFromLevel(level, levels) {
    return levelPoints(Number.isFinite(level) ? Math.max(0, Math.round(level)) : 0, levels || GAME_LEVELS);
  }
  // The game's inverse (module 86436 fw): nearest level, from 0 up to the
  // table's top level, the range an offer's minimum can take.
  function levelFromPoints(pts, levels) {
    const table = levels || GAME_LEVELS;
    const zero = levelPoints(0, table), step = levelPoints(1, table) - zero;
    const n = Math.round((pts - zero) / step);
    return Number.isFinite(n) ? Math.min(topLevel(table), Math.max(0, n)) : 0;
  }
  // The points of the top ordinary level (11): the market quotes manager
  // pay for a manager with this many (the client divides by it).
  const ordinaryMaxPoints = levels => levelPoints(topLevel(levels || GAME_LEVELS), levels || GAME_LEVELS);

  // Money in the game has 6 decimals (module 88445 yL).
  const round6 = x => Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0;
  const HOURS = 24;

  /*
   *  What a manager adds and costs in one company, per day.
   *
   *  productionPerPoint (employee.getManagerPointValue) is the PP per hour
   *  one Management point adds there: 2 % of the employees' unboosted
   *  output. marginPerPP is money per PP of the company's product. The
   *  owner pays hourlyWage = rate × points every hour the company is
   *  enabled. An inactive manager (isInactive, 3 days offline) gives no
   *  bonus and accrues no pay, so both sides are zero.
   *
   *  Points cancel out of the verdict: profit = 24 × points ×
   *  (productionPerPoint × marginPerPP − rate), so breakEvenRate, the rate
   *  per point at which a manager of any level makes nothing, is
   *  productionPerPoint × marginPerPP. A vacant company has points 0 and
   *  still a breakEvenRate.
   */
  function companyValue({ productionPerPoint, marginPerPP, contract = null, enabled = true, levels }) {
    const breakEvenRate = productionPerPoint * marginPerPP;
    const pts = contract ? pointsFromLevel(contract.managementLevel, levels) : 0;
    const rate = contract ? contract.rateManagement : null;
    const hourlyWage = contract ? contract.hourlyWage ?? round6(rate * pts) : 0;
    const working = !!contract && enabled && !contract.isInactive;
    const valueDay = working ? HOURS * productionPerPoint * pts * marginPerPP : 0;
    const costDay = working ? HOURS * hourlyWage : 0;
    return { points: pts, rate, hourlyWage, inactive: !!contract?.isInactive, enabled,
      valueDay, costDay, profitDay: valueDay - costDay, breakEvenRate };
  }

  /*
   *  Ireland's view of a row: a buddy's wage stays in Ireland, so it costs
   *  Ireland nothing.
   */
  const irelandView = (row, isBuddy) => isBuddy ? { ...row, costDay: 0, profitDay: row.valueDay } : row;

  /*
   *  managerOffer.getWageStats quotes hourly wages for a manager at the top
   *  ordinary level (ordinaryMaxPoints, 11). Per point, rounded as the
   *  game's offer form does (module 93053 qr): min up and max down to 4
   *  decimals, so a rate inside stays allowed. `points` is that divisor.
   */
  function rateBand(stats, levels) {
    const range = stats?.allowedRange;
    if (!range) return null;
    const per = ordinaryMaxPoints(levels);
    return {
      min: Math.ceil(range.min / per * 1e4) / 1e4,
      max: Math.floor(range.max / per * 1e4) / 1e4,
      average: range.average / per,
      top: stats.topOffer != null ? stats.topOffer / per : null,
      // The real ceiling: an offer's rate × those points can't pass allowedRange.max.
      cap: Math.floor(range.max / per * 1e6) / 1e6,
      points: per,
    };
  }

  /*
   *  Hiring. Whoever applies first and meets the offer's minManagement
   *  and citizenship gets the job. Job seekers see offers by rate, highest
   *  first. So the rate to post is the top offer's (within the band) when
   *  that is under break-even. Otherwise it is the highest 4-decimal rate
   *  under break-even, which ranks lower and fills slower. Below the band
   *  no rate pays.
   *
   *  The minimum: about a third of recent hires had 1 point and a quarter
   *  had 8 or more (Irish companies, 2026-11-04). Profit scales with
   *  points, so 8 keeps the 1-point managers out and still fills.
   */
  const SUGGESTED_MIN_POINTS = 8;
  const topRate = band => Math.max(band.max, Math.min(band.top ?? band.max, band.cap ?? band.max));
  const profitAt = (breakEvenRate, rate, pts) => rate == null ? null : HOURS * pts * (breakEvenRate - rate);

  // The highest 4-decimal rate strictly under break-even.
  const stepUnder = breakEvenRate => round6(Math.ceil(round6(breakEvenRate * 1e4)) / 1e4 - 1e-4);

  /*
   *  The churn floor (in the spirit of planner-churn ticket 02). A change
   *  must gain at least MIN_GAIN a day after a price allowance: margins
   *  move, so PRICE_U of the change in value a manager adds doesn't count.
   *  A pay cut changes no value, so only the floor applies to it.
   */
  const CHURN = { minGain: 0.05, priceU: 0.05 };
  const robustGain = (gain, valueChange) => gain - CHURN.priceU * Math.abs(valueChange);
  const clears = (gain, valueChange) => robustGain(gain, valueChange) >= CHURN.minGain;

  function hireAdvice({ breakEvenRate, band, minPoints = SUGGESTED_MIN_POINTS }) {
    if (!band) return null;
    const top = topRate(band);
    let verdict, rate = null;
    if (!(breakEvenRate > 0)) verdict = 'idle';
    else if (breakEvenRate > top) { verdict = 'hire'; rate = top; }
    else {
      const under = stepUnder(breakEvenRate);
      if (under >= band.min) { verdict = 'slow'; rate = under; } else verdict = 'lose';
    }
    const profitMin = profitAt(breakEvenRate, rate, minPoints);
    // Posting undoes nothing, so a vacancy needs less than a change: the
    // floor, and still a profit after the price allowance.
    const worth = profitMin != null && profitMin >= CHURN.minGain && robustGain(profitMin, HOURS * minPoints * breakEvenRate) >= 0;
    return { verdict, rate, top, minPoints, minLevel: levelFromPoints(minPoints), worth,
      profitMin, profitMax: profitAt(breakEvenRate, rate, band.points ?? ordinaryMaxPoints()) };
  }

  /*
   *  What to do with a hired manager: 'keep', 'cut' (ask for a lower
   *  rate), 'replace' (end the contract and post an offer), 'fire', or for
   *  a buddy who loses you money and can't be cut, 'note'.
   *
   *  Pay cut: to min(the highest rate under break-even, the top offer).
   *  Above the top the market pays less now; above break-even each point
   *  loses. The game's changeRate needs the manager to accept, and they
   *  may quit instead. A cut can't go under the band.
   *
   *  Replace: a market hire priced by hireAdvice (its rate, at its
   *  minimum points, which is what fills) against today's profit. It can
   *  only start once the contract's 24 h lock ends (canEndAt). The slot
   *  then sits empty while the offer fills. Assumption from the open
   *  offers on 2026-11-04: an offer at the top fills in about 16 h (median
   *  age of the top offers), one under it in about 45 h (median age of the
   *  rest). That gap costs today's profit for its length, so the gain must
   *  also pay the gap back within PAYBACK_DAYS.
   *
   *  Fire: only a non-buddy who loses money and can't be cut to profit,
   *  which also means no hire pays there. A buddy is never fired or
   *  replaced (their pay stays in Ireland); placementAdvice may move them.
   *
   *  `row` is companyValue for the contract. Every change must clear the
   *  churn floor, else 'keep'.
   */
  const GAP_HOURS = { hire: 16, slow: 45 };
  const PAYBACK_DAYS = 7;

  function managerAdvice({ row, contract, band, buddy = false, now = Date.now() }) {
    if (!row || !contract || !band || !row.enabled) return null;
    const pts = row.points, be = row.breakEvenRate;
    const lockEnds = Date.parse(contract.canEndAt ?? contract.lockedUntil);
    const availableAt = Number.isFinite(lockEnds) && lockEnds > now ? new Date(lockEnds).toISOString() : null;

    let cut = null;
    if (!row.inactive && !contract.hasPendingRateReduction) {
      const target = round6(Math.min(stepUnder(be), topRate(band)));
      if (target >= band.min && target < contract.rateManagement) {
        const gain = HOURS * pts * (contract.rateManagement - target);
        cut = { rate: target, gain, profit: row.profitDay + gain, worth: clears(gain, 0) };
      }
    }

    let replace = null;
    const hire = hireAdvice({ breakEvenRate: be, band });
    if (!buddy && (hire.verdict === 'hire' || hire.verdict === 'slow')) {
      const gain = hire.profitMin - row.profitDay;
      const gapHours = GAP_HOURS[hire.verdict];
      const gapCost = Math.max(0, row.profitDay) * gapHours / HOURS;
      const valueChange = HOURS * hire.minPoints * be - row.valueDay;
      replace = { rate: hire.rate, minPoints: hire.minPoints, verdict: hire.verdict, profit: hire.profitMin, gain,
        gapHours, gapCost, availableAt, worth: clears(gain, valueChange) && gapCost <= PAYBACK_DAYS * gain };
    }

    const fire = !buddy && row.profitDay < 0 && !cut && !replace
      ? { gain: -row.profitDay, availableAt, worth: clears(-row.profitDay, row.valueDay) } : null;

    const options = [cut, replace].filter(o => o?.worth);
    const best = options.sort((a, b) => b.gain - a.gain)[0];
    const verdict = best === cut && cut ? 'cut' : best ? 'replace'
      : fire?.worth ? 'fire' : buddy && row.profitDay < 0 ? 'note' : 'keep';
    return { verdict, cut, replace, fire, availableAt, irelandGain: buddy ? row.valueDay : null };
  }

  /*
   *  The assignment problem, solved exactly (Hungarian algorithm, O(n²m)).
   *  `value[i][j]` is what row i earns in column j, with no more rows than
   *  columns. Returns the column of each row, maximising the total.
   */
  function bestAssignment(value) {
    const n = value.length, m = n ? value[0].length : 0;
    if (!n) return [];
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
    const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = -value[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const at = new Array(n);
    for (let j = 1; j <= m; j++) if (p[j]) at[p[j] - 1] = j - 1;
    return at;
  }

  /*
   *  Moves between your own companies (manager.transfer). A manager keeps
   *  their rate and points wherever they go ("Each keeps their own pay"),
   *  so their profit in company c is 24 × points × (breakEvenRate(c) −
   *  rate), and the pay part doesn't depend on the company: the best
   *  placement puts the most points on the highest break-even.
   *
   *  The game's move dialog doesn't check the 24 h lock, and warns that
   *  "everyone who changes company can resign straight afterwards": a
   *  move ignores the lock and lifts it. A taken company can only be
   *  entered by a swap; a disabled one not at all.
   *
   *  `managers`: [{id, points, rate, company}] (active managers only);
   *  `companies`: [{id, breakEvenRate}], every company a manager could sit
   *  in, their own included. Each group of companies the best placement
   *  changes is one suggestion, as the game's actions: a chain into a
   *  vacancy is moves (the last first), a cycle is swaps. Each manager
   *  moved must earn the churn floor, and a suggestion must clear it after
   *  the price allowance; its value change is its gain, since pay doesn't
   *  change.
   */
  function placementAdvice({ managers, companies }) {
    const ms = managers.filter(m => companies.some(c => c.id === m.company));
    if (!ms.length) return [];
    const be = companies.map(c => c.breakEvenRate);
    const profit = (m, j) => HOURS * m.points * (be[j] - m.rate);
    const index = new Map(companies.map((c, j) => [c.id, j]));
    // Each manager moved is a change: it pays the floor inside the solve, so
    // a small move doesn't ride along with a big one.
    const to = bestAssignment(ms.map(m => be.map((_, j) => profit(m, j) - (j === index.get(m.company) ? 0 : CHURN.minGain))));
    const holder = new Map(ms.map((m, i) => [index.get(m.company), i])); // company → manager index
    const target = new Map(ms.map((m, i) => [i, to[i]]));
    const seen = new Set(), out = [];
    for (let i = 0; i < ms.length; i++) {
      if (seen.has(i) || to[i] === index.get(ms[i].company)) continue;
      // Walk back to the head of a chain (a company nobody moves into), or around a cycle.
      let head = i;
      for (let k = 0; k < ms.length; k++) {
        const from = [...target].find(([, j]) => j === index.get(ms[head].company))?.[0];
        if (from == null || from === i) break;
        head = from;
      }
      const group = [];
      for (let k = head; k != null && !seen.has(k); k = holder.get(to[k])) { seen.add(k); group.push(k); }
      const cycle = holder.get(to[group.at(-1)]) === group[0];
      const steps = [];
      if (cycle) {
        // Swap whoever sits at the first company into their place until it holds the right one.
        const pos = new Map(group.map(k => [k, index.get(ms[k].company)]));
        const at = j => group.find(k => pos.get(k) === j);
        const first = pos.get(group[0]);
        for (let x = at(first); to[x] !== first; x = at(first)) {
          const y = at(to[x]);
          steps.push({ action: 'swap', a: ms[x].id, b: ms[y].id });
          pos.set(y, first); pos.set(x, to[x]);
        }
      } else for (const k of [...group].reverse()) steps.push({ action: 'move', manager: ms[k].id, to: companies[to[k]].id });
      const gain = group.reduce((a, k) => a + profit(ms[k], to[k]) - profit(ms[k], index.get(ms[k].company)), 0);
      out.push({ managers: group.map(k => ms[k].id), steps, gain, worth: clears(gain, gain),
        to: Object.fromEntries(group.map(k => [ms[k].id, companies[to[k]].id])) });
    }
    return out.sort((a, b) => b.gain - a.gain);
  }

  /*
   *  Irish picks: free Irish managers (canManage, from the buddy pool's
   *  roster) for slots you'd fill from the market, each slot with its
   *  break-even and the rate you'd post. Profit is linear in points, so
   *  the most points go to the slot with the widest margin. Only a pick
   *  that makes money is matched. `players` lists everyone free, most
   *  points first, with their slot if they got one.
   */
  function irishPicks({ roster, slots, exclude = [] }) {
    const skip = new Set(exclude);
    const players = roster.filter(p => p.user && canManage(p) && !skip.has(p.id))
      .sort((a, b) => points(b.user) - points(a.user) || a.user.username.localeCompare(b.user.username))
      .map(p => ({ id: p.id, user: p.user, points: points(p.user), slot: null, profit: null }));
    const open = [...slots].filter(s => s.rate != null && s.breakEvenRate > s.rate)
      .sort((a, b) => (b.breakEvenRate - b.rate) - (a.breakEvenRate - a.rate));
    const bySlot = new Map();
    open.forEach((s, i) => {
      const p = players[i];
      if (!p) return;
      p.slot = s.id;
      p.profit = HOURS * p.points * (s.breakEvenRate - s.rate);
      bySlot.set(s.id, p);
    });
    return { players, bySlot };
  }

  /*
   *  An open offer (managerOffer.getByCompanyId). `minManagement` is a
   *  level; none means any manager, down to 1 point. Status: 'loses' at
   *  or above break-even, 'unfillable' under the band, 'slow' under the
   *  top offer, else 'ok'. `lowMin` flags a minimum under the suggested
   *  one.
   */
  function offerCheck({ offer, breakEvenRate, band, levels }) {
    const rate = offer.rateManagement;
    const minPoints = offer.minManagement != null ? pointsFromLevel(offer.minManagement, levels) : 1;
    const status = rate >= breakEvenRate ? 'loses'
      : band && rate < band.min ? 'unfillable'
        : band && rate < round6(topRate(band)) ? 'slow' : 'ok';
    return { status, rate, minPoints, lowMin: minPoints < SUGGESTED_MIN_POINTS, citizenship: offer.citizenship || null,
      profitMin: profitAt(breakEvenRate, rate, minPoints), profitMax: profitAt(breakEvenRate, rate, band?.points ?? ordinaryMaxPoints(levels)) };
  }

  /*
   *  The Irish buddy pool. Any Irish player can have a buddy on each of
   *  their companies while managing just one company themselves. `owners`
   *  maps every Irish citizen to their company IDs and `managers` maps a
   *  company ID to its manager contract (or null). Any Irish manager is a
   *  buddy, whatever the wage; every other company is an open slot. `job` is
   *  the Irish company a player manages.
   */
  function pool({ owners, managers }) {
    const players = new Map([...owners].map(([id, companies]) =>
      [id, { id, companies: companies.length, buddies: [], openSlots: companies.length, job: null }]));
    for (const [owner, companies] of owners) {
      const player = players.get(owner);
      for (const companyId of companies) {
        const contract = managers.get(companyId);
        const manager = contract && players.get(contract.user);
        if (!manager) continue;
        manager.job = { company: companyId, employer: owner };
        player.buddies.push(manager.id);
      }
      player.openSlots = player.companies - player.buddies.length;
    }
    return players;
  }

  // Manager jobs unlock at level 10, and a player holds one at a time.
  const canManage = p => p.user.leveling?.level >= 10 && !p.job;

  // Most open slots first, so players who need buddies most are offered
  // first; then players free to manage, higher Management, username.
  const rankRoster = (a, b) => b.openSlots - a.openSlots
    || Number(canManage(b)) - Number(canManage(a))
    || points(b.user) - points(a.user)
    || a.user.username.localeCompare(b.user.username);

  return { points, pool, canManage, rankRoster, pointsFromLevel, levelFromPoints, companyValue, irelandView, rateBand,
    hireAdvice, offerCheck, managerAdvice, bestAssignment, placementAdvice, irishPicks, clears, robustGain, SUGGESTED_MIN_POINTS, CHURN, GAP_HOURS, PAYBACK_DAYS };
})();
if (typeof module !== 'undefined') module.exports = ManagerCore;
