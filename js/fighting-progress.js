/* Latest fighting search, stored separately from saved builds. Only the
 * input snapshot and checkpoints persist; calculation caches rebuild.
 * Page and workers use the same store. A run id prevents an older tab or
 * worker from overwriting the search that most recently claimed it. */
const FightingProgress = (() => {
  const DB = 'fb-search-progress';
  const STORE = 'progress';
  let connection;

  function open() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Search storage is blocked by another tab.'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }

  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Search storage transaction was aborted.'));
      try { work(tx.objectStore(STORE), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  // Replaces only the latest search. Saved build snapshots are untouched.
  function begin(run) {
    return transaction('readwrite', (store) => {
      store.clear();
      store.put({ ...run, version: 2 }, 'run');
    });
  }

  function save(runId, checkpoint) {
    return transaction('readwrite', (store, done) => {
      const request = store.get('run');
      request.onsuccess = () => {
        if (request.result?.id !== runId) { done(null); return; }
        const key = `seed:${checkpoint.seed}`;
        const previous = store.get(key);
        previous.onsuccess = () => {
          if (previous.result?.checkpoint.depth > checkpoint.depth) {
            done(previous.result.savedAt);
            return;
          }
          const savedAt = new Date().toISOString();
          store.put({ checkpoint, savedAt }, key);
          done(savedAt);
        };
      };
    });
  }

  // The run alone and which seeds have a checkpoint, without reading them:
  // each search worker reads its own (loadCheckpoint), so the seen ids never
  // pass through the page.
  function loadRun() {
    return transaction('readonly', (store, done) => {
      let run;
      const meta = store.get('run');
      meta.onsuccess = () => { run = meta.result; };
      const keys = store.getAllKeys();
      keys.onsuccess = () => done(run ? {
        run,
        seeds: keys.result.filter(k => typeof k === 'string' && k.startsWith('seed:')).map(k => +k.slice(5)).sort((a, b) => a - b),
      } : null);
    });
  }
  function loadCheckpoint(seed) {
    return transaction('readonly', (store, done) => {
      const request = store.get(`seed:${seed}`);
      request.onsuccess = () => done(request.result || null);
    });
  }

  return { begin, save, loadRun, loadCheckpoint };
})();
