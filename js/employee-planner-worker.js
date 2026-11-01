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
// Yield to incoming messages between cards. setTimeout(0) is clamped to 4 ms
// when nested, which over a feed of thousands of cards cost more than the
// pricing; a message hop isn't clamped, and only runs every few milliseconds.
const channel = new MessageChannel();
let wake = null, lastHop = 0;
channel.port1.onmessage = () => wake();
const hop = () => {
  if (performance.now() - lastHop < 10) return null;
  return new Promise(resolve => { wake = () => { lastHop = performance.now(); resolve(); }; channel.port2.postMessage(0); });
};
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
      // A batch of one subject fails with it; in a batch of several (the
      // feed) only that subject's group does, and the rest still price.
      if (!result.valid && job.jobs.length === 1) {
        self.postMessage({ generation: job.generation, id: job.id, result });
      } else {
        if (result.valid) {
          job.quotes.push(result.quotes[0]);
          job.meta = result;
          job.cardIndex++;
        }
        if (!result.valid || job.cardIndex >= group.cards.length) {
          job.results.push(result.valid ? { ...job.meta, quotes: job.quotes } : result);
          job.quotes = []; job.cardIndex = 0; job.index++; job.budget = CARD_SUBJECT_BUDGET;
        }
        if (job.index === job.jobs.length) self.postMessage({ generation: job.generation, id: job.id,
          result: { valid: true, groups: job.results } });
        else queue.push(job);
      }
      // Receive new live hands before choosing the next card in the feed.
      const hopped = hop();
      if (hopped) await hopped;
    }
  } finally { processing = false; }
}
self.onmessage = ({ data }) => {
  if (data.kind === 'cards:begin') {
    cardGeneration = data.generation; queue = [];
    session = EmployeePlanner.cardSession(data.snapshot); return;
  }
  if (data.kind === 'cards:cancel') {
    queue = queue.filter(j => !(j.id === data.id && j.generation === data.generation));
    return;
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
