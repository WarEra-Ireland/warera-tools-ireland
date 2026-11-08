/* Runs EmployeePlanner.recommend, card pricing, the keep step and career
 * simulations off the UI thread, all in the employee model: recommend's
 * search, cardSession's and keepSession's module sessions, and
 * careerOptions' `career` handle driven a few
 * transitions at a time by EmployeeCareer.run. The other scripts hold no
 * model logic, only what hands inputs to the module and the text of its
 * results. The Training page runs a career over several of these workers,
 * a share of the careers each, and merges their results.
 * The page passes the cache tags of its own employee-traits.js, employee-core.js,
 * employee-planner.js and employee-career.js, and
 * model= for the employee model (glue, loader and .wasm share one tag), so
 * the worker always loads the same versions as the page. Messages wait for
 * the model to be ready, in the order they came. */
const params = new URL(self.location.href).searchParams;
const tag = name => {
  const v = params.get(name) || '';
  if (!/^[\w.-]*$/.test(v)) throw new Error(`Invalid ${name} version`);
  return v;
};
importScripts(`wasm/employee_model.js?v=${tag('model')}`, `employee-model.js?v=${tag('model')}`, `employee-traits.js?v=${tag('traits')}`, `employee-core.js?v=${tag('core')}`, `employee-planner.js?v=${tag('planner')}`, `employee-career.js?v=${tag('career')}`);
const CARD_SUBJECT_BUDGET = 60000;
let cardGeneration = 0, session = null, cardSnapshot = null, keep = null;
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
// One company's keep rows (the Training page's Keep or replace), in roster
// order: each employee's retention, then what their row reads, then the
// row. The session is made at the first keep job of a generation, from the
// card session's snapshot, and keeps each company's tables and coworker
// grid for its later passes, which the page sends back to this worker.
function keepCompany({ employees, alt, energyValue }) {
  try {
    keep ??= EmployeePlanner.keepSession(cardSnapshot);
    return { valid: true, employees: employees.map(({ id, trainingValue }) => {
      const retention = keep.retention(id);
      if (!retention.valid) return { retention };
      for (const _ of keep.prepare(id));
      return { retention, row: keep.row(id, { alt, trainingValue, energyValue }) };
    }) };
  } catch (error) { return { valid: false, reason: error.message || 'The keep step failed.' }; }
}
let careerController = null, careerKept = null;
const CAREER_PROGRESS_MS = 250;
// The last career's options, kept by the page's revision: "Simulate more
// careers" runs further batches on them, so the module's caches carry over.
function careerOptions(data) {
  if (data.revision != null && careerKept?.revision === data.revision) {
    const { seed, start, count } = data.options || {};
    return { ...careerKept.options, ...(seed !== undefined && { seed }), ...(start !== undefined && { start }), ...(count !== undefined && { count }) };
  }
  careerKept?.options.career.free();
  careerKept = null;
  const options = EmployeePlanner.careerOptions(data.snapshot, data.subjectId, data.hand, data.options);
  if (data.revision != null) careerKept = { revision: data.revision, options };
  return options;
}
async function forecast(data) {
  careerController?.abort();
  const controller = careerController = new AbortController();
  const started = performance.now();
  let reported = started;
  try {
    const options = careerOptions(data);
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
// --- recommend over two workers ---
// The page may run a plan's search in one worker and its output-only
// comparison alongside in another, joined by a MessageChannel: the
// searching worker sends the comparison its terms once the search is done
// (`{ terms }`), and the other answers with the comparison
// (`{ comparison }`) or, at any time, `{ failed }`, after which the search
// makes the comparison itself (as it does with no port).
let compareLost = null;
function askAlongside(port) {
  let failed = false, waiting = null;
  const answer = comparison => { const resolve = waiting; waiting = null; resolve?.(comparison); };
  compareLost = () => { failed = true; answer(null); };
  port.onmessage = ({ data }) => { if (data.failed) compareLost(); else answer(data.comparison ?? null); };
  return terms => failed ? null : new Promise(resolve => { waiting = resolve; port.postMessage({ terms }); });
}
async function recommend({ runId, snapshot, options, port }) {
  const onProgress = partial => self.postMessage({ type: 'progress', runId, result: partial });
  let result;
  try {
    result = port ? await EmployeePlanner.recommendWith(snapshot, { ...options, onProgress }, askAlongside(port))
      : EmployeePlanner.recommend(snapshot, { ...options, onProgress });
  } catch (error) { result = { valid: false, errors: [error.message] }; }
  self.postMessage({ type: 'done', runId, result });
}
// A task's turn, so the terms can come in between rounds.
let turns = null;
const nextTurn = () => new Promise(resolve => {
  turns ??= new MessageChannel();
  turns.port1.onmessage = () => resolve();
  turns.port2.postMessage(null);
});
async function compareAlongside({ snapshot, options, port }) {
  let terms = null, arrived = null, search = null;
  port.onmessage = ({ data }) => { terms = data.terms; arrived?.(); };
  try {
    search = EmployeePlanner.outputOnlySearch(snapshot, options);
    // The search stops at the same input errors, and asks for nothing.
    if (!search) { port.postMessage({ failed: 'Invalid input.' }); return; }
    while (!terms && search.step()) await nextTurn();
    if (!terms) await new Promise(resolve => { arrived = resolve; });
    search.settle(terms);
    port.postMessage({ comparison: search.result() });
  } catch (error) { port.postMessage({ failed: error.message || String(error) }); }
  finally { search?.free(); }
}
function handle(data) {
  if (data.kind === 'model:version') { self.postMessage({ type: 'model:version', version: EmployeeModel.version, tag: EmployeeModel.tag }); return; }
  if (data.kind === 'compare') { compareAlongside(data); return; }
  if (data.kind === 'compare:lost') { compareLost?.(); return; }
  if (data.kind === 'career:cancel') { careerController?.abort(); return; }
  if (data.kind === 'career') { forecast(data); return; }
  if (data.kind === 'cards:begin') {
    cardGeneration = data.generation;
    // The last generation's sessions hold the module's caches: free them now.
    session?.free();
    keep?.free();
    keep = null;
    cardSnapshot = data.snapshot;
    session = EmployeePlanner.cardSession(data.snapshot); return;
  }
  if (data.kind === 'cards' || data.kind === 'keep') {
    if (data.generation !== cardGeneration) return;
    self.postMessage({ generation: data.generation, id: data.id, index: data.index, result: data.kind === 'keep' ? keepCompany(data.job) : priceSubject(data.job) });
    return;
  }
  recommend(data);
}
// What each message gets back if the model never loads.
function failed(data, error) {
  const message = `Couldn't load the employee model: ${error.message || error}`;
  if (data.kind === 'model:version') self.postMessage({ type: 'model:version', error: message });
  else if (data.kind === 'career') self.postMessage({ type: 'career:error', id: data.id, error: message });
  else if (data.kind === 'cards' || data.kind === 'keep') self.postMessage({ generation: data.generation, id: data.id, index: data.index, result: { valid: false, reason: message } });
  else if (data.kind === 'compare') data.port.postMessage({ failed: message });
  else if (data.kind === undefined) self.postMessage({ type: 'done', runId: data.runId, result: { valid: false, errors: [message] } });
}
self.onmessage = ({ data }) => { EmployeeModel.ready.then(() => handle(data), error => failed(data, error)); };
