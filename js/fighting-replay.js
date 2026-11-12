/*
 *  FIGHTING SEARCH REPLAY
 *  A search's inputs as a file: the snapshot it ran against and each
 *  seed's completed rounds. The search is deterministic in those, so
 *  running each seed to the same rounds gives the same builds, provided
 *  the model and search versions match. The snapshot hash catches a file
 *  edited after saving; the frontier fingerprint confirms the outcome.
 */
const FightingReplay = (() => {
  const node = typeof module !== 'undefined' && module.exports;
  const Core = node ? require('./fighting-core.js') : FightingCore;
  const Search = node ? require('./fighting-search.js') : FightingSearch;
  const KIND = 'warera-fighting-search';
  const VERSION = 1;

  const fingerprint = (result) => Search.hash(Search.stable(result.frontier.map(c => c.id)));

  // searches: [{ seed, depth }], one per seed, as completed.
  function create(snapshot, result, searches) {
    const m = result.metadata;
    return {
      kind: KIND, version: VERSION, savedAt: new Date().toISOString(),
      by: snapshot.profile.username ?? null,
      modelVersion: m.modelVersion, searchVersion: m.searchVersion, snapshotHash: m.snapshotHash,
      searches: searches.map(({ seed, depth }) => ({ seed, depth })),
      evaluated: m.evaluated, frontier: fingerprint(result),
      snapshot,
    };
  }

  const whole = (n, min) => Number.isSafeInteger(n) && n >= min;

  // The file and what differs from this page: { file, checks } where each
  // check is { key, ok, saved, here }. Throws on anything not a replay file.
  function read(text) {
    let file;
    try { file = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
    if (file?.kind !== KIND) throw new Error('This is not a saved search. Saved builds import under Saved snapshots.');
    if (file.version !== VERSION) throw new Error('This saved search is from a different version of this tool.');
    if (!file.snapshot?.profile || !Array.isArray(file.searches) || !file.searches.length
      || !file.searches.every(x => whole(x?.seed, 0) && whole(x?.depth, 1))
      || new Set(file.searches.map(x => x.seed)).size !== file.searches.length) {
      throw new Error('This saved search is incomplete or damaged.');
    }
    const checks = [
      { key: 'inputs', saved: file.snapshotHash, here: Search.hash(Search.stable(file.snapshot)) },
      { key: 'model', saved: file.modelVersion, here: Core.MODEL_VERSION },
      { key: 'search', saved: file.searchVersion, here: Search.SEARCH_VERSION },
    ].map(c => ({ ...c, ok: c.saved === c.here }));
    return { file, checks };
  }

  // Whether a replay found what the saved search did.
  const matches = (file, result) => result.metadata.evaluated === file.evaluated && fingerprint(result) === file.frontier;

  return { create, read, matches };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingReplay;
