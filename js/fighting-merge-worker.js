/*
 *  FIGHTING MERGE WORKER
 *  Merges the search workers' frontiers off the page's thread. One per
 *  search run. Each search worker sends its results here on a port of its
 *  own, numbered; the page asks for a merge naming the numbers it has seen,
 *  and the merge waits until those have arrived.
 *
 *  In:  { snapshot }                 the run's snapshot (first message)
 *       { port: true } + a MessagePort  one search worker's results
 *       { seed, seq, result }        a result the page found itself
 *       { merge: id, want: { [seed]: seq } }  merge every latest result
 *                                    once each named seq has arrived
 *  Out: { merge: id, result }        merge()'s result, or null with none
 */
importScripts(...['sp-advisor-core.js', 'fighting-core.js', 'fighting-search.js']
  .map(f => f + self.location.search));

let snapshot = null;
const latest = new Map();   // seed → { seq, result }
const queue = [];           // merge requests, answered in order

function offer({ seed, seq, result }) {
  if ((latest.get(seed)?.seq || 0) < seq) latest.set(seed, { seq, result });
  pump();
}

function pump() {
  while (queue.length) {
    const { merge, want } = queue[0];
    if (!Object.entries(want).every(([seed, seq]) => (latest.get(+seed)?.seq || 0) >= seq)) return;
    queue.shift();
    const results = [...latest.values()].map(l => l.result);
    self.postMessage({ merge, result: results.length ? FightingSearch.merge(snapshot, results) : null });
  }
}

self.onmessage = ({ data, ports }) => {
  if (data.snapshot) { snapshot = data.snapshot; return; }
  if (data.port) { ports[0].onmessage = (e) => offer(e.data); return; }
  if (data.merge != null) { queue.push(data); pump(); return; }
  offer(data);
};
