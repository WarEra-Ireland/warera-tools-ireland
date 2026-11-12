/*
 *  FIGHTING SEARCH WORKER
 *  Runs fighting-search.js off the page's thread. It keeps the checkpoint
 *  itself and writes it to IndexedDB periodically and when stopped.
 *
 *  In:  { port: true } + a MessagePort  send results to the merge worker
 *                                    on it from now on, not to the page
 *       { direct: true }             send results to the page again (the
 *                                    merge worker failed) and repost the last
 *       { restore: true, snapshot, seed, runId }  read this seed's saved
 *                                    checkpoint and report it, without searching
 *       { until, depth?, snapshot?, seed?, checkpoint?, runId? }  search until the Date.now() time `until`,
 *                                    or until `depth` rounds are complete (a snapshot
 *                                    starts over; without a runId nothing is saved)
 *       { stop: true }               end the current search early
 *  Out: { seq, meta, result?, running, savedAt, saveError, restored? }
 *                                    meta: metadata, infeasible and the
 *                                    frontier's size; result (search()'s
 *                                    slim frontier, infeasible and metadata)
 *                                    only without a port; running: false
 *                                    once ended
 *       { restoreError }             the saved checkpoint can't be used
 *  Port out: { seed, seq, result }   the same result, numbered like the
 *                                    page's message so the merge can wait for it
 */
// Loads its dependencies with the query it was loaded with: a ?w= one, so
// these URLs never meet the page's own ?v= ones with different contents.
importScripts(...['sp-advisor-core.js', 'fighting-core.js', 'fighting-search.js', 'fighting-progress.js']
  .map(f => f + self.location.search));

const SLICE_MS = 100;  // work between checks for a stop message
const POST_MS = 500;   // progress updates to the page

let snapshot = null, seed = 1, checkpoint = null, latest = null, current = 0, stopping = false, searching = false;
let runId = null, lastSave = 0, savedAt = null, saveError = false, port = null, seq = 0;

async function saveProgress(generation) {
  if (!runId || !checkpoint) return;
  lastSave = Date.now();
  try {
    const saved = await FightingProgress.save(runId, checkpoint);
    if (generation === current) { savedAt = saved; saveError = !saved; }
  } catch (error) {
    console.warn('Could not save fighting search progress:', error);
    if (generation === current) saveError = true;
  }
}

// setTimeout(0) is clamped to 4 ms once nested; a message round trip isn't.
const channel = new MessageChannel();
const yieldToMessages = () => new Promise(resolve => {
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(null);
});

// The frontier is already slim (the page re-evaluates the builds it shows).
// The checkpoint stays here: posting it would copy every id seen so far.
// Picks are the merge's to make.
const post = (running, extra = {}) => {
  if (!latest) return;
  const { frontier, infeasible, metadata } = latest;
  const result = { frontier, infeasible, metadata };
  seq += 1;
  port?.postMessage({ seed, seq, result });
  self.postMessage({ seq, meta: { metadata, infeasible, count: frontier.length }, result: port ? undefined : result,
    running, savedAt, saveError, ...extra });
};

self.onmessage = async ({ data, ports }) => {
  if (data.port) { port = ports[0]; return; }
  if (data.direct) { port = null; post(searching); return; }
  if (data.stop) { stopping = true; return; }
  if (data.restore) {
    snapshot = data.snapshot; seed = data.seed; runId = data.runId;
    try {
      const stored = await FightingProgress.loadCheckpoint(seed);
      if (!stored) throw new Error('No saved checkpoint.');
      latest = FightingSearch.fromCheckpoint(snapshot, stored.checkpoint);
      checkpoint = stored.checkpoint; savedAt = stored.savedAt; saveError = false; lastSave = Date.now();
    } catch (error) {
      self.postMessage({ restoreError: error.message || String(error) });
      return;
    }
    post(false, { restored: true });
    return;
  }
  const my = ++current;
  stopping = false; searching = true;
  if (data.snapshot) {
    snapshot = data.snapshot; seed = data.seed; checkpoint = data.checkpoint || null;
    runId = data.runId; lastSave = Date.now(); savedAt = null; saveError = false;
  }
  const target = data.depth ?? Infinity;
  let rounds = 1, lastPost = -Infinity;
  while ((checkpoint?.depth || 0) < target) {
    const t = performance.now(), at = checkpoint?.depth || 0;
    latest = FightingSearch.search(snapshot, { seed, depth: at + Math.min(rounds, target - at), checkpoint });
    checkpoint = latest.checkpoint;
    rounds = Math.max(1, Math.round(rounds * SLICE_MS / Math.max(1, performance.now() - t)));
    if (latest.infeasible.length) break;
    if (performance.now() - lastPost > POST_MS) { lastPost = performance.now(); post(true); }
    if (Date.now() - lastSave >= 5000) await saveProgress(my);
    if (my !== current) return;
    await yieldToMessages();
    if (my !== current || stopping || Date.now() >= data.until) break;
  }
  if (my !== current) return;
  await saveProgress(my);
  if (my !== current) return;
  searching = false;
  post(false);
};
