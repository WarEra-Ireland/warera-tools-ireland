/* Deterministic paired-career engine. Every card in the live hand, plus
 * taking nothing, is one arm; each sampled career runs every arm on the same
 * random numbers, so differences between arms carry little sampling noise.
 *
 * The engine and its rules run in the employee model (wasm/src/career.rs):
 * `options` come from EmployeePlanner.careerOptions, whose `career` handle
 * holds the subject's company, the hand and the caches. This file keeps the
 * EmployeeCareer API over it: `batch` runs the module a few transitions per
 * step, so `run` keeps its chunking, progress and cancel; `compare` and
 * `random` are the module's (careerCompare, careerRandom). The page merges
 * and compares the workers' results with the module's careerMerge and
 * careerCompare directly. */
const EmployeeCareer = (() => {
  const node = typeof module !== 'undefined' && typeof require === 'function';
  const M = typeof EmployeeModel !== 'undefined' ? EmployeeModel : node ? require('./employee-model.js') : null;
  const api = () => {
    if (!M?.api) throw Error('The employee model is not ready: wait for EmployeeModel.ready.');
    return M.api;
  };
  // Transitions the module runs per step of the generator.
  const STEP = 64;
  const random = (seed, pair, step, purpose) => api().careerRandom(seed, pair, step, purpose);

  // Arm i against arm j: { mean, standardError } of the difference.
  const compare = (s, i, j) => api().careerCompare(s, i, j);

  // Yields { completed, decisions, candidates, transitions } as it goes;
  // returns { version, start, n, mean, m2, curve, decisions, candidates,
  // transitions, rerolls, projections, pools }.
  function* batch({ career, seed, start = 0, count }) {
    if (!career) throw Error('Career options come from EmployeePlanner.careerOptions.');
    const run = career.batch(seed, start, count);
    try {
      for (;;) {
        const finished = run.step(STEP);
        if (finished) return run.result();
        yield run.progress();
      }
    } finally { run.free(); }
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
  const EmployeeCareer = { random, batch, run, compare };
  // The module's constants, read once it is ready.
  Object.defineProperty(EmployeeCareer, 'VERSION', { enumerable: true, get: () => api().careerConstants().version });
  Object.defineProperty(EmployeeCareer, 'MAX_REROLLS', { enumerable: true, get: () => M.MAX_REROLLS });
  return EmployeeCareer;
})();
if (typeof module !== 'undefined') module.exports = EmployeeCareer;
