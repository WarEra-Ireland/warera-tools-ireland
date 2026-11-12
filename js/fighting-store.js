/*
 *  FIGHTING SNAPSHOT STORE  (saved builds)
 *  A saved snapshot keeps one build: its strategy (skills, gear rolls,
 *  consumables, pill), a name, when it was saved and who made it. It
 *  carries no prices, settings or results: the page values every saved
 *  build afresh from the market data and settings it has loaded, so
 *  reloading the page is what brings a snapshot up to date. Snapshots
 *  live in the browser, export and import as JSON, and are never dropped
 *  by later settings, constraints, searches or dominance.
 *
 *  Everything here is pure except load/persist, which use localStorage.
 */
const FightingStore = (() => {
  const inNode = typeof module !== 'undefined' && module.exports;
  const Core = inNode ? require('./fighting-core.js') : FightingCore;
  const FORMAT = 'warera-fighting-snapshots';
  const VERSION = 2;
  const STORAGE_KEY = 'fb-saved-snapshots';

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  }

  // Entries are plain JSON from the start, so export and import are exact.
  const json = (v) => JSON.parse(JSON.stringify(v));

  // A strategy without the prices a hand-entered or shared roll may carry.
  function unpriced(strategy) {
    const out = json(strategy);
    for (const equipment of [out.equipment, out.debuff?.equipment]) {
      for (const ref of Object.values(equipment || {})) if (ref) delete ref.price;
    }
    return out;
  }

  function createEntry(strategy, { savedAt, name = '', by = null } = {}) {
    const s = unpriced(strategy);
    return { id: `${savedAt}|${fnv(JSON.stringify(s))}`, name, savedAt, by, modelVersion: Core.MODEL_VERSION, strategy: s };
  }

  const addEntry = (entries, entry) => [...entries, entry];
  const removeEntry = (entries, id) => entries.filter(e => e.id !== id);
  const replaceEntry = (entries, entry) => entries.map(e => e.id === entry.id ? entry : e);
  // Imported entries join after the existing ones; an id already kept stays as it is.
  const mergeEntries = (entries, incoming) =>
    [...entries, ...incoming.filter((e, i) => !entries.some(x => x.id === e.id) && incoming.findIndex(x => x.id === e.id) === i)];

  const exportEntries = (entries) => JSON.stringify({ format: FORMAT, version: VERSION, entries }, null, 2);
  function importEntries(text) {
    const data = JSON.parse(text);
    if (data?.format !== FORMAT || !Array.isArray(data.entries)) throw new Error('This file is not a fighting build snapshot export.');
    if (data.version > VERSION) throw new Error('This export comes from a newer version of the optimiser.');
    if (data.version !== VERSION) throw new Error('This export comes from an older version of the optimiser.');
    for (const e of data.entries) {
      if (!e?.id || !e.strategy) throw new Error('The export has a malformed snapshot.');
    }
    return data.entries;
  }

  function persist(entries) {
    try { localStorage.setItem(STORAGE_KEY, exportEntries(entries)); return true; } catch { return false; }
  }
  function load() {
    try { return importEntries(localStorage.getItem(STORAGE_KEY) || exportEntries([])); } catch { return []; }
  }

  return { createEntry, addEntry, removeEntry, replaceEntry, mergeEntries,
           exportEntries, importEntries, load, persist };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FightingStore;
