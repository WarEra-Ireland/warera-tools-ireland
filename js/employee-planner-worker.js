/* Runs EmployeePlanner.recommend and career simulations off the UI thread.
 * The page passes the cache tags of its own employee-core.js,
 * employee-planner.js and employee-career.js, so the worker always loads
 * the same versions as the page. */
const params = new URL(self.location.href).searchParams;
const tag = name => {
  const v = params.get(name) || '';
  if (!/^[\w.-]*$/.test(v)) throw new Error(`Invalid ${name} version`);
  return v;
};
importScripts(`employee-core.js?v=${tag('core')}`, `employee-planner.js?v=${tag('planner')}`, `employee-career.js?v=${tag('career')}`);
const CARD_SUBJECT_BUDGET = 60000;
let cardGeneration = 0, session = null;
// One employee's cards per message. The page spreads a batch's employees
// over several workers and keeps the queue, so priorities and cancelling
// happen there, between employees.
function priceSubject({ subjectId, cards, options }) {
  let budget = CARD_SUBJECT_BUDGET, last = null;
  const quotes = [];
  for (const card of cards.length ? cards : [null]) {
    let result;
    try { result = session.price(subjectId, card ? [card] : [], { ...options, budget }); }
    catch (error) { result = { valid: false, reason: error.message || 'Card projection failed.' }; }
    if (!result.valid) return result;
    budget -= result.projections || 0;
    quotes.push(...result.quotes);
    last = result;
  }
  return { ...last, quotes };
}
let careerController = null;
const CAREER_PROGRESS_MS = 250;
async function forecast(data) {
  careerController?.abort();
  const controller = careerController = new AbortController();
  const started = performance.now();
  let reported = started;
  try {
    const options = EmployeePlanner.careerOptions(data.snapshot, data.subjectId, data.hand, data.options);
    const onProgress = p => {
      const now = performance.now();
      if (now - reported < CAREER_PROGRESS_MS || careerController !== controller) return;
      reported = now;
      self.postMessage({ type: 'career:progress', id: data.id, completed: p.completed });
    };
    const outcome = await EmployeeCareer.run(options, { signal: controller.signal, chunkSteps: 128, chunkMs: 8, onProgress });
    if (careerController !== controller) return;
    if (outcome.cancelled) { self.postMessage({ type: 'career:cancelled', id: data.id }); return; }
    self.postMessage({ type: 'career:done', id: data.id, result: outcome.result, arms: options.arms.map(a => a.slot),
      skipped: options.skipped, horizon: options.horizon, computeMs: performance.now() - started });
  } catch (error) {
    if (careerController === controller) self.postMessage({ type: 'career:error', id: data.id, error: error.message });
  }
}
self.onmessage = ({ data }) => {
  if (data.kind === 'career:cancel') { careerController?.abort(); return; }
  if (data.kind === 'career') { forecast(data); return; }
  if (data.kind === 'cards:begin') {
    cardGeneration = data.generation;
    session = EmployeePlanner.cardSession(data.snapshot); return;
  }
  if (data.kind === 'cards') {
    if (data.generation !== cardGeneration) return;
    self.postMessage({ generation: data.generation, id: data.id, index: data.index, result: priceSubject(data.job) });
    return;
  }
  const { runId } = data;
  try {
    const result = EmployeePlanner.recommend(data.snapshot, { ...data.options,
      onProgress: partial => self.postMessage({ type: 'progress', runId, result: partial }) });
    self.postMessage({ type: 'done', runId, result });
  } catch (error) { self.postMessage({ type: 'done', runId, result: { valid: false, errors: [error.message] } }); }
};
