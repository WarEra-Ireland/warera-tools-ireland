/* Runs EmployeePlanner.recommend off the UI thread. The page passes the
 * cache tags of its own employee-core.js and employee-planner.js, so the
 * worker always loads the same versions as the page. */
const params = new URL(self.location.href).searchParams;
const tag = name => {
  const v = params.get(name) || '';
  if (!/^[\w.-]*$/.test(v)) throw new Error(`Invalid ${name} version`);
  return v;
};
importScripts(`employee-core.js?v=${tag('core')}`, `employee-planner.js?v=${tag('planner')}`);
const CARD_SUBJECT_BUDGET = 60000;
let cardGeneration = 0, session = null, queue = [], processing = false;
const hop = () => new Promise(resolve => setTimeout(resolve, 0));
async function drainCards() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      const job = queue.shift();
      if (job.generation !== cardGeneration) continue;
      const group = job.jobs[job.index];
      const card = group.cards[job.cardIndex];
      let result;
      try { result = session.price(group.subjectId, [card], { ...group.options, budget: job.budget }); }
      catch (error) { result = { valid: false, reason: error.message || 'Card projection failed.' }; }
      job.budget -= result.projections || 0;
      if (!result.valid) {
        self.postMessage({ generation: job.generation, id: job.id, result });
      } else {
        job.quotes.push(result.quotes[0]);
        job.meta = result;
        job.cardIndex++;
        if (job.cardIndex >= group.cards.length) {
          job.results.push({ ...job.meta, quotes: job.quotes });
          job.quotes = []; job.cardIndex = 0; job.index++; job.budget = CARD_SUBJECT_BUDGET;
        }
        if (job.index === job.jobs.length) self.postMessage({ generation: job.generation, id: job.id,
          result: { valid: true, groups: job.results } });
        else queue.push(job);
      }
      // Receive new live hands before choosing the next card in the feed.
      await hop();
    }
  } finally { processing = false; }
}
self.onmessage = ({ data }) => {
  if (data.kind === 'cards:begin') {
    cardGeneration = data.generation; queue = [];
    session = EmployeePlanner.cardSession(data.snapshot); return;
  }
  if (data.kind === 'cards:priority') {
    const job = queue.find(j => j.id === data.id && j.generation === data.generation);
    if (job) job.priority = data.priority;
    return;
  }
  if (data.kind === 'cards') {
    if (data.generation !== cardGeneration) return;
    queue.push({ ...data, index: 0, cardIndex: 0, quotes: [], results: [], budget: CARD_SUBJECT_BUDGET });
    drainCards(); return;
  }
  const { runId } = data;
  try {
    const result = EmployeePlanner.recommend(data.snapshot, { ...data.options,
      onProgress: partial => self.postMessage({ type: 'progress', runId, result: partial }) });
    self.postMessage({ type: 'done', runId, result });
  } catch (error) { self.postMessage({ type: 'done', runId, result: { valid: false, errors: [error.message] } }); }
};
