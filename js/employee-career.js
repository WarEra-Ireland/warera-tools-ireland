/* Deterministic paired-career engine. Every card in the live hand, plus taking
 * nothing, is one arm; each sampled career runs every arm on the same random
 * numbers, so differences between arms carry little sampling noise.
 * Game rules come in through `rules` (EmployeePlanner.careerOptions), so the
 * engine itself assumes no distribution.
 *
 * rules: retirement(e) → day the employee stops working
 *        next(e, t)     → time of the next training opportunity after t
 *        advance(e, from, to) → { employee, profit }
 *        energyCost(t), shouldTrain(e, t, cost)
 *        hand(e, rand)  → the cards dealt
 *        score(e, c, t) → career PP of taking c now, or null if it can't be taken
 *        apply(e, c, draw) → the employee after c (draw picks a random outcome) */
const EmployeeCareer = (() => {
  const VERSION = 4;
  // A new hand from Reroll costs no potential; this caps a run of them.
  const MAX_REROLLS = 8;
  const EPS = 1e-9;
  function random(seed, pair, step, purpose) {
    let x = seed | 0;
    for (const n of [pair, step, purpose]) {
      x = Math.imul(x ^ n, 0x45d9f3b);
      x ^= x >>> 16;
    }
    x = Math.imul(x, 0x45d9f3b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  const snap = x => Math.abs(x - Math.round(x)) < EPS ? Math.round(x) : x;

  // Running means and co-moments of every arm's career total, plus summed
  // cumulative profit by day for the chart. Mergeable (Chan et al.).
  function emptyStats(arms, days) {
    return { n: 0, mean: Array(arms).fill(0), m2: Array.from({ length: arms }, () => Array(arms).fill(0)),
      curve: Array.from({ length: arms }, () => Array(days).fill(0)) };
  }
  function addSample(s, totals, paths) {
    const k = totals.length, n = ++s.n;
    const before = totals.map((x, i) => x - s.mean[i]);
    for (let i = 0; i < k; i++) s.mean[i] += before[i] / n;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) s.m2[i][j] += before[i] * (totals[j] - s.mean[j]);
    for (let i = 0; i < k; i++) for (let d = 0; d < paths[i].length; d++) s.curve[i][d] += paths[i][d];
  }
  function merge(a, b) {
    if (!a?.n) return b;
    if (!b?.n) return a;
    if (a.mean.length !== b.mean.length || a.curve[0].length !== b.curve[0].length) throw Error('Incompatible career batches');
    const n = a.n + b.n, d = b.mean.map((m, i) => m - a.mean[i]);
    return { n,
      mean: a.mean.map((m, i) => m + d[i] * b.n / n),
      m2: a.m2.map((row, i) => row.map((v, j) => v + b.m2[i][j] + d[i] * d[j] * a.n * b.n / n)),
      curve: a.curve.map((row, i) => row.map((v, t) => v + b.curve[i][t])) };
  }
  // Arm i against arm j: the mean difference and its standard error.
  function compare(s, i, j) {
    const mean = s.mean[i] - s.mean[j];
    if (s.n < 2) return { mean, standardError: null };
    const variance = Math.max(0, (s.m2[i][i] + s.m2[j][j] - 2 * s.m2[i][j]) / (s.n - 1));
    return { mean, standardError: Math.sqrt(variance / s.n) };
  }

  function* batch({ employee, arms, seed, start = 0, count, rules }) {
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(seed) || !Number.isInteger(start) || start < 0) throw Error('Invalid batch');
    if (!Array.isArray(arms) || !arms.length) throw Error('No cards to compare');
    const end = rules.retirement(employee);
    if (!Number.isFinite(end) || end < 0) throw Error('Invalid retirement');
    const days = Math.ceil(end - EPS);
    const stats = emptyStats(arms.length, days);
    let decisions = 0, candidates = 0, transitions = 0, rerolls = 0;
    const progress = completed => ({ completed, decisions, candidates, transitions });

    // Picks from a hand: the highest score, a Reroll worth more redraws.
    function decide(state, time, rand, firstRoll = 0) {
      decisions++;
      for (let roll = firstRoll; ; roll++) {
        const hand = rules.hand(state, purpose => rand(10 * roll + purpose));
        let best = null, value = -Infinity;
        for (const card of hand) {
          if (card.card === 'reroll' && roll >= MAX_REROLLS) continue;
          const score = rules.score(state, card, time);
          if (score === null) continue;
          if (!Number.isFinite(score)) throw Error('Non-finite policy score');
          candidates++;
          if (score > value) { value = score; best = card; }
        }
        if (!best) return state;
        if (best.card === 'reroll') { rerolls++; continue; }
        return rules.apply(state, best, rand(999));
      }
    }

    for (let pair = start; pair < start + count; pair++) {
      const totals = [], paths = [];
      for (const arm of arms) {
        const rand = step => purpose => random(seed, pair, step, purpose);
        let state = structuredClone(employee);
        if (arm.card?.card === 'reroll') state = decide(state, 0, rand(0), 1);
        else if (arm.card) state = rules.apply(state, arm.card, rand(0)(999));
        let time = 0, total = 0, step = 0;
        const path = Array(days).fill(0);
        while (time < end - EPS) {
          const opportunity = state.potentialLeft > 0 ? snap(rules.next(state, time)) : Infinity;
          if (!(opportunity > time)) throw Error('Training opportunities must move forward');
          const to = Math.min(opportunity, snap(Math.floor(time + EPS) + 1), end);
          const advanced = rules.advance(state, time, to);
          if (!Number.isFinite(advanced.profit)) throw Error('Non-finite career profit');
          total += advanced.profit;
          state = advanced.employee;
          time = to;
          transitions++;
          if (Math.abs(time - Math.round(time)) < EPS || time >= end - EPS) path[Math.ceil(time - EPS) - 1] = total;
          if (time === opportunity && time < end - EPS && state.potentialLeft > 0) {
            step++;
            const cost = rules.energyCost(time);
            if (!Number.isFinite(cost) || cost < 0) throw Error('Invalid energy cost');
            if (rules.shouldTrain(state, time, cost)) {
              total -= cost;
              state = decide({ ...state, potentialLeft: state.potentialLeft - 1 }, time, rand(step));
            }
          }
          yield progress(pair - start);
        }
        // Energy spent on the last day lands after its cumulative point.
        if (days) path[days - 1] = total;
        totals.push(total); paths.push(path);
      }
      addSample(stats, totals, paths);
    }
    return { version: VERSION, start, ...stats, decisions, candidates, transitions, rerolls, ...rules.metrics?.() };
  }

  async function run(options, { signal, chunkSteps = 128, chunkMs = 8, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), onProgress = () => {} } = {}) {
    if (!Number.isInteger(chunkSteps) || chunkSteps < 1) throw Error('Invalid chunk size');
    if (!Number.isFinite(chunkMs) || chunkMs <= 0) throw Error('Invalid chunk duration');
    const iterator = batch(options);
    let progress;
    try {
      for (;;) {
        if (signal?.aborted) return { cancelled: true };
        const started = performance.now();
        for (let i = 0; i < chunkSteps; i++) {
          if (signal?.aborted) return { cancelled: true };
          const next = iterator.next();
          if (next.done) return { cancelled: false, result: next.value };
          progress = next.value;
          if (performance.now() - started >= chunkMs) break;
        }
        onProgress(progress);
        await yieldTask();
      }
    } finally { iterator.return(); }
  }
  return { VERSION, MAX_REROLLS, random, batch, run, merge, compare };
})();
if (typeof module !== 'undefined') module.exports = EmployeeCareer;
