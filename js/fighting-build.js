/*
 *  FIGHTING BUILD OPTIMISER  (page)
 *  Loads a player into a frozen input snapshot (fighting-snapshot.js),
 *  searches builds with fighting-search.js a few rounds at a time, and
 *  shows the role picks, charts of the frontier, the selected build's
 *  figures and ledger (fighting-core.js), and saved snapshots
 *  (fighting-store.js).
 *
 *  The search is deterministic for a snapshot, seed and depth; this page
 *  owns the clock: about fifteen seconds for initial results, about two
 *  minutes more on "Search longer", and Stop keeps every completed round.
 *  It runs one search per spare core in fighting-search-worker.js, each
 *  from its own seed, and merges them; or one here in slices where a worker can't
 *  start (a page opened from file://).
 *
 *  Access: restricted to Irish citizens (enforceIrishOnly from shared.js).
 */
const FightingBuildTool = (() => {
  const $username = document.getElementById('fb-username');
  const $go       = document.getElementById('fb-go');
  const $hint     = document.getElementById('fb-hint');
  const $out      = document.getElementById('fb-out');
  const $replay   = document.getElementById('fb-replay');
  // A stalled load can be replaced: handleSubmit drops a replaced one's results.
  const steps     = makeSteps(document.getElementById('fb-steps'),
    { onStall: () => { $go.disabled = false; }, retryHint: 'Press Load to start again.' });
  const restoreSteps = makeSteps(document.getElementById('fb-restore-steps'), { retryHint: 'Load your player to start a new search.' });
  const setStatus = makeStatus(document.getElementById('fb-status'));

  // Benchmarked: most of what searching longer finds comes in the first
  // 15 s, and past about 2 min more, each extra minute gains little.
  const INITIAL_MS = 15000;
  const LONGER_MS = 120000;
  const SLICE_MS = 80;          // work between yields to the page, without a worker
  // The workers load their scripts with this query: bump it when any change.
  const WORKER_URL = 'js/fighting-search-worker.js?w=20261112';
  const MERGE_URL = 'js/fighting-merge-worker.js?w=20261112';
  const SEED = 1;                // the first worker's; each next one's is one more
  const MAX_WORKERS = 4;         // more gained little, and hurt where cores are fewer than reported
  const GRACE_MS = 400;         // past the deadline, before the page stops waiting
  const MANUAL_KEY = 'fb-manual-builds';   // { [userId]: strategy }, one draft per player

  const SKILL_LABEL = {
    attack: 'Attack', precision: 'Precision', criticalChance: 'Critical chance', criticalDamages: 'Critical damage',
    armor: 'Armor', dodge: 'Dodge', health: 'Health', hunger: 'Hunger', lootChance: 'Loot chance',
    energy: 'Energy', stamina: 'Stamina', companies: 'Companies',
    production: 'Production', management: 'Management',
  };
  const SLOT_LABEL = { weapon: 'Weapon', helmet: 'Helmet', chest: 'Chest', gloves: 'Gloves', pants: 'Pants', boots: 'Boots' };
  const BASIS_LABEL = { 'pre-buyer-tax': 'before buyer tax', untaxed: 'no market tax', 'tax-inclusive': 'tax-inclusive', 'seller-proceeds': 'seller proceeds', unknown: 'unknown basis' };
  const PHASE_LABEL = { unpilled: 'Unpilled', buff: 'Buff phase', debuff: 'Debuff companion' };

  // market: the snapshot as loaded or refreshed; settings are layered on
  // to make the snapshot a search runs against.
  let market = null;
  let settings = {};
  let saved = FightingStore.load();
  let run = null;          // { snapshot, result, running, stop, searches, ... }
  let selectedId = null;
  const shown = new Set();  // ids of saved snapshots plotted on the chart
  let savedRun = null;      // the run the saved table was last drawn for
  let shopDays = 1;         // the period the shopping list covers
  // What a pilled build's hold days may spend: 'same' as the build before
  // pills, or 'pill', that plus what the pills would cost. Kept in the browser.
  const HOLD_KEY = 'fb-hold-budget';
  let holdBudget = (() => { try { return localStorage.getItem(HOLD_KEY) === 'pill' ? 'pill' : 'same'; } catch { return 'same'; } })();
  let shopOwnGear = false;  // whether the selected build's gear is already owned
  let renaming = null;      // id of the saved snapshot whose name is being edited
  let pendingShare = null;  // a shared build from the URL, waiting for a player to be loaded
  let manual = null;        // the player's hand-entered strategy, as applied (fighting-compare.js)
  let edit = null;          // the editor's working copy of it, not yet applied
  let compare = { a: 'manual', b: 'selected' };   // the two builds the comparison shows
  let token = 0;
  // A search read from a file: { file, checks, started }. From the moment it
  // starts until "Back to your search", nothing searched is saved, so the
  // player's own search stays stored.
  let replay = null;

  function readManualStore() {
    try { const o = JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
    catch { return {}; }
  }
  function writeManual() {
    try { localStorage.setItem(MANUAL_KEY, JSON.stringify({ ...readManualStore(), [market.profile.userId]: manual })); } catch {}
  }

  // The snapshot a run uses: market prices, the session's settings, and
  // the clock that judges freshness.
  function currentSnapshot() {
    const s = FightingSnapshot.withSettings(market, settings);
    return Object.freeze({ ...s, asOf: new Date().toISOString() });
  }

  // --- Formatting ---
  // A formatter per precision, made once: toLocaleString with options makes
  // a new one on every call, tens of times slower over many figures.
  const coinFormats = new Map();
  const coinFormat = (dp) => coinFormats.get(dp)
    || coinFormats.set(dp, new Intl.NumberFormat(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })).get(dp);
  const coins = (v, dp = 2) => v == null ? '—' : `${v < 0 ? '−' : ''}₿${coinFormat(dp).format(Math.abs(v))}`;
  const signed = (v, dp = 2) => v == null ? '—' : `${v > 0 ? '+' : ''}${coins(v, dp)}`;
  const dmg = (v) => v == null ? '—' : fmtNum(Math.round(v));
  const itemName = (code) => ProfitCore.META[code]?.name || code;
  // Gear as the game draws it: the item's own picture on a slot tile
  // tinted by rarity. Armour pictures are per slot, not per tier, so the
  // tint and the rarity named beside it carry the tier.
  const STAT_SHORT = { attack: 'Attack', precision: 'Precision', criticalChance: 'Crit chance', criticalDamages: 'Crit damage',
                       armor: 'Armor', dodge: 'Dodge', lootChance: 'Loot' };
  const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const gearName = (e) => e.slot === 'weapon' ? cap(e.code) : SLOT_LABEL[e.slot];
  const gearImage = (e) => `images/${e.slot === 'weapon' ? e.code : e.slot}.png`;
  // An empty slot's outline: the slot's picture, a gun for the weapon.
  const emptySlotImage = (slot) => `images/${slot === 'weapon' ? 'gun' : slot}.png`;
  const statLine = (stats) => Object.entries(stats).map(([k, v]) => `+${v} ${STAT_SHORT[k] || SKILL_LABEL[k] || k}`).join(', ');
  const rarityOf = (e) => RARITIES.includes(e.rarity) ? e.rarity : null;
  const gearTile = (e) => {
    const rarity = rarityOf(e);
    return `<span class="fb-slot ${rarity ? `fb-rar-${rarity}` : ''}"
      title="${escapeHtml(`${rarity ? cap(rarity) + ' ' : ''}${gearName(e).toLowerCase()}: ${statLine(e.stats)}`)}">
      <img src="${gearImage(e)}" alt="${escapeHtml(gearName(e))}" loading="lazy"></span>`;
  };
  // A tile with its name, rarity and stats beside it.
  const gearCard = (e) => {
    const rarity = rarityOf(e);
    return `<span class="fb-gear ${rarity ? `fb-rar-${rarity}` : ''}">${gearTile(e)}
      <span class="fb-gear-text"><span class="fb-gear-name">${escapeHtml(gearName(e))}
        <span class="fb-gear-rarity">${rarity ? cap(rarity) : 'Unknown rarity'}</span></span>
        <span class="fb-gear-stats">${Object.entries(e.stats).map(([k, v]) =>
          `<span><b>+${v}</b> ${escapeHtml(STAT_SHORT[k] || SKILL_LABEL[k] || k)}</span>`).join('')}</span></span></span>`;
  };

  // Consumables and loot drawn like gear: the game's picture on its rarity colour.
  const itemTile = (code) => {
    const r = market.config.rarities?.[code] ?? market.config.items[code]?.rarity, rarity = RARITIES.includes(r) ? r : null;
    return `<span class="fb-slot fb-slot-sm ${rarity ? `fb-rar-${rarity}` : ''}" title="${escapeHtml(itemName(code))}">
      <img src="images/${encodeURIComponent(code)}.png" alt="" loading="lazy" onerror="this.remove()"></span>`;
  };
  // The game's pill, inline wherever a build is labelled pilled.
  const PILL_ICON = '<img class="fb-pill-icon" src="images/cocain.png" alt="" loading="lazy" onerror="this.remove()">';
  const pilledTag = `<span class="fb-tag fb-tag-pilled">${PILL_ICON}pilled</span>`;
  const itemCard = (code) => `<span class="fb-gear fb-item">${itemTile(code)}<span class="fb-gear-name">${escapeHtml(itemName(code))}</span></span>`;

  // Skills as the game's skills page lays them out: its two groups and
  // order, each skill in its own colour, levels as a row of segments.
  const SKILL_GROUPS = [
    ['Fight', ['attack', 'precision', 'criticalChance', 'criticalDamages', 'armor', 'dodge', 'health', 'lootChance', 'hunger']],
    ['Economic', ['energy', 'production', 'companies', 'management']],
  ];
  const SKILL_COLOUR = { attack: 'orange', precision: 'orange', criticalChance: 'red', criticalDamages: 'red', armor: 'gray',
    dodge: 'gray', health: 'green', lootChance: 'lightgreen', hunger: 'deeporange', energy: 'blue',
    production: 'amber', companies: 'amber', management: 'purple' };
  const SKILL_UNIT = { criticalChance: '%', criticalDamages: '%', precision: '%', lootChance: '%' };
  // The game's own skill icons (24-unit paths from app.warera.io), drawn in
  // the skill's colour on a tinted badge, as its skill tiles are.
  const SKILL_ICON = {
    attack: 'M18.8025 2.44L6.9025 14.34L4.7825 12.22L3.3725 13.63L5.8425 16.1L2.6625 19.28C2.2725 19.67 2.2725 20.3 2.6625 20.69L3.3725 21.4C3.7625 21.79 4.3925 21.79 4.7825 21.4L8.0025 18.23L10.4425 20.7L11.8525 19.29L9.7325 17.17L21.6325 5.27V2.44H18.8025Z',
    precision: 'M19.5,3.09L20.91,4.5L16.41,9H20V11H13V4H15V7.59L19.5,3.09M20.91,19.5L19.5,20.91L15,16.41V20H13V13H20V15H16.41L20.91,19.5M4.5,3.09L9,7.59V4H11V11H4V9H7.59L3.09,4.5L4.5,3.09M3.09,19.5L7.59,15H4V13H11V20H9V16.41L4.5,20.91L3.09,19.5Z',
    criticalChance: 'M4.35 21H21V4.35L17.85 12L15.5 5L14.25 10.2L3 3L10.2 14.25L4.5 15.5L12 17.85L4.35 21Z',
    criticalDamages: 'M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12C22,10.84 21.79,9.69 21.39,8.61L19.79,10.21C19.93,10.8 20,11.4 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4C12.6,4 13.2,4.07 13.79,4.21L15.4,2.6C14.31,2.21 13.16,2 12,2M19,2L15,6V7.5L12.45,10.05C12.3,10 12.15,10 12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12C14,11.85 14,11.7 13.95,11.55L16.5,9H18L22,5H19V2M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12H16A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8V6Z',
    armor: 'M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1Z',
    dodge: 'M16.5,5.5A2,2 0 0,0 18.5,3.5A2,2 0 0,0 16.5,1.5A2,2 0 0,0 14.5,3.5A2,2 0 0,0 16.5,5.5M12.9,19.4L13.9,15L16,17V23H18V15.5L15.9,13.5L16.5,10.5C17.89,12.09 19.89,13 22,13V11C20.24,11.03 18.6,10.11 17.7,8.6L16.7,7C16.34,6.4 15.7,6 15,6C14.7,6 14.5,6.1 14.2,6.1L9,8.3V13H11V9.6L12.8,8.9L11.2,17L6.3,16L5.9,18L12.9,19.4M4,9A1,1 0 0,1 3,8A1,1 0 0,1 4,7H7V9H4M5,5A1,1 0 0,1 4,4A1,1 0 0,1 5,3H10V5H5M3,13A1,1 0 0,1 2,12A1,1 0 0,1 3,11H7V13H3Z',
    health: 'M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z',
    lootChance: 'M5,4H19A3,3 0 0,1 22,7V11H15V10H9V11H2V7A3,3 0 0,1 5,4M11,11H13V13H11V11M2,12H9V13L11,15H13L15,13V12H22V20H2V12Z',
    hunger: 'M11,9H9V2H7V9H5V2H3V9C3,11.12 4.66,12.84 6.75,12.97V22H9.25V12.97C11.34,12.84 13,11.12 13,9V2H11V9M16,6V14H18.5V22H21V2C18.24,2 16,4.24 16,6Z',
    energy: 'M11 15H6L13 1V9H18L11 23V15Z',
    production: 'M14.79,10.62L3.5,21.9L2.1,20.5L13.38,9.21L14.79,10.62M19.27,7.73L19.86,7.14L19.07,6.35L19.71,5.71L18.29,4.29L17.65,4.93L16.86,4.14L16.27,4.73C14.53,3.31 12.57,2.17 10.47,1.37L9.64,3.16C11.39,4.08 13,5.19 14.5,6.5L14,7L17,10L17.5,9.5C18.81,11 19.92,12.61 20.84,14.36L22.63,13.53C21.83,11.43 20.69,9.47 19.27,7.73Z',
    management: 'M12 3C14.21 3 16 4.79 16 7S14.21 11 12 11 8 9.21 8 7 9.79 3 12 3M16 13.54C16 14.6 15.72 17.07 13.81 19.83L13 15L13.94 13.12C13.32 13.05 12.67 13 12 13S10.68 13.05 10.06 13.12L11 15L10.19 19.83C8.28 17.07 8 14.6 8 13.54C5.61 14.24 4 15.5 4 17V21H20V17C20 15.5 18.4 14.24 16 13.54Z',
    stamina: 'M16.5,5.5A2,2 0 0,0 18.5,3.5A2,2 0 0,0 16.5,1.5A2,2 0 0,0 14.5,3.5A2,2 0 0,0 16.5,5.5M12.9,19.4L13.9,15L16,17V23H18V15.5L15.9,13.5L16.5,10.5C17.89,12.09 19.89,13 22,13V11C20.24,11.03 18.6,10.11 17.7,8.6L16.7,7C16.34,6.4 15.7,6 15,6C14.7,6 14.5,6.1 14.2,6.1L9,8.3V13H11V9.6L12.8,8.9L11.2,17L6.3,16L5.9,18L12.9,19.4M4,9A1,1 0 0,1 3,8A1,1 0 0,1 4,7H7V9H4M5,5A1,1 0 0,1 4,4A1,1 0 0,1 5,3H10V5H5M3,13A1,1 0 0,1 2,12A1,1 0 0,1 3,11H7V13H3Z',
    companies: 'M4,18V20H8V18H4M4,14V16H14V14H4M10,18V20H14V18H10M16,14V16H20V14H16M16,18V20H20V18H16M2,22V8L7,12V8L12,12V8L17,12L18,2H21L22,12V22H2Z',
  };
  const skillIcon = (name) => SKILL_ICON[name] ? `<span class="fb-sk-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SKILL_ICON[name]}"/></svg></span>` : '';
  function skillsHtml(snapshot, result) {
    const row = (name) => {
      const s = result.effectiveSkills[name];
      if (!s) return '';
      const max = (snapshot.config.skills[name]?.values.length || 11) - 1;
      const prestigeLevels = s.level - s.ordinary;
      const current = snapshot.profile.currentSkills?.[name] ?? null;
      const segments = Array.from({ length: Math.max(max, s.level) }, (_, i) => {
        const level = i + 1;
        const cls = level <= s.ordinary ? 'on' : level <= s.level ? 'prestige' : '';
        return `<span class="fb-seg ${cls}${level > max ? ' over' : ''}"></span>`;
      }).join('');
      const change = current == null || current === s.ordinary ? ''
        : `<span class="fb-skill-change ${s.ordinary > current ? 'up' : 'down'}">${current} → ${s.ordinary}</span>`;
      return `<div class="fb-skill fb-sk-${SKILL_COLOUR[name] || 'gray'}">
        <div class="fb-skill-head">${skillIcon(name)}<span class="fb-skill-value">${fmt(s.value, Number.isInteger(s.value) ? 0 : 1)}${SKILL_UNIT[name] || ''}</span>
          <span class="fb-skill-name">${SKILL_LABEL[name]}</span>
          <span class="fb-skill-level">level ${s.level}${prestigeLevels ? ` <span class="fb-tag">+${prestigeLevels} prestige</span>` : ''}${
            s.strategic ? ` <span class="fb-tag" title="From your country's strategic resources">+${fmt(s.strategic, 0)} strategic</span>` : ''}</span>${change}</div>
        <div class="fb-segs" role="img" aria-label="${SKILL_LABEL[name]} level ${s.level} of ${max}">${segments}</div></div>`;
    };
    return `<div class="fb-skill-groups">${SKILL_GROUPS.map(([title, names]) => `
      <section class="fb-skill-group"><h4>${title}</h4>${names.map(row).join('')}</section>`).join('')}</div>`;
  }

  const when = (iso) => iso ? new Date(iso).toLocaleString() : '—';
  // Gear priced by hand in Your build: rolls nobody has sold recently. A
  // search result's summary lists no prices, and never has hand prices.
  const handPriced = (result) => (result.prices || []).filter(p => p.role === 'equipment' && p.source === 'manual' && p.value != null).length;
  const handTag = (n) => n ? `<span class="fb-tag fb-tag-own" title="Gear with no recent sales, priced at what you entered">${
    n} hand-entered price${n === 1 ? '' : 's'}</span>` : '';
  const flags = (c) => [
    c.result.pilled ? pilledTag : '',
    c.result.complete ? '' : '<span class="fb-tag fb-tag-warn">incomplete</span>',
    c.result.stale ? '<span class="fb-tag fb-tag-warn">stale prices</span>' : '',
    c.overBudget ? '<span class="fb-tag fb-tag-warn">over budget</span>' : '',
    c.entry ? `<span class="fb-tag">${c.entry.manual ? 'saved manual build' : 'saved snapshot'}</span>` : '',
    c.manual ? '<span class="fb-tag">your build, entered by hand</span>' : '',
    handTag(handPriced(c.result)),
  ].join(' ');

  // --- Collapsible sections ---
  // Each opens as the player last left it, else as its default. The summary
  // gives an overview of what's folded away, { head, detail }: the headline
  // figure, kept on one line at the right, and the detail behind it, which a
  // phone leaves out. One that changes without its section redrawing is
  // updated by id (fb-fold-sum-<id>).
  const FOLDS_KEY = 'fb-folds';
  const folds = (() => { try { return JSON.parse(localStorage.getItem(FOLDS_KEY) || '{}') || {}; } catch { return {}; } })();
  const foldSum = ({ head = '', detail = '' } = {}) =>
    `<span class="fb-fold-detail">${detail}</span><span class="fb-fold-head">${head}</span>`;
  const unit = (text) => `<span class="fb-fold-unit">${text}</span>`;
  const foldAttrs = (id, open) => `data-fb-fold="${id}" ${folds[id] ?? open ? 'open' : ''}`;
  const fold = (id, title, overview, body, { open = false, on = false, help = '' } = {}) => `
    <details class="fb-fold${on ? ' fb-fold-on' : ''}${help ? ' fb-has-help' : ''}" ${foldAttrs(id, open)}>
      <summary><span class="fb-fold-title">${title}</span><span class="fb-fold-sum" id="fb-fold-sum-${id}">${foldSum(overview)}</span>${
        help ? helpHtml(title, help) : ''}</summary>
      <div class="fb-fold-body">${body}</div></details>`;
  // Left alone when unchanged: a drag redraws its summary every frame.
  const setFoldSummary = (id, overview) => {
    const el = document.getElementById(`fb-fold-sum-${id}`), html = foldSum(overview);
    if (el && el.fbHtml !== html) { el.innerHTML = html; el.fbHtml = html; }
  };

  // --- Section help ---
  // A section's longer explanation waits behind the shared help button in
  // its top-right corner. In a fold it sits in the summary so it works while
  // the section is folded, and its clicks are kept from toggling the section.
  const helpHtml = (title, html) => sectionHelp(`About ${title.replace(/<[^>]*>/g, '')}`, html);
  document.addEventListener('click', e => { if (e.target.closest('#fb-out summary .section-help')) e.preventDefault(); });
  // Success shows on the section it changed, opened and briefly highlighted,
  // rather than as a message left at the top of the page.
  function flashFold(id, { scroll = false } = {}) {
    const d = $out.querySelector(`details[data-fb-fold="${id}"]`);
    if (!d) return;
    d.open = true;
    d.classList.remove('fb-flash');
    void d.offsetWidth;   // restart the highlight when it's already running
    d.classList.add('fb-flash');
    if (scroll) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $out.addEventListener('toggle', e => {
    const id = e.target.dataset?.fbFold;
    if (!id || folds[id] === e.target.open) return;
    folds[id] = e.target.open;
    try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)); } catch {}
  }, true);
  // On narrow screens a wide table stacks each row as a card (styles.css),
  // so every cell is labelled with its column. Only the selected build's
  // section has such tables, so it labels them as it draws.
  function labelStacks(root) {
    for (const table of root.querySelectorAll('table.fb-stack')) {
      const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      for (const tr of table.querySelectorAll('tbody tr')) {
        [...tr.cells].forEach((td, i) => { if (heads[i] && td.colSpan === 1) td.dataset.label = heads[i]; });
      }
    }
  }
  // Net a day, as earning or losing.
  const net = (v) => v == null ? 'net —' : v >= 0 ? `earns ${coins(v)}/day` : `loses ${coins(-v)}/day`;

  // --- Layout ---
  function renderShell() {
    $out.innerHTML = `
      <div id="fb-setup" class="fb-setup"></div>
      <div class="fb-pin"><div id="fb-pinned" class="fb-pinned" inert></div></div>
      <div id="fb-search" class="fb-search"></div>
      <div id="fb-roles" class="fb-roles"></div>
      <div id="fb-chart-wrap" class="fb-chart-wrap"><div id="fb-charts" class="fb-charts"></div>
        <div id="fb-tooltip" class="fb-tooltip hidden" role="tooltip"></div></div>
      <div id="fb-browse"></div>
      <div id="fb-build"></div>
      <div id="fb-manual"></div>
      <div id="fb-compare"></div>
      <div id="fb-panels"></div>
      <div id="fb-saved"></div>
      <div id="fb-search-details">
        <div id="fb-search-coverage" class="fb-details hidden"></div>
        <p id="fb-progress-note" class="fb-note"></p>
      </div>
      <dialog id="fb-picker" class="fb-picker" aria-label="Choose gear"></dialog>`;
    document.getElementById('fb-picker').addEventListener('close', () => { picker = null; });
    browseEl = document.getElementById('fb-browse');
    chartWidth = 0;
    chartObserver.disconnect();
    chartObserver.observe(document.getElementById('fb-charts'));
    renderSetup();
    loadDebuff();
    renderPanels();
    renderManual();
    renderSaved();
  }

  const st = () => run?.snapshot.settings || FightingSnapshot.withSettings(market, settings).settings;

  // The two questions answered before each search, the battle and the
  // money, as cards at the top. Drawn once a load, so typing and tabbing
  // through them never loses focus.
  function renderSetup() {
    const s = st();
    document.getElementById('fb-setup').innerHTML = `
      <section class="fb-setup-card fb-has-help" data-fb-card="battle">
        <h3 class="fb-setup-title">The battle</h3>${helpHtml('The battle', `Applied alike to every build. Rank damage
          starts at your profile's military rank (${fmt(market.profile.rankDamagePct, 1)}%); change it to plan for another
          rank, or clear it to go back to your profile's. MU help is your own estimate and adds health only above zero.`)}
        <div class="fb-setup-fields fb-setup-grid">
          <label>Rank damage %<input id="fb-rank-damage" type="number" min="0" step="1"
            placeholder="${fmt(market.profile.rankDamagePct, 1)}" value="${s.rankDamagePct ?? market.profile.rankDamagePct ?? ''}"></label>
          <label>Battle-damage bonus %<input id="fb-battle-bonus" type="number" min="0" step="1" value="${+(s.battleBonus * 100).toFixed(1)}"></label>
          <label>Bounty / 1k damage<input id="fb-bounty" type="number" min="0" step="0.01" value="${s.bountyPer1000}"></label>
          <label>MU help, health / day<input id="fb-mu-help" type="number" min="0" step="1" value="${s.muHelpHealthPerDay}"></label>
        </div>
      </section>
      <section class="fb-setup-card fb-has-help" data-fb-card="money">
        <h3 class="fb-setup-title">Your money</h3>${helpHtml('Your money', `These decide the picks. Saver: the most damage
          while still saving the target each day. Self-funding: the most damage without losing money. Full spender: the most
          damage within the loss allowance; moderate spender within half of it. Pills choose which builds are searched. With
          same gear, a pilled build keeps its gear through the debuff. Stale-priced builds rest on old prices and are left
          out of the picks unless included.`)}
        <div class="fb-setup-fields">
          <label>Savings target / day<input id="fb-savings" type="number" step="10" value="${s.savingsTarget}"></label>
          <label>Loss allowance / day<input id="fb-loss" type="number" min="0" step="10" value="${s.lossAllowance}"></label>
          <label>Pills<select id="fb-pill-mode">
            <option value="both" ${s.pillMode === 'both' ? 'selected' : ''}>Compare both</option>
            <option value="unpilled" ${s.pillMode === 'unpilled' ? 'selected' : ''}>Unpilled only</option>
            <option value="pilled" ${s.pillMode === 'pilled' ? 'selected' : ''}>Pilled only</option></select></label>
        </div>
        <div class="fb-controls">
          <label class="fb-toggle"><input id="fb-same-gear" type="checkbox" ${s.sameGearBothPhases ? 'checked' : ''}> Same gear in both pill phases</label>
          <label class="fb-toggle"><input id="fb-include-stale" type="checkbox" ${s.includeStale ? 'checked' : ''}> Include stale-priced builds in picks</label>
        </div>
      </section>
      <div id="fb-active" class="fb-note fb-setup-active"></div>`;
    renderSetupSummary();
    // Once the cards scroll away, a one-line summary pins in their place.
    pinObserver?.disconnect();
    pinObserver = new IntersectionObserver(([e]) => {
      const pinned = !e.isIntersecting && e.boundingClientRect.top < 0;
      const el = document.getElementById('fb-pinned');
      el?.classList.toggle('fb-shown', pinned);
      if (el) el.inert = !pinned;
    });
    pinObserver.observe(document.getElementById('fb-setup'));
  }
  let pinObserver = null;

  // A summary chip; the title, when given, holds the detail the chip leaves out.
  const pinChip = (html, title = '') =>
    `<span class="fb-pin-chip"${title ? ` title="${escapeHtml(title)}"` : ''}>${html}</span>`;
  // A chip that jumps to where its setting is changed: a fold, or a setup card
  // (and its field, when the chip shows only one). Outlined while a constraint
  // is in force.
  const goChip = (html, go, { on = false, focus = '', title = '' } = {}) =>
    `<button type="button" class="fb-pin-chip fb-pin-go${on ? ' fb-pin-on' : ''}" data-fb-go="${go}"${
      focus ? ` data-fb-focus="${focus}"` : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${html}</button>`;

  // Every active constraint under the cards, and the pinned line.
  let summaryLedger = false;   // whether the summary was drawn with the ledger shown
  function renderSetupSummary() {
    const s = st();
    const locks = Object.entries(s.skillLocks || {}).filter(([, l]) => l != null)
      .map(([k, l]) => `${SKILL_LABEL[k] || k} ${l}${k === 'companies' ? ` (${companyCount(l)} companies)` : ''}`);
    const incomeOff = Object.entries(s.incomeToggles).filter(([, on]) => !on).map(([k]) => k);
    const incomeHtml = `<span>income off</span> ${escapeHtml(incomeOff.join(', '))}`;
    // The income toggles live in the build's ledger, which exists only while a
    // build is shown; until then the chip has nowhere to go.
    const ledgerShown = summaryLedger = !!document.querySelector('[data-fb-fold="ledger"]');
    const active = [
      locks.length ? goChip(`${PADLOCK(true)}${locks.length} <span class="fb-pin-word">${locks.length === 1 ? 'skill' : 'skills'} locked</span>`,
        'locks', { on: true, title: locks.join(', ') })
        : goChip('<span>no locks</span>', 'locks'),
      s.equipmentBudget != null ? goChip(`<span>equipment ≤</span> ${coins(s.equipmentBudget, 0)} <span>(soft)</span>`, 'locks', { on: true })
        : goChip('<span>no equipment budget</span>', 'locks'),
      !incomeOff.length ? '' : ledgerShown ? goChip(incomeHtml, 'ledger', { on: true }) : pinChip(incomeHtml),
    ].join('');
    const activeEl = document.getElementById('fb-active');
    if (!activeEl) return;
    activeEl.innerHTML = active;
    const [pills, pillsTitle] = {
      both: [`${PILL_ICON}<span>both</span>`, 'Comparing pilled and unpilled builds'],
      unpilled: [`<span>no</span> ${PILL_ICON}`, 'Unpilled builds only'],
      pilled: [`${PILL_ICON}<span>only</span>`, 'Pilled builds only'],
    }[s.pillMode];
    document.getElementById('fb-pinned').innerHTML = `
      ${goChip(`<span>Battle</span> rank ${fmt(s.rankDamagePct ?? market.profile.rankDamagePct, 1)}% · bonus ${fmt(s.battleBonus * 100, 0)}% · bounty ${coins(s.bountyPer1000, 3)}/1k · MU ${s.muHelpHealthPerDay}`, 'battle')}
      <div class="fb-pin-strip">
        ${goChip(`<span>Save ≥</span> ${coins(s.savingsTarget, 0)} <span>· lose ≤</span> ${coins(s.lossAllowance, 0)}`, 'money')}
        ${goChip(pills, 'money', { focus: 'fb-pill-mode', title: pillsTitle })}
        <span class="fb-pin-rest">${active}</span>
      </div>`;
  }

  // --- Search driver ---
  function drive(ms) {
    if (run.initializing) return;
    run.running = true; run.stop = false;
    run.driveStarted = performance.now(); run.driveMs = ms;
    renderSearch();
    const live = run.searches.filter(x => x.worker);
    if (!live.length) return driveHere(ms);
    // The deadline is absolute, so worker start-up counts against it, and
    // the page stops waiting for a worker still busy shortly after it.
    const r = run, until = Date.now() + ms;
    for (const x of live) {
      x.running = true;
      x.worker.postMessage(x.sent ? { until, depth: x.target }
        : { until, depth: x.target, snapshot: r.snapshot, seed: x.seed, checkpoint: x.checkpoint, runId: r.id });
      x.sent = true;
    }
    clearTimeout(r.overrun);
    if (!Number.isFinite(ms)) return;   // a replay ends at its rounds, not a deadline
    r.overrun = setTimeout(() => {
      if (run !== r || !r.running) return;
      stopWorkers(r);
      for (const x of r.searches) x.running = false;
      finish(r);
    }, ms + GRACE_MS);
  }

  // One worker per core the page can spare, each searching from its own seed
  // (or one per saved seed), and a merge worker their results go to directly,
  // so neither the searching nor the merging holds up the page. Without the
  // merge worker, results come to the page and merge here.
  function startWorkers(r, seeds = []) {
    const n = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
    const searches = [];
    for (let i = 0; i < (seeds.length || n); i++) {
      let worker = null;
      try { worker = new Worker(WORKER_URL); } catch {}
      const x = { seed: seeds[i] ?? SEED + i, worker, result: null, meta: null, seq: 0,
        checkpoint: null, running: false, sent: false, savedAt: null };
      searches.push(x);
      if (!worker) {
        if (!seeds.length && i === 0) break;
        continue;
      }
      worker.onmessage = ({ data }) => {
        if (data.restoreError) return x.restoring?.reject(new Error(data.restoreError));
        // Kept even before a restored run is the page's: a repost after the
        // merge worker fails can arrive while the others still restore.
        x.seq = data.seq; x.meta = data.meta; x.savedAt = data.savedAt;
        if (data.result) x.result = data.result;
        if (data.restored) return x.restoring?.resolve();
        if (run !== r) return;
        x.running = data.running;
        x.checkpoint = null;
        x.saveError = data.saveError;
        if (!r.running && !data.running) show(r).then(() => { if (run === r) renderResults(); });
        else progress(r);
      };
      // A worker that can't load its scripts (or dies) drops out, keeping
      // what it found; with none left and nothing found, search here instead.
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        x.worker = null; x.running = false;
        x.restoring?.reject(new Error('The search worker failed.'));
        if (run !== r) return;
        if (r.searches.some(y => y.worker)) progress(r);
        else if (r.running) { clearTimeout(r.overrun); driveHere(r.driveMs); }
      };
    }
    if (searches.every(x => x.worker)) startMerger(r, searches);
    return searches;
  }

  function startMerger(r, searches) {
    let merger;
    try { merger = new Worker(MERGE_URL); } catch { return; }
    r.merger = merger;
    r.merges = new Map();   // request id → resolve
    merger.postMessage({ snapshot: r.snapshot });
    for (const x of searches) {
      const link = new MessageChannel();
      merger.postMessage({ port: true }, [link.port2]);
      x.worker.postMessage({ port: true }, [link.port1]);
    }
    merger.onmessage = ({ data }) => {
      r.merges.get(data.merge)?.(data.result);
      r.merges.delete(data.merge);
    };
    // Without it the workers send their results here again, and the page merges.
    merger.onerror = (e) => {
      e.preventDefault();
      merger.terminate();
      r.merger = null;
      for (const resolve of r.merges.values()) resolve(undefined);
      r.merges.clear();
      for (const x of r.searches) x.worker?.postMessage({ direct: true });
    };
  }

  // The merge worker's merge of every result up to those the page has seen;
  // undefined if it failed meanwhile.
  let mergeId = 0;
  function mergeRemote(r) {
    // Results found here (searching without workers) go to it first.
    for (const x of r.searches) {
      if (!x.local) continue;
      const { frontier, infeasible, metadata } = x.result;
      r.merger.postMessage({ seed: x.seed, seq: x.seq, result: { frontier, infeasible, metadata } });
      x.local = false;
    }
    const id = ++mergeId;
    const want = Object.fromEntries(r.searches.filter(x => x.seq).map(x => [x.seed, x.seq]));
    return new Promise(resolve => {
      r.merges.set(id, resolve);
      r.merger.postMessage({ merge: id, want });
    });
  }

  // Each worker answers a stop with its final result.
  function stopWorkers(r) {
    for (const x of r.searches) x.worker?.postMessage({ stop: true });
  }

  // A message only keeps that worker's latest result. The builds are merged
  // and drawn once every worker is done: drawing each interim best would
  // redraw the page for builds it doesn't land on. Meanwhile only the
  // search bar's count moves, at most every PROGRESS_MS however many
  // workers report.
  const PROGRESS_MS = 250;
  let progressTimer = 0;
  function progress(r) {
    if (r.running && !r.searches.some(x => x.running)) { finish(r); return; }
    if (progressTimer) return;
    progressTimer = setTimeout(() => { progressTimer = 0; if (run === r) renderSearch(); }, PROGRESS_MS);
  }

  // Searches return slim candidates: figures and flags, enough for the
  // chart, roles and browsing. A build's full result is worked out the first
  // time something reads it (withFull), from the same snapshot, so it's the
  // search's, and kept while the build stays on the frontier.
  // Merges are numbered so a slower earlier one never replaces a later one.
  async function show(r) {
    const mine = r.shown = (r.shown || 0) + 1;
    let result = r.merger ? await mergeRemote(r) : undefined;
    if (result === undefined) {
      const results = r.searches.map(x => x.result).filter(Boolean);
      result = results.length ? FightingSearch.merge(r.snapshot, results) : null;
    }
    if (!result || mine !== r.shown) return;
    r.result = result;
    const full = new Map();
    for (const c of r.result.frontier) {
      const known = r.full?.get(c.id);
      if (known) { c.result = known; full.set(c.id, known); }
    }
    r.full = full;
  }
  function withFull(c) {
    if (c && !c.result.issues && run?.full) {
      c.result = run.full.get(c.id) || FightingCore.evaluateStrategy(run.snapshot, c.strategy);
      run.full.set(c.id, c.result);
    }
    return c;
  }

  async function finish(r) {
    clearTimeout(r.overrun);
    r.running = false;
    r.searchedMs = (r.searchedMs || 0) + (performance.now() - r.driveStarted);
    await show(r);
    if (run === r) renderResults();
  }

  // Without a worker: a few rounds per slice until the time is up or Stop,
  // resuming from the last checkpoint so stopping loses nothing.
  async function driveHere(ms) {
    const my = ++token, r = run;
    const deadline = performance.now() + ms;
    let rounds = 1, lastPaint = 0, lastSave = 0, index = 0;
    while (!r.stop && performance.now() < deadline) {
      const open = r.searches.filter(x => (x.checkpoint?.depth || 0) < (x.target ?? Infinity));
      if (!open.length) break;
      const x = open[index++ % open.length];
      const t = performance.now(), at = x.checkpoint?.depth || 0;
      x.result = FightingSearch.search(r.snapshot, { seed: x.seed,
        depth: at + Math.min(rounds, (x.target ?? Infinity) - at), checkpoint: x.checkpoint });
      x.checkpoint = x.result.checkpoint;
      x.seq += 1; x.local = true;
      x.meta = { metadata: x.result.metadata, infeasible: x.result.infeasible, count: x.result.frontier.length };
      const took = performance.now() - t;
      rounds = Math.max(1, Math.min(40, Math.round(rounds * SLICE_MS / Math.max(1, took))));
      if (Date.now() - lastSave >= 5000) { lastSave = Date.now(); saveHere(r); }
      if (r.searches.every(x => x.result?.infeasible.length)) break;
      if (performance.now() - lastPaint > 700) { lastPaint = performance.now(); renderSearch(); }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (my !== token) return;
    }
    await saveHere(r);
    if (my !== token) return;
    finish(r);
  }

  async function saveHere(r) {
    if (!r.id) return;
    await Promise.all(r.searches.filter(x => x.checkpoint).map(async x => {
      try {
        x.savedAt = await FightingProgress.save(r.id, x.checkpoint);
        x.saveError = !x.savedAt;
      } catch { x.saveError = true; }
    }));
    if (run === r) renderProgress();
  }

  function endRun() {
    token++;
    clearTimeout(progressTimer); progressTimer = 0;
    clearTimeout(run?.overrun);
    clearTimeout(dataAgeTimer);
    for (const x of run?.searches || []) x.worker?.terminate();
    run?.merger?.terminate();
  }

  // Search ids come from crypto.randomUUID, which needs a secure page.
  const insecure = () => insecurePageMessage('The build search');
  async function startSearch() {
    if (!market) return;
    if (insecure()) { setStatus(insecure(), true); return; }
    endRun();
    const r = run = { id: replay ? null : crypto.randomUUID(), snapshot: currentSnapshot(), result: null,
      running: false, stop: false, initializing: true };
    r.searches = [];
    renderSetupSummary();
    renderManualSummary();
    renderCompare();
    renderSearch();
    renderReplay();
    if (r.id) try {
      await FightingProgress.begin({ id: r.id, snapshot: r.snapshot, market, settings,
        modelVersion: FightingCore.MODEL_VERSION });
    } catch { r.saveError = true; }
    if (run !== r) return;
    r.initializing = false;
    r.searches = startWorkers(r);
    drive(INITIAL_MS);
  }

  // Amber and red thresholds. Prices, bonuses, taxes and wages all move
  // profits, so everything a load fetches ages on the market's clock.
  const AGE_BANDS = [900_000, 3_600_000];
  let dataAgeTimer = null;
  function renderDataAge() {
    clearTimeout(dataAgeTimer);
    const el = document.getElementById('fb-age');
    if (!el || !market) return;
    const now = Date.now();
    // The profile is fetched first, so it dates the whole load; a price
    // refresh since then makes only the prices newer. New searches reuse it.
    const age = Math.max(0, now - Date.parse(market.fetchedAt?.profile ?? market.asOf));
    const prices = Math.max(0, now - Date.parse(market.asOf));
    const known = Number.isFinite(age);
    const fmt = (ms) => ms < 60_000 ? 'under a minute' : formatDuration(ms);
    el.dataset.age = known ? ['fresh', 'old', 'stale'][AGE_BANDS.filter(b => age >= b).length] : 'stale';
    el.querySelector('span').textContent = known ? `${age < 60_000 ? '<1m' : formatDuration(age).split(' ')[0]} old` : 'age unknown';
    el.title = known
      ? `Loaded ${fmt(age)} ago${prices < age - 60_000 ? `, prices refreshed ${fmt(prices)} ago` : ''}. Click to refresh profile, companies, employees and market data, and restart the search.`
      : 'Loaded at an unknown time. Click to refresh profile, companies, employees and market data, and restart the search.';
    el.setAttribute('aria-label', el.title);
    // Tick as the age crosses each minute, so the label never lags.
    dataAgeTimer = setTimeout(renderDataAge, known ? 60_000 - age % 60_000 + 50 : 60_000);
  }

  function renderProgress() {
    const el = document.getElementById('fb-progress-note');
    if (!el) return;
    // Saving is silent; only a failure is worth a line.
    const text = run.id && (run.saveError || (run.searches || []).some(x => x.saveError))
      ? 'Search progress could not be saved in this browser. You can keep searching; reloading may lose progress. Another tab starting a search also replaces the saved search.'
      : '';
    if (el.textContent !== text) el.textContent = text;
  }

  // The page reads only the run; each search worker reads and reports its
  // own checkpoint, so the seen ids (tens of megabytes) never reach the page.
  // A search without a worker restores here.
  async function restoreSearch(username, mine) {
    let stored;
    try { stored = await FightingProgress.loadRun(); }
    catch { return false; }
    if (mine !== loadToken || !stored?.seeds.length) return false;
    const saved = stored.run;
    const who = saved.snapshot?.profile?.username;
    if (username && who?.toLowerCase() !== username.toLowerCase()) return false;
    const r = { id: saved.id, snapshot: saved.snapshot, result: null, running: false,
      stop: false };
    restoreSteps.reset();
    restoreSteps.setStep(1, 'done', { sub: who ? `For ${who}` : '' });
    let restored = 0;
    const count = () => `${restored} of ${stored.seeds.length}`;
    restoreSteps.setStep(2, 'active', { count: count() });
    try {
      if (saved.version !== 2 || saved.modelVersion !== FightingCore.MODEL_VERSION || !saved.market || !saved.settings) throw new Error('Saved with an older version of this tool');
      r.searches = startWorkers(r, stored.seeds);
      await Promise.all(r.searches.map(x => restoreOne(r, x).then(() => {
        restored += 1;
        if (mine === loadToken) restoreSteps.setStep(2, 'active', { count: count() });
      })));
    } catch (e) {
      for (const x of r.searches || []) x.worker?.terminate();
      r.merger?.terminate();
      if (mine !== loadToken) { restoreSteps.hide(); return false; }
      restoreSteps.markActiveAsError(e.message);
      setStatus('The saved search could not be restored. Load your player to start a new search.', true);
      return false;
    }
    if (mine !== loadToken) {
      for (const x of r.searches) x.worker?.terminate();
      r.merger?.terminate();
      restoreSteps.hide();
      return false;
    }
    const looked = r.searches.reduce((t, x) => t + (x.meta?.metadata.evaluated || 0), 0);
    restoreSteps.setStep(2, 'done', { sub: `${fmtNum(looked)} builds looked at`, count: count() });
    restoreSteps.setStep(3, 'active');
    market = saved.market; settings = saved.settings;
    $username.value = saved.snapshot.profile.username;
    const draft = readManualStore()[market.profile.userId];
    manual = draft ? FightingCompare.cleanStrategy(market, draft) : FightingCompare.profileDraft(market);
    edit = toEdit(manual);
    run = r;
    selectedId = null;
    $hint.classList.add('hidden');
    renderShell();
    await show(r);
    if (run !== r) return true;
    restoreSteps.setStep(3, 'done', { count: `${fmtNum(r.result?.frontier.length || 0)} builds kept` });
    restoreSteps.fadeOut(300);
    renderResults();
    return true;
  }

  async function restoreOne(r, x) {
    if (x.worker) {
      await new Promise((resolve, reject) => {
        x.restoring = { resolve, reject };
        x.worker.postMessage({ restore: true, snapshot: r.snapshot, seed: x.seed, runId: r.id });
      });
      x.restoring = null;
      x.sent = true;
      return;
    }
    const stored = await FightingProgress.loadCheckpoint(x.seed);
    if (!stored) throw new Error('No saved checkpoint.');
    x.result = FightingSearch.fromCheckpoint(r.snapshot, stored.checkpoint);
    x.checkpoint = stored.checkpoint; x.savedAt = stored.savedAt;
    x.seq = 1; x.local = true;
    x.meta = { metadata: x.result.metadata, infeasible: x.result.infeasible, count: x.result.frontier.length };
  }

  // Builds evaluated so far: the workers' latest counts while they run.
  function evaluatedSoFar() {
    const live = (run.searches || []).map(x => x.meta?.metadata).filter(Boolean);
    if (!run.running || !live.length) return run.result?.metadata || null;
    return { evaluated: live.reduce((t, m) => t + m.evaluated, 0), depth: live.reduce((t, m) => t + m.depth, 0) };
  }

  // Redrawn only when the search starts or stops: in between the count is
  // updated in place, so Stop stays under the pointer.
  function renderSearch() {
    const el = document.getElementById('fb-search');
    if (!el) return;
    const m = evaluatedSoFar(), done = run.result?.metadata;
    const label = run.initializing ? 'Preparing search…' : run.running ? run.replay ? 'Replaying…' : 'Searching…' : 'Search finished';
    const count = m ? `${fmtNum(m.evaluated)} builds, depth ${m.depth}` : '';
    renderDetails(done);
    if (run.replay) renderReplay();
    // The results wait for the search: dimmed while it runs, then drawn once.
    $out.classList.toggle('fb-busy', run.running);
    if (el.fbRun === run && el.fbRunning === run.running && el.fbInitializing === run.initializing) {
      const labelEl = el.querySelector('#fb-search-text strong'), countEl = el.querySelector('.fb-search-count');
      if (labelEl.textContent !== label) labelEl.textContent = label;
      if (countEl.textContent !== count) countEl.textContent = count;
      renderProgress();
      return;
    }
    el.fbRun = run; el.fbRunning = run.running; el.fbInitializing = run.initializing;
    el.innerHTML = `
      <div class="fb-search-bar fb-has-help">${helpHtml('The search', `Each search starts from its own seed on up to four spare cores and
        keeps the best builds found, in about 15 seconds. Search longer runs about two minutes more; Stop keeps every completed
        round. The clock shows how old your data is: tap it to update your profile, company bonuses and market prices, then
        start a new search.`)}
        <div class="fb-search-heading">
          ${run.running ? '<span class="fb-spinner" aria-hidden="true"></span>' : ''}
          <span id="fb-search-text" role="status"><strong>${label}</strong><span class="fb-search-count">${count}</span></span>
        </div>
        <div class="fb-refresh-info">
          <div class="fb-refresh-row">
            <button id="fb-age" class="fb-age"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.3 1.5"/></svg><span></span></button>
            <span class="fb-refresh-hint">Tap to refresh all data</span>
          </div>
        </div>
        ${run.running ? '<button id="fb-stop" class="secondary">Stop</button>'
          : run.replay ? '' : `<button id="fb-longer" class="secondary" ${run.initializing ? 'disabled' : ''}>Search longer (~2 min)</button>`}
      </div>
      ${run.running ? `<p class="fb-note">${run.result ? 'The builds below are from before this search; they update when it finishes.'
        : run.replay ? 'The builds appear when the replay finishes.' : 'The builds appear when the search finishes, in about 15 seconds.'}</p>` : ''}`;
    // The age keeps itself current from here, on its own timer.
    renderDataAge();
    renderProgress();
  }

  // --- Search details and replay ---
  // The footer: what the search covered, its versions, and its inputs as a
  // file someone else can replay to the same builds.
  const PILLS_LABEL = { both: 'pilled + unpilled', pilled: 'pilled only', unpilled: 'unpilled only' };
  function renderDetails(m) {
    const el = document.getElementById('fb-search-coverage');
    el.classList.toggle('hidden', run.running || !m);
    // Drawn once a result: redrawing on every status update would replace a
    // file input under an open file picker.
    if (run.running || !m || el.fbMeta === m) return;
    el.fbMeta = m;
    const s = m.scope, seeds = m.seeds || [m.seed], counts = m.companyCounts;
    const chips = s ? [
      pinChip(`${s.skillPoints} <span>SP ·</span> ${s.skills} <span>skills</span>`),
      s.locked.length ? pinChip(`${s.locked.length} <span>locked</span>`, s.locked.map(k => SKILL_LABEL[k] || k).join(', ')) : '',
      pinChip(`${fmtNum(s.gear)} <span>gear ·</span> ${s.slots} <span>slots</span>`),
      pinChip(`${s.foods} <span>${s.foods === 1 ? 'food' : 'foods'}</span>`),
      pinChip(`${s.ammo} <span>ammo</span>`),
      pinChip(`<span>${PILLS_LABEL[s.pills]}</span>`),
      counts.length ? pinChip(`<span>companies</span> ${counts[0]}${counts.length > 1 ? `–${counts.at(-1)}` : ''}`) : '',
      pinChip(`${seeds.length} <span>${seeds.length === 1 ? 'seed' : 'seeds'}</span>`, `seed${seeds.length === 1 ? '' : 's'} ${seeds.join(', ')}`),
      pinChip(`<span>keeps</span> ${fmtNum(m.archiveLimit)}`),
    ].join('') : '';
    el.innerHTML = `
      ${s ? `<p class="fb-details-label">Searched</p><div class="fb-details-chips">${chips}</div>` : ''}
      <div class="fb-details-tags">
        <span class="fb-tag">${escapeHtml(m.modelVersion)}</span><span class="fb-tag">${escapeHtml(m.searchVersion)}</span>
        <span class="fb-tag">#${escapeHtml(m.snapshotHash)}</span>
      </div>
      <div class="fb-controls">
        <button type="button" id="fb-replay-save" class="secondary">Download search inputs</button>
        <label class="secondary fb-file">Replay a search… <input class="fb-replay-file" type="file" accept="application/json,.json"></label>
      </div>
`;
  }

  function downloadInputs() {
    if (!run?.result || run.running) return;
    const searches = run.searches.filter(x => x.meta).map(x => ({ seed: x.seed, depth: x.meta.metadata.depth }));
    const file = FightingReplay.create(run.snapshot, run.result, searches);
    const name = `fighting-search-${run.snapshot.profile.username || 'player'}-${(run.snapshot.asOf || file.savedAt).slice(0, 16).replace(':', '')}.json`;
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function openReplay(input) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      replay = { ...FightingReplay.read(await f.text()), started: false };
      setStatus('');
      renderReplay();
      $replay.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  const code = (v) => `<code>${escapeHtml(v ?? '—')}</code>`;
  const CHECK = {
    inputs: (c) => c.ok ? `Inputs match fingerprint ${code(`#${c.saved}`)}`
      : `Inputs don't match the file's fingerprint ${code(`#${c.saved}`)}: it was edited or damaged after saving`,
    model: (c) => c.ok ? `Same model ${code(c.here)}` : `Saved with ${code(c.saved)}; this page runs ${code(c.here)}`,
    search: (c) => c.ok ? `Same search ${code(c.here)}` : `Saved with ${code(c.saved)}; this page runs ${code(c.here)}`,
  };
  function renderReplay() {
    $replay.classList.toggle('hidden', !replay);
    if (!replay) { $replay.innerHTML = ''; $replay.fbHtml = ''; return; }
    const { file, checks } = replay, by = escapeHtml(file.by || 'someone');
    const rounds = file.searches.reduce((t, x) => t + x.depth, 0);
    const off = checks.filter(c => !c.ok);
    const r = run?.replay === file ? run : null;
    const back = '<button type="button" class="secondary" data-fb-replay="back">Back to your search</button>';
    // Left alone when unchanged: a running replay redraws on every progress update.
    const box = (tone, html) => {
      $replay.className = `fb-replay fb-replay-${tone}`;
      if ($replay.fbHtml !== html) { $replay.innerHTML = html; $replay.fbHtml = html; }
    };
    if (!replay.started) {
      return box(off.length ? 'warn' : 'info', `
        <strong>${off.length ? '⚠ ' : ''}Replay ${by}'s search from ${when(file.snapshot.asOf)}</strong>
        <p>Uses the profile and prices saved in the file, not live data.</p>
        <ul>${checks.map(c => `<li><span class="${c.ok ? 'fb-pos' : 'fb-warn'}">${c.ok ? '✓' : '✗'}</span> ${CHECK[c.key](c)}</li>`).join('')}
          <li>${file.searches.length} ${file.searches.length === 1 ? 'search' : 'searches'} · ${fmtNum(rounds)} rounds in total</li></ul>
        ${!checks[0].ok ? '<p>These aren\'t the inputs that were saved, so the replay won\'t be their search.</p>'
          : off.length ? '<p>The replay uses the same inputs, but the builds found may differ from what they saw.</p>' : ''}
        <div class="fb-controls"><button type="button" data-fb-replay="start">${off.length ? 'Replay anyway' : 'Replay search'}</button>
          <button type="button" class="secondary" data-fb-replay="cancel">Cancel</button></div>`);
    }
    if (!r) {
      return box('info', `<strong>Viewing ${by}'s saved search</strong>
        <p>Changes search their inputs again, and nothing is saved in this browser.</p><div class="fb-controls">${back}</div>`);
    }
    const reached = r.searches.map(x => x.meta?.metadata.depth || 0);
    const done = reached.reduce((t, d) => t + d, 0);
    if (r.running || !r.result) {
      return box('info', `<strong>Replaying ${by}'s search…</strong> <span class="fb-muted">${fmtNum(done)} / ${fmtNum(rounds)} rounds</span>
        <div class="fb-replay-seeds">${file.searches.map((x, i) => `<span>seed ${x.seed}</span>
          <span class="fb-replay-track"><span style="width:${Math.min(100, 100 * reached[i] / x.depth)}%"></span></span>
          <span class="fb-num">${fmtNum(reached[i])} / ${fmtNum(x.depth)}</span>`).join('')}</div>`);
    }
    if (done < rounds) {
      return box('warn', `<strong>⚠ Stopped at ${fmtNum(done)} of ${fmtNum(rounds)} rounds</strong>
        <p>These are partial results, not what ${by} saw.</p>
        <div class="fb-controls"><button type="button" data-fb-replay="start">Replay again</button>${back}</div>`);
    }
    if (r.matchedResult !== r.result) { r.matchedResult = r.result; r.matches = FightingReplay.matches(file, r.result); }
    if (r.matches) {
      return box('ok', `<strong>✓ Same results as ${by}'s search</strong>
        <p>${fmtNum(r.result.metadata.evaluated)} builds looked at and the same builds kept: what's below is what they saw.</p>
        <div class="fb-controls">${back}</div>`);
    }
    box('warn', `<strong>⚠ Different results from ${by}'s search</strong>
      <p>${off.length ? `As expected, since: ${off.map(c => CHECK[c.key](c)).join('; ')}.`
        : 'The inputs and versions match, so this shouldn\'t happen. Please report it with the file.'}</p>
      <div class="fb-controls">${back}</div>`);
  }

  function startReplay() {
    const { file } = replay;
    ++loadToken;   // drops a load still in progress
    endRun();
    steps.hide(); restoreSteps.hide();
    setStatus('');
    replay.started = true;
    market = file.snapshot; settings = {};
    const draft = readManualStore()[market.profile.userId];
    manual = draft ? FightingCompare.cleanStrategy(market, draft) : FightingCompare.profileDraft(market);
    edit = toEdit(manual);
    selectedId = null;
    $hint.classList.add('hidden');
    const r = run = { id: null, replay: file, snapshot: file.snapshot, result: null, running: false, stop: false };
    renderShell();
    r.searches = startWorkers(r, file.searches.map(x => x.seed));
    r.searches.forEach((x, i) => { x.target = file.searches[i].depth; });
    drive(Infinity);
    renderReplay();
  }

  async function leaveReplay() {
    const mine = ++loadToken;
    replay = null;
    renderReplay();
    endRun();
    run = null; market = null;
    $out.innerHTML = '';
    setStatus('');
    if (!await restoreSearch('', mine) && mine === loadToken) $hint.classList.remove('hidden');
  }

  $replay.addEventListener('click', e => {
    const action = e.target.closest?.('[data-fb-replay]')?.dataset.fbReplay;
    if (action === 'start') startReplay();
    if (action === 'back') leaveReplay();
    if (action === 'cancel') { replay = null; renderReplay(); }
  });
  document.getElementById('fb-hint').addEventListener('change', e => {
    if (e.target.matches('.fb-replay-file')) openReplay(e.target);
  });

  function renderResults() {
    renderSearch();
    const r = run.result;
    if (!r) return;
    // The saved table's chart buttons and notes follow the run.
    if (savedRun !== run) { savedRun = run; renderSaved(); }
    renderManualSummary();
    if (r.infeasible.length) {
      document.getElementById('fb-roles').innerHTML = `<div class="status error">${r.infeasible.map(escapeHtml).join('<br>')}
        <br>No results: change or clear the locks to search.</div>`;
      ['fb-charts', 'fb-build'].forEach(id => { document.getElementById(id).innerHTML = ''; });
      browseEl.innerHTML = '';
      return renderCompare();
    }
    if (!findBuild(selectedId)) {
      selectedId = (r.picks.find(p => p.role === 'selfFunding')?.candidate || r.picks.find(p => p.candidate)?.candidate
        || r.frontier[0])?.id ?? null;
    }
    renderRoles();
    renderCharts();
    renderBrowse();
    renderBuild();
    renderCompare();
  }

  // --- Role cards ---
  const RULE = {
    saver: (s) => `Highest damage with a balance of at least ${signed(s.savingsTarget, 0)} a day`,
    selfFunding: () => 'Highest damage without a daily loss',
    moderate: (s) => `Highest damage within half the loss allowance (${coins(s.lossAllowance / 2, 0)} a day)`,
    full: (s) => `Highest damage within the loss allowance (${coins(s.lossAllowance, 0)} a day)`,
  };
  // Green when it earns or breaks even, red when it loses.
  const money = (v) => `<span class="fb-num ${v == null ? '' : v >= 0 ? 'fb-pos' : 'fb-neg'}">${signed(v)}</span>`;
  function renderRoles({ live = false } = {}) {
    const el = document.getElementById('fb-roles');
    // A drag moves only the highlight.
    if (live && el.querySelector('.fb-role')) {
      for (const card of el.querySelectorAll('.fb-role')) card.classList.toggle('fb-selected', !!selectedId && card.dataset.fbSelect === selectedId);
      return;
    }
    const s = run.snapshot.settings;
    el.innerHTML = run.result.picks.map(p => {
      const c = p.candidate, f = c?.result.figures;
      return `<div class="fb-role ${c && c.id === selectedId ? 'fb-selected' : ''}" ${c ? `data-fb-select="${c.id}" tabindex="0" role="button"` : ''}>
        <div class="fb-tile-label">${p.label}</div>
        <div class="fb-role-rule">${RULE[p.role](s)}</div>
        ${c ? `<div class="fb-tile-value">${dmg(f.dailyDamage)} <small>damage/day</small></div>
          <div class="fb-tile-sub">${p.role === 'selfFunding' ? `surplus ${money(p.surplus)}` : `balance ${money(f.dailyBalance)}`}
            · gear <span class="fb-num ${c.overBudget ? 'fb-neg' : ''}">${coins(f.equipmentPurchasePrice, 0)}</span> ${flags(c)}</div>`
          : `<div class="fb-tile-sub">${escapeHtml(p.explanation)}</div>`}
      </div>`;
    }).join('');
  }

  // --- Charts ---
  // Linear axes with round, evenly spaced ticks.
  function ticks(min, max, count = 5) {
    if (!(max > min)) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
    const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  // Net daily cost is the daily balance with its sign turned: left of zero a
  // build earns money, right of zero it loses money. Gear is already in it,
  // as wear at each item's own lifetime with its scrap credited back; only
  // the first purchase isn't, and that shows in the tooltip and as a hollow
  // marker when it is over the equipment budget.
  const netCost = (c) => -c.result.figures.dailyBalance;

  // Drawn at its on-screen size, one unit a pixel, so text stays readable on
  // a phone instead of shrinking with the chart; narrow charts use compact
  // numbers and fewer ticks.
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  function scatter({ title, points, counterpart = null, width: W, height: H }) {
    const narrow = W < 560;
    const L = narrow ? 48 : 82, R = 16, T = 14, B = 42;
    const yNum = narrow ? (v) => compact.format(v) : fmtNum;
    const scaled = counterpart ? [...points, counterpart] : points;
    const xs = scaled.map(netCost), ys = scaled.map(p => p.result.figures.dailyDamage);
    const count = (span, gap) => Math.max(3, Math.min(8, Math.floor(span / gap)));
    const xt = ticks(Math.min(0, ...xs), Math.max(0, ...xs), count(W - L - R, 90)), yt = ticks(0, Math.max(...ys), count(H - T - B, 55));
    const sx = (v) => L + (v - xt[0]) / (xt[xt.length - 1] - xt[0]) * (W - L - R);
    const sy = (v) => H - B - (v - yt[0]) / (yt[yt.length - 1] - yt[0]) * (H - T - B);
    chartScale = { sx, W };
    const picks = new Map([...run.result.picks.filter(p => p.candidate).map(p => [p.candidate.id, p.label]),
      ...shownBuilds().map(c => [c.id, escapeHtml(c.entry.name || 'Saved build')]), ['manual', 'Your build']]);
    const cheaper = cheaperThanMine();
    if (cheaper) picks.set(cheaper.id, [picks.get(cheaper.id), 'Cheaper than yours'].filter(Boolean).join(' · '));
    const zero = `<line class="fb-zero" x1="${sx(0)}" x2="${sx(0)}" y1="${T}" y2="${H - B}"/>
      <text class="fb-axis" x="${sx(0) - 6}" y="${H - B - 6}" text-anchor="end">← earns money</text>
      <text class="fb-axis" x="${sx(0) + 6}" y="${H - B - 6}">loses money →</text>`;
    const mark = (p, sel = false) => {
      const cx = sx(netCost(p)), cy = sy(p.result.figures.dailyDamage);
      const cls = `fb-pt ${p.result.pilled ? 'fb-pilled' : 'fb-unpilled'}${p.overBudget ? ' fb-pt-over' : ''}${
        sel ? ' fb-pt-sel' : ''}${picks.has(p.id) ? ' fb-pt-pick' : ''}${p.entry || p.manual ? ' fb-pt-saved' : ''}`;
      const r = narrow ? 6 : 5;
      const shape = p.result.pilled
        ? `<rect class="${cls}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" transform="rotate(45 ${cx} ${cy})"/>`
        : `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;
      return `<g data-fb-select="${p.id}">${shape}<circle class="fb-hit" cx="${cx}" cy="${cy}" r="${narrow ? 16 : 12}"/></g>`;
    };
    // Picks draw last, on top; the selection is drawn again over them all,
    // in its own layer (selection), so a drag redraws only that.
    const order = [...points].sort((a, b) => picks.has(a.id) - picks.has(b.id));
    // The selection is traced to both axes, its damage read off a badge on
    // the damage axis.
    const chosen = points.find(p => p.id === selectedId);
    const guide = chosen ? (() => {
      const gx = sx(netCost(chosen)), gy = sy(chosen.result.figures.dailyDamage);
      const text = yNum(Math.round(chosen.result.figures.dailyDamage)), w = text.length * 7 + 10;
      return `<line class="fb-guide" x1="${gx}" x2="${gx}" y1="${T}" y2="${H - B}"/>
        <line class="fb-guide" x1="${L}" x2="${gx}" y1="${gy}" y2="${gy}"/>
        <rect class="fb-ybadge" x="${Math.max(2, L - w - 2)}" y="${gy - 9}" width="${w}" height="18" rx="4"/>
        <text class="fb-ybadge-text" x="${Math.max(2, L - w - 2) + w / 2}" y="${gy + 4}" text-anchor="middle">${text}</text>`;
    })() : '';
    // The selection's counterpart (its other pill state) is a faint point
    // joined to it, for reading only.
    const linked = counterpart && chosen ? (() => {
      const cx = sx(netCost(counterpart)), cy = sy(counterpart.result.figures.dailyDamage), r = narrow ? 6 : 5;
      const cls = `fb-pt fb-pt-counter ${counterpart.result.pilled ? 'fb-pilled' : 'fb-unpilled'}`;
      const shape = counterpart.result.pilled
        ? `<rect class="${cls}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" transform="rotate(45 ${cx} ${cy})"/>`
        : `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;
      return `<line class="fb-counter-link" x1="${sx(netCost(chosen))}" y1="${sy(chosen.result.figures.dailyDamage)}" x2="${cx}" y2="${cy}"/>
        <g><title>${counterpart.result.pilled ? 'On a pill cycle' : 'Holding the pill'}: ${dmg(counterpart.result.figures.dailyDamage)} damage/day</title>${shape}</g>`;
    })() : '';
    // Each pick is labelled beside its point; a label that would overlap one
    // already placed moves up, with a leader line back to its point. A phone
    // has no room for them: the jump buttons under the slider name the picks.
    const placed = [];
    const overlaps = (b) => placed.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    const labels = narrow ? '' : [...picks].map(([id, label]) => [points.find(q => q.id === id), label]).filter(([p]) => p)
      .sort(([a], [b]) => netCost(a) - netCost(b)).map(([p, label]) => {
        const px = sx(netCost(p)), py = sy(p.result.figures.dailyDamage);
        const width = label.length * 7.2, right = px + 10 + width < W - R;
        const x1 = right ? px + 9 : px - 9 - width;
        let y = py + 4;
        while (overlaps({ x1, x2: x1 + width, y1: y - 12, y2: y + 3 }) && y > T + 13) y -= 15;
        placed.push({ x1, x2: x1 + width, y1: y - 12, y2: y + 3 });
        const leader = Math.abs(y - 4 - py) > 2
          ? `<line class="fb-leader" x1="${px}" y1="${py}" x2="${right ? x1 - 2 : x1 + width + 2}" y2="${y - 4}"/>` : '';
        return `${leader}<text class="fb-pt-label" x="${x1}" y="${y}">${label}</text>`;
      }).join('');
    const under = `${guide}${linked}`, over = chosen ? mark(chosen, true) : '';
    // What the rest of the plot is drawn from: a redraw with the same key
    // need only replace the selection's layers.
    const key = [title, W, H, xt, yt, points.map(p => p.id), [...picks]].join('|');
    const html = `<figure class="fb-chart">${title ? `<figcaption>${title}</figcaption>` : ''}
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Damage against net daily cost">
        ${yt.map(v => `<line class="fb-grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>
          <text class="fb-axis" x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${yNum(v)}</text>`).join('')}
        ${xt.map(v => `<text class="fb-axis" x="${sx(v)}" y="${H - B + 16}" text-anchor="middle">${fmtNum(v)}</text>`).join('')}
        ${zero}
        <text class="fb-axis-title" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${narrow ? 'Net daily cost (₿)' : 'Net daily cost (₿): fighting cost minus enabled income'}</text>
        <text class="fb-axis-title" transform="rotate(-90)" x="${-(T + H - B) / 2}" y="12" text-anchor="middle">Daily damage</text>
        <g class="fb-sel-under">${under}</g>${order.map(p => mark(p)).join('')}<g class="fb-sel-over">${over}</g>${labels}
      </svg></figure>`;
    return { html, key, under, over };
  }
  // The chart shows at most `bands` builds (ten by default): the cost range
  // split into that many equal bands, the highest-damage build in each. Role picks
  // always show, in place of their band's; the selected build shows as well, beside them. By default the range stops
  // at a loss of twice the allowance: the frontier runs on to heavy losses
  // that would squash the region the picks live in. Builds that another of
  // the same pill state beats on both damage and net daily cost are left
  // out first (the frontier keeps them for cheaper gear), so each series
  // rises from left to right. "All" lifts the range's end and splits it
  // into more bands.
  const VIEWS = [{ label: '10', bands: 10 }, { label: '20', bands: 20 }, { label: '40', bands: 40 },
    { label: 'All', bands: 80, all: true }];
  let bands = 10;
  let chartAll = false;
  // The slider under the chart, kept while the chart section is redrawn.
  let browseEl = null;
  let chartScale = null;
  // The points without the selection are the same for every build a drag
  // passes over, so they are worked out once per result, view and the
  // builds forced onto it; the selection is added on top.
  let chartCache = null;
  function chartPoints({ withSelected = true, live = false } = {}) {
    const base = chartBase();
    const sel = withSelected && findBuild(selectedId, { full: !live });
    if (!base.points.length || !sel || sel.result.figures.dailyBalance == null || base.points.includes(sel)) return base;
    const points = [...base.points, sel]
      .sort((a, b) => (netCost(a) - netCost(b)) || (a.result.figures.dailyDamage - b.result.figures.dailyDamage));
    return { ...base, points };
  }
  function chartBase() {
    const mine = manualCandidate(), shownNow = shownBuilds(), c = chartCache;
    if (c && c.result === run.result && c.snapshot === run.snapshot && c.chartAll === chartAll && c.bands === bands
      && c.mine === mine && c.shown.length === shownNow.length && c.shown.every((x, i) => x === shownNow[i])) return c.value;
    chartCache = { result: run.result, snapshot: run.snapshot, chartAll, bands, mine, shown: shownNow,
      value: chartBaseFor(mine, shownNow) };
    return chartCache.value;
  }
  function chartBaseFor(mine, shownNow) {
    const priced = run.result.frontier.filter(c => c.result.figures.dailyBalance != null);
    const ceiling = 2 * run.snapshot.settings.lossAllowance;
    const inRange = chartAll ? priced : priced.filter(c => netCost(c) <= ceiling);
    if (!inRange.length) return { points: [], beyond: priced.length };
    const rising = [];
    for (const pilled of [false, true]) {
      let top = -Infinity;
      for (const c of inRange.filter(c => !!c.result.pilled === pilled)
        .sort((a, b) => (netCost(a) - netCost(b)) || (b.result.figures.dailyDamage - a.result.figures.dailyDamage))) {
        if (c.result.figures.dailyDamage > top) { rising.push(c); top = c.result.figures.dailyDamage; }
      }
    }
    const lo = Math.min(...rising.map(netCost)), hi = Math.max(...rising.map(netCost));
    const band = (c) => hi > lo ? Math.min(bands - 1, Math.floor((netCost(c) - lo) / (hi - lo) * bands)) : 0;
    const best = new Map();
    for (const c of rising) {
      const b = band(c), cur = best.get(b);
      if (!cur || c.result.figures.dailyDamage > cur.result.figures.dailyDamage) best.set(b, c);
    }
    const hasBalance = (c) => c && c.result.figures.dailyBalance != null;
    const forced = [...run.result.picks.map(p => p.candidate), ...shownNow.filter(c => !unplotted(c)),
      mine && !unplotted(mine) && mine].filter(hasBalance);
    const ranged = new Set(inRange);
    for (const c of forced) if (ranged.has(c)) best.delete(band(c));
    // The selection is an extra point (chartPoints), and so is the cheapest
    // build that matches your build's damage: neither takes another off the
    // chart, so the slider's steps stay where they were.
    const extra = [cheaperThanMine()].filter(hasBalance);
    const points = [...new Set([...best.values(), ...forced, ...extra])]
      .sort((a, b) => (netCost(a) - netCost(b)) || (a.result.figures.dailyDamage - b.result.figures.dailyDamage));
    return { points, beyond: priced.length - inRange.length, ceiling };
  }

  // The chart's size: its container's width, and a height to suit. Full
  // screen, it fills the viewport under its header and selection line.
  // The plot's real width (chartWidth, measured by renderCharts' refit)
  // keeps its margin inside the section (chartWidthFor wide then), so it
  // follows the section's width without being measured again.
  let chartFull = false, chartWidth = 0, chartWidthFor = 0, lastChartSize = null;
  function chartSize() {
    if (chartFull) {
      const width = Math.max(280, window.innerWidth - 24);
      return { width, height: Math.max(200, window.innerHeight - (window.innerHeight < 500 ? 96 : 150)) };
    }
    const now = document.getElementById('fb-charts').clientWidth;
    const width = Math.max(280, Math.floor(chartWidth ? chartWidth + now - chartWidthFor : now - 52));
    return { width, height: Math.round(Math.max(240, Math.min(380, width * 0.55))) };
  }

  function renderCharts({ refit = true, live = false } = {}) {
    const el = document.getElementById('fb-charts');
    const { points, beyond, ceiling } = chartPoints({ live });
    document.getElementById('fb-chart-wrap').classList.toggle('fb-chart-full', chartFull);
    if (!points.length) { el.innerHTML = '<p class="fb-note">No fully priced builds to chart yet.</p>'; return; }
    // While dragging, the selection's full figures and its counterpart (a
    // few evaluations) wait until it rests, unless already worked out.
    const sel = findBuild(selectedId, { full: !live });
    counterpartLater = live && !counterpartKnown(sel);
    const other = counterpartLater ? null : counterpartOf(sel);
    const counterpart = other && !unplotted(other) && points.some(p => p.id === selectedId) ? other : null;
    const keys = `<span><svg width="12" height="12"><circle class="fb-unpilled" cx="6" cy="6" r="4.5"/></svg> Unpilled</span>
      <span><svg width="12" height="12"><rect class="fb-pilled" x="2" y="2" width="8" height="8" transform="rotate(45 6 6)"/></svg> Pilled</span>
      ${run.snapshot.settings.equipmentBudget != null ? `<span><svg width="12" height="12"><circle class="fb-unpilled fb-pt-over" cx="6" cy="6" r="4"/></svg> Gear over budget</span>` : ''}${counterpart ? `
      <span><svg width="22" height="12"><line class="fb-counter-link" x1="1" y1="6" x2="13" y2="6"/>${counterpart.result.pilled
        ? '<rect class="fb-pt-counter fb-pilled" x="13" y="3" width="6" height="6" transform="rotate(45 16 6)"/>'
        : '<circle class="fb-pt-counter fb-unpilled" cx="16" cy="6" r="4"/>'}</svg> ${
        counterpart.result.pilled ? 'On a pill cycle' : 'Holding the pill'}</span>` : ''}`;
    // A drag doesn't change the size, so it isn't measured again mid-frame.
    const size = live && lastChartSize || chartSize();
    lastChartSize = size;
    const chart = scatter({ title: chartFull ? '' : 'Damage against net daily cost', points, counterpart, ...size });
    const selLine = sel ? `Selected: ${tipText(sel)}` : 'Tap a point to select it.';
    const keep = (node) => { node.fbKey = chart.key; };
    // While dragging, only what follows the selection is redrawn: its
    // layers of the plot (or the plot, when its axes move), its key, and
    // the count or selection line. Rebuilding the section round them cost
    // slower phones the frame, and lifting the slider out of the page took
    // the drag off it.
    const figure = live && el.querySelector('.fb-chart');
    if (figure) {
      if (figure.fbKey === chart.key) {
        figure.querySelector('.fb-sel-under').innerHTML = chart.under;
        figure.querySelector('.fb-sel-over').innerHTML = chart.over;
      } else {
        figure.outerHTML = chart.html;
        keep(el.querySelector('.fb-chart'));
      }
      const legend = el.querySelector('.fb-legend');
      if (legend.fbHtml !== keys) { legend.innerHTML = keys; legend.fbHtml = keys; }
      if (chartFull) el.querySelector('.fb-chart-sel').innerHTML = selLine;
      else setFoldSummary('chart', { head: `${points.length} builds`, detail: 'damage against net daily cost' });
      return;
    }
    if (chartFull) {
      el.innerHTML = `
        <div class="fb-chart-head"><strong>Damage against net daily cost</strong>
          <span class="fb-legend">${keys}</span>
          <button id="fb-chart-close" class="secondary fb-small">Close</button></div>
        ${chart.html}
        <div class="fb-chart-sel">${selLine}</div>`;
      keep(el.querySelector('.fb-chart'));
      return;
    }
    // One row of controls, then the key; what the chart leaves out and how
    // to read it go under it.
    const controls = `<div class="fb-chart-bar">
      <div class="fb-views" role="radiogroup" aria-label="Builds shown">${VIEWS.map((v, i) => {
        const on = v.bands === bands && !!v.all === chartAll;
        return `<button type="button" role="radio" aria-checked="${on}" class="${on ? 'fb-on' : ''}" data-fb-view="${i}"
          title="${v.all ? `The best builds at every daily loss, in ${v.bands} cost bands`
            : `The best build in each of ${v.bands} cost bands, up to twice your loss allowance a day`}">${v.label}</button>`;
      }).join('')}</div>
      <button type="button" id="fb-chart-full" class="fb-icon-btn" title="Full screen" aria-label="Full screen">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button></div>
      <div class="fb-legend">${keys}</div>`;
    const howtoOpen = el.querySelector('.fb-chart-howto')?.open ? 'open' : '';
    const after = `${beyond ? `<p class="fb-note">${beyond} build${beyond === 1 ? '' : 's'} losing more than ${coins(ceiling, 0)} a day
        ${beyond === 1 ? 'is' : 'are'} left out; choose All to show ${beyond === 1 ? 'it' : 'them'}.</p>` : ''}
      <details class="howto fb-chart-howto" ${howtoOpen}><summary>Reading the chart</summary><div class="howto-body"><ul>
        <li>Each point is the best build in one of ${bands} equal cost bands, plus the role picks, your build, saved builds you
          show, and the selected build. Circles are unpilled, diamonds pilled; a hollow point's gear costs more than the equipment budget.</li>
        <li>Drag sideways across the chart or along the slider under it to step through the builds, or tap a point.
          The dashed lines trace the selected build to its damage and net daily cost.</li>
        <li>10, 20 and 40 stop at a loss of twice your loss allowance; All spreads over every build the search found.</li>
      </ul></div></details>`;
    el.innerHTML = fold('chart', 'Chart', { head: `${points.length} builds`, detail: 'damage against net daily cost' },
      `${controls}${chart.html}<div id="fb-browse-slot"></div>${after}`, { open: true });
    keep(el.querySelector('.fb-chart'));
    // The slider and its cards keep their state across redraws: the same
    // node moves into the new section.
    el.querySelector('#fb-browse-slot').replaceWith(browseEl);
    // The first drawing's width is an estimate: redraw once at the real one.
    const svg = el.querySelector('.fb-chart svg');
    const real = svg && Math.floor(svg.parentElement.clientWidth - 20);
    if (refit && real > 0 && Math.abs(real - chartSize().width) > 2) {
      chartWidth = real; chartWidthFor = el.clientWidth;
      renderCharts({ refit: false });
    }
  }

  // Full screen: the chart alone, landscape where the phone allows it, still
  // selecting builds. Where the Fullscreen API is missing (iPhone Safari) it
  // fills the window instead, and turning the phone redraws it to fit.
  async function openFullChart() {
    chartFull = true;
    document.body.classList.add('fb-noscroll');
    renderCharts();
    const wrap = document.getElementById('fb-chart-wrap');
    try {
      await wrap.requestFullscreen?.({ navigationUI: 'hide' });
      if (matchMedia('(pointer: coarse)').matches) await screen.orientation?.lock?.('landscape');
    } catch {}
  }
  function closeFullChart() {
    if (!chartFull) return;
    chartFull = false;
    document.body.classList.remove('fb-noscroll');
    try { screen.orientation?.unlock?.(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderCharts();
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) closeFullChart(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFullChart(); });
  // Redraw when the chart's width changes (window resize, turning the phone,
  // the section opening), not when a redraw changes its height. It's drawn
  // once at its new width (chartSize); the refit in renderCharts catches a
  // breakpoint that changes its margin.
  let chartFrame = 0;
  const redrawChart = () => {
    cancelAnimationFrame(chartFrame);
    chartFrame = requestAnimationFrame(() => {
      if (!run?.result || run.result.infeasible.length) return;
      renderCharts();
    });
  };
  let observedWidth = 0;
  const chartObserver = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w && w !== observedWidth) { observedWidth = w; redrawChart(); }
  });
  window.addEventListener('resize', () => { if (chartFull) redrawChart(); });
  // Opening the section redraws a chart drawn while it was closed, at an
  // estimated width. Only then: Firefox also fires toggle for a section
  // inserted open, which every redraw does.
  $out.addEventListener('toggle', e => {
    if (e.target.dataset?.fbFold !== 'chart' || !e.target.open) return;
    const svg = e.target.querySelector('.fb-chart svg');
    if (svg && Math.abs(svg.parentElement.clientWidth - 20 - +svg.getAttribute('width')) > 2) redrawChart();
  }, true);

  const tipText = (c) => {
    const f = c.result.figures;
    return `${c.entry ? `<strong>${escapeHtml(c.entry.name || 'Saved build')}</strong> (saved, at today's prices) · `
      : c.manual ? '<strong>Your build</strong> · ' : ''}<strong>${dmg(f.dailyDamage)}</strong> damage/day${c.result.pilled ? ` · ${PILL_ICON}pilled` : ''}
      · ${net(f.dailyBalance)} · gear ${coins(f.equipmentPurchasePrice, 0)}${c.overBudget ? ' (over budget)' : ''}`;
  };

  function showTooltip(e) {
    const g = e.target.closest?.('[data-fb-select]');
    const tip = document.getElementById('fb-tooltip');
    if (!tip) return;
    const c = g && g.closest('svg') && findBuild(g.dataset.fbSelect, { full: false });
    if (!c) { hideTooltip(); return; }
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
    tip.classList.remove('hidden');
    // Moving over the same point only moves it.
    if (tip.fbFor === c) return;
    tip.fbFor = c;
    const f = c.result.figures;
    tip.innerHTML = `${c.entry ? `<strong>${escapeHtml(c.entry.name || 'Saved build')}</strong> (saved, at today's prices)<br>`
      : c.manual ? '<strong>Your build</strong> (entered by hand)<br>' : ''}<strong>${dmg(f.dailyDamage)}</strong> damage/day${c.result.pilled ? ` · ${PILL_ICON}pilled` : ''}<br>
      ${f.dailyBalance >= 0 ? `earns ${coins(f.dailyBalance)}` : `loses ${coins(-f.dailyBalance)}`} a day<br>
      gear to buy up front ${coins(f.equipmentPurchasePrice, 0)}${c.overBudget ? ' (over budget)' : ''}<br>
      fighting cost ${coins(f.dailyFightingCost)} · ${coins(f.costPer1000Damage, 3)}/1,000 damage`;
  }

  // --- Saved builds on the chart ---
  // Every saved build is valued like the frontier's, at the current run's
  // profile, settings and market prices. A gear roll with no recent sales
  // has no price, so the build's figures are incomplete and say which.
  let savedCache = { snapshot: null, byId: new Map() };
  const overBudget = (result) => {
    const budget = run.snapshot.settings.equipmentBudget, price = result.figures.equipmentPurchasePrice;
    return budget != null && price != null && price > budget;
  };
  function savedCandidate(e) {
    if (savedCache.snapshot !== run.snapshot) savedCache = { snapshot: run.snapshot, byId: new Map() };
    if (savedCache.byId.has(e)) return savedCache.byId.get(e);
    const withGear = FightingCompare.withManualGear(run.snapshot, e.strategy);
    const snapshot = e.manual ? ownPhaseGear(withGear) : withGear;
    const result = FightingCore.evaluateStrategy(snapshot, e.strategy);
    const c = { id: `saved:${e.id}`, strategy: e.strategy, result, snapshot, entry: e, overBudget: overBudget(result) };
    savedCache.byId.set(e, c);
    return c;
  }
  const shownBuilds = () => run?.snapshot ? saved.filter(e => shown.has(e.id)).map(savedCandidate) : [];

  // --- The manual build ---
  // Valued like the frontier's, at the current run's snapshot, with any
  // hand-entered rolls priced as the player gave them. "Same gear in both
  // pill phases" constrains the search only: your build fights with the
  // gear you gave each phase.
  const ownPhaseGear = (snapshot) => snapshot.settings.sameGearBothPhases
    ? { ...snapshot, settings: { ...snapshot.settings, sameGearBothPhases: false } } : snapshot;
  // Keyed on the strategy itself: `manual` is replaced on every change, never edited.
  let manualCache = { snapshot: null, key: null, candidate: null };
  function manualCandidate() {
    if (!run?.snapshot || !manual) return null;
    const key = manual;
    if (manualCache.snapshot !== run.snapshot || manualCache.key !== key) {
      const snapshot = ownPhaseGear(FightingCompare.withManualGear(run.snapshot, manual));
      const result = FightingCore.evaluateStrategy(snapshot, manual);
      manualCache = { snapshot: run.snapshot, key,
        candidate: { id: 'manual', strategy: manual, result, snapshot, manual: true, overBudget: overBudget(result) } };
    }
    return manualCache.candidate;
  }
  // The cheapest frontier build that does at least your build's damage for
  // a lower net daily cost, or null when none does.
  let cheaperCache = { result: null, mine: null, found: null };
  function cheaperThanMine() {
    const mine = manualCandidate();
    if (!mine || unplotted(mine) || !run?.result) return null;
    if (cheaperCache.result === run.result && cheaperCache.mine === mine) return cheaperCache.found;
    const dmgOf = (c) => c.result.figures.dailyDamage;
    const found = run.result.frontier.filter(c => c.result.figures.dailyBalance != null
      && netCost(c) < netCost(mine) && dmgOf(c) >= dmgOf(mine))
      .sort((a, b) => (netCost(a) - netCost(b)) || (dmgOf(b) - dmgOf(a)))[0] ?? null;
    cheaperCache = { result: run.result, mine, found };
    return found;
  }
  // Why a shown snapshot has no point, or null when it has one.
  const unplotted = (c) => c.result.issues.length ? c.result.issues[0]
    : c.result.figures.dailyBalance == null ? 'Some prices are missing, so it has no daily balance.' : null;
  // A build in its other pill state (FightingCompare.counterpart), worked
  // out when shown and never saved: a viewing choice, like holdBudget.
  const counterparts = new WeakMap();
  let counterpartLater = false;   // the chart drew the selection without it (renderCharts)
  const counterpartKnown = (c) => !c || !run?.snapshot || !!counterparts.get(c)?.has(holdBudget);
  function counterpartOf(c) {
    if (!c || !run?.snapshot) return null;
    const byBudget = counterparts.get(c) || new Map();
    counterparts.set(c, byBudget);
    if (!byBudget.has(holdBudget)) {
      const snapshot = c.snapshot || run.snapshot;
      const found = FightingCompare.counterpart(snapshot, c.strategy, { spendPill: holdBudget === 'pill' });
      byBudget.set(holdBudget, found && { ...found, id: `${c.id}:counterpart`, snapshot, of: c });
    }
    return byBudget.get(holdBudget);
  }
  // Without `full`, a search build keeps its slim result: enough for the
  // chart and the slider while a drag passes over it.
  const findBuild = (id, { full = true } = {}) => {
    if (id === 'manual') return manualCandidate();
    if (id?.startsWith('saved:')) return (e => e && savedCandidate(e))(saved.find(e => `saved:${e.id}` === id));
    const c = run?.result?.frontier.find(x => x.id === id);
    return full ? withFull(c) : c;
  };

  // --- Frontier browsing ---
  // The slider steps through the chart's builds (without the selection's own
  // point, so dragging doesn't shift the steps), in equal steps however the
  // builds bunch up in cost: the chart's guide line shows where each really
  // sits. It is updated in place rather than redrawn, so a drag survives the
  // rerender each step causes. Under it, buttons jump to the named builds,
  // ‹ › step one build, and the selection's figures are set against yours.
  let browseSteps = [], browseKey = '', jumpKey = '';
  const nameOf = (c, picks) => c.manual ? 'Your build' : c.entry ? escapeHtml(c.entry.name || 'Saved build') : picks.get(c.id) || '';
  function neighbour(dir) {
    const sel = findBuild(selectedId, { full: false }), i = browseSteps.findIndex(c => c.id === selectedId);
    if (i >= 0 || !sel) return browseSteps[i + dir];
    const x = netCost(sel);
    return dir > 0 ? browseSteps.find(c => netCost(c) > x) : browseSteps.findLast(c => netCost(c) < x);
  }
  // A light tick under the finger as each build passes, once the page may.
  const buzz = (e) => e.pointerType === 'touch' && navigator.userActivation?.hasBeenActive !== false && navigator.vibrate?.(4);
  function stepTo(c, e) {
    if (!c || c.id === selectedId) return;
    if (e) buzz(e);
    select(c.id, { live: true });
  }

  function renderBrowse({ live = false } = {}) {
    const el = browseEl;
    const steps = browseSteps = chartPoints({ withSelected: false }).points;
    if (!steps.length) { el.innerHTML = '<p class="fb-note">No builds on the chart.</p>'; browseKey = jumpKey = ''; return; }
    const n = steps.length, sel = findBuild(selectedId, { full: !live });
    let i = steps.findIndex(c => c.id === selectedId);
    const onChart = i >= 0;
    if (!onChart) {
      const near = steps.map(c => sel ? Math.abs(netCost(c) - netCost(sel)) : 0);
      i = near.indexOf(Math.min(...near));
    }
    const picks = new Map(run.result.picks.filter(p => p.candidate).map(p => [p.candidate.id, p.label]));
    const cheaper = cheaperThanMine();
    const key = steps.map(c => c.id).join();
    if (key !== browseKey || !el.querySelector('#fb-step')) {
      browseKey = key; jumpKey = '';
      const marks = steps.map((c, j) => {
        const named = nameOf(c, picks);
        return named ? `<span class="fb-mark ${c.manual ? 'fb-mark-mine' : ''}" style="left:${(j + .5) / n * 100}%" title="${named}">${c.manual ? '★' : '◆'}</span>` : '';
      }).join('');
      el.innerHTML = `
        <div class="fb-track" id="fb-step" tabindex="0" role="slider" aria-label="Build on the chart, by net daily cost"
          aria-valuemin="1" aria-valuemax="${n}" style="--fb-gap:${n > 30 ? 1 : n > 15 ? 2 : 3}px">
          <div class="fb-track-steps">${steps.map(c => `<span class="${c.result.pilled ? 'fb-seg-p' : 'fb-seg-u'}"></span>`).join('')}</div>
          ${marks}<div class="fb-bubble"></div><div class="fb-thumb"></div>
        </div>
        <div class="fb-track-ends"><span>← Cheaper</span><span>Costlier →</span></div>
        <div class="fb-jumps"></div>
        <div class="fb-stepper">
          <button type="button" class="fb-nav" id="fb-prev" aria-label="Cheaper build">‹</button>
          <div class="fb-stepper-mid"><strong></strong><div class="fb-note"></div></div>
          <button type="button" class="fb-nav" id="fb-next" aria-label="Costlier build">›</button>
        </div>
        <div class="fb-delta"></div>`;
      const track = el.querySelector('#fb-step');
      const at = (e) => { const r = track.getBoundingClientRect(); return browseSteps[Math.max(0, Math.min(browseSteps.length - 1, Math.floor((e.clientX - r.left) / r.width * browseSteps.length)))]; };
      track.addEventListener('pointerdown', e => {
        if (e.button) return;
        track.setPointerCapture(e.pointerId);
        track.classList.add('fb-dragging');
        stepTo(at(e), e);
      });
      track.addEventListener('pointermove', e => { if (track.hasPointerCapture(e.pointerId)) stepTo(at(e), e); });
      const end = () => track.classList.remove('fb-dragging');
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
    }

    // Jump buttons: the picks, your build and saved builds, cheapest first.
    const jumps = new Map();
    for (const c of steps) {
      const label = c.manual ? '★ Your build' : c.id === cheaper?.id ? [picks.get(c.id), 'Cheaper than yours'].filter(Boolean).join(' · ')
        : nameOf(c, picks);
      if (label) jumps.set(c.id, label);
    }
    const jk = [...jumps].join();
    const jumpEl = el.querySelector('.fb-jumps');
    if (jk !== jumpKey) {
      jumpKey = jk;
      jumpEl.innerHTML = [...jumps].map(([id, label]) => `<button type="button" data-fb-select="${id}">${label}</button>`).join('');
    }
    jumpEl.querySelectorAll('button').forEach(b => b.classList.toggle('fb-on', b.dataset.fbSelect === selectedId));

    const track = el.querySelector('#fb-step'), shown = sel || steps[i], f = shown.result.figures;
    const x = (i + .5) / n * 100;
    track.querySelectorAll('.fb-track-steps span').forEach((s, j) => s.classList.toggle('fb-done', j <= i));
    const thumb = track.querySelector('.fb-thumb');
    thumb.style.left = `${x}%`;
    thumb.classList.toggle('fb-thumb-off', !onChart);
    track.setAttribute('aria-valuenow', i + 1);
    track.setAttribute('aria-valuetext', `${dmg(f.dailyDamage)} damage a day, ${net(f.dailyBalance)}`);

    const name = nameOf(shown, picks);
    el.querySelector('.fb-stepper-mid strong').innerHTML = name || `Build ${i + 1} of ${n}`;
    el.querySelector('.fb-stepper-mid .fb-note').innerHTML = `${onChart ? (name ? `Build ${i + 1} of ${n} · ` : '') : 'Between the chart\'s steps · '}${
      shown.result.pilled ? `${PILL_ICON}pilled` : 'unpilled'} · gear ${coins(f.equipmentPurchasePrice, 0)}`;
    el.querySelector('#fb-prev').disabled = !neighbour(-1);
    el.querySelector('#fb-next').disabled = !neighbour(1);

    // The figures, and how far each is from your build's.
    const mine = manualCandidate(), base = mine && !unplotted(mine) && !shown.manual ? mine.result.figures : null;
    const cell = (diff, good, text, label) => `<div>${diff == null ? '' : `<b class="fb-num ${diff === 0 ? '' : good ? 'fb-pos' : 'fb-neg'}">${diff}</b>`}
      <span class="fb-delta-val">${text}</span> ${label}</div>`;
    const sign = (v, s) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s}`;
    const dPct = base && base.dailyDamage ? Math.round((f.dailyDamage / base.dailyDamage - 1) * 100) : null;
    const dBal = base ? f.dailyBalance - base.dailyBalance : null;
    const dGear = base && f.equipmentPurchasePrice != null && base.equipmentPurchasePrice != null
      ? f.equipmentPurchasePrice - base.equipmentPurchasePrice : null;
    el.querySelector('.fb-delta').innerHTML = `
      ${cell(dPct == null ? null : sign(dPct, `${Math.abs(dPct)}%`), dPct >= 0, dmg(f.dailyDamage), 'damage')}
      ${cell(dBal == null ? null : sign(Math.round(dBal), coins(Math.abs(dBal), 0)), dBal >= 0, `${f.dailyBalance >= 0 ? '+' : '−'}${coins(Math.abs(f.dailyBalance), 0)}`, 'a day')}
      ${cell(dGear == null ? null : sign(Math.round(dGear), coins(Math.abs(dGear), 0)), dGear <= 0, coins(f.equipmentPurchasePrice, 0), 'gear')}
      ${base ? '<p class="fb-note fb-delta-head">Coloured figures compare with your build.</p>' : ''}`;

    // Measured last, once everything else is written, so the page is laid
    // out once for it rather than again after more changes.
    const bubble = track.querySelector('.fb-bubble');
    bubble.textContent = f.dailyBalance >= 0 ? `+${coins(f.dailyBalance, 0)}/day` : `−${coins(-f.dailyBalance, 0)}/day`;
    const half = bubble.offsetWidth / 2;
    bubble.style.left = `clamp(${half}px, ${x}%, calc(100% - ${half}px))`;
  }

  // --- Selected build ---
  function renderBuild() {
    const c = findBuild(selectedId);
    const el = document.getElementById('fb-build');
    el.innerHTML = c ? buildHtml(c.snapshot || run.snapshot, c.result, c) : '';
    renderDebuff();
    labelStacks(el);
    syncShopBar();
    // The summary's income chip points into the ledger, so it follows only
    // the ledger coming or going.
    if (!!el.querySelector('[data-fb-fold="ledger"]') !== summaryLedger) renderSetupSummary();
  }

  // Whole items to buy to fight the selected build for shopDays. Updated in
  // place as the period changes, so typing in its field keeps focus.
  const shopList = (result) => FightingCore.shoppingList(result, shopDays, { ownGear: shopOwnGear });
  const SHOP_PRESETS = [1, 3, 7, 14, 30];
  const shopPeriod = () => `${fmt(shopDays, 1)} day${shopDays === 1 ? '' : 's'}`;
  const shopOverview = (result, list) => ({ head: `${coins(list.total)} ${unit(`/ ${shopPeriod()}`)}`,
    detail: `${result.equipment.length} gear, ${coins(result.figures.equipmentPurchasePrice, 0)} up front` });
  // A gear target's price entry, for its basis, source and dates.
  const gearPriceOf = (result, e) => result.prices.find(p => p.role === 'equipment' && p.code === e.code && p.slot === e.slot
    && JSON.stringify(p.stats) === JSON.stringify(e.stats)) || {};
  const ago = (iso) => `${formatDuration(Date.now() - Date.parse(iso)).split(' ')[0]} ago`;
  // How far to trust a gear row's price: none to go on, the player's own
  // figure, or an estimate gone stale. Null for a fresh estimate or an item.
  const shopPriceFlag = (result, u) => {
    if (u.role !== 'equipment') return null;
    const p = gearPriceOf(result, u);
    return p.value == null ? 'missing' : p.source === 'manual' ? 'manual' : p.stale ? 'stale' : null;
  };
  // A chip naming where a gear row's price came from: the estimate's sales
  // and age, warned when stale.
  function shopSourceChip(result, u) {
    if (u.role !== 'equipment') return '';
    const p = gearPriceOf(result, u);
    if (p.value == null) return `<span class="fb-tag fb-shop-src fb-tag-warn" title="No recent sales of this roll and no price entered, so the build can't be valued.">no price</span>`;
    if (p.source === 'manual') return `<span class="fb-tag fb-shop-src fb-tag-own" title="No recent sales of this roll: priced at what you entered in Your build.">your price</span>`;
    const samples = result.equipment.find(e => e.slot === u.slot && e.code === u.code && FightingCore.sameStats(e.stats, u.stats))?.samples ?? 0;
    const detail = `Estimate from recent full-condition sales, not a live listing. ${BASIS_LABEL[p.taxBasis] || 'unknown basis'}, ${
      p.source || 'no source'}; fetched ${when(p.fetchedAt)}, last trade ${when(p.tradeDate)}${p.stale ? ' (stale)' : ''}.`;
    const chip = `${fmtNum(samples)} sale${samples === 1 ? '' : 's'}${p.tradeDate ? ` · ${ago(p.tradeDate)}` : ''}`;
    return `<span class="fb-tag fb-shop-src${p.stale ? ' fb-tag-warn' : ''}" title="${escapeHtml(detail)}">${chip}</span>`;
  }
  // Rows in the order of Your build: gear by slot, then food, ammunition and
  // the pill. A pilled build groups them by phase, so each set reads on its
  // own; an unpilled one splits gear from consumables. Each group folds and
  // opens as the player last left it.
  const ROLE_ORDER = ['equipment', 'food', 'ammo', 'pill'];
  const onlyPhase = (u) => u.phases?.length === 1 && u.phases[0] !== 'unpilled' ? u.phases[0] : null;
  const shopOrder = (u) => [ROLE_ORDER.indexOf(u.role), u.slot ? FightingCore.SLOTS.indexOf(u.slot) : 0];
  const byShopOrder = (a, b) => { const x = shopOrder(a), y = shopOrder(b); return x[0] - y[0] || x[1] - y[1]; };
  const SHOP_GROUPS = {
    pilled: [{ id: 'buff', title: 'Buff phase', has: u => onlyPhase(u) === 'buff' },
             { id: 'debuff', title: 'Debuff phase', has: u => onlyPhase(u) === 'debuff' },
             { id: 'both', title: 'Both phases', has: u => !onlyPhase(u) }],
    unpilled: [{ id: 'gear', title: 'Gear', has: u => u.role === 'equipment' },
               { id: 'use', title: 'Food and ammo', has: u => u.role !== 'equipment' }],
  };
  const groupCost = (rows) => rows.some(u => u.cost == null) ? null : rows.reduce((s, u) => s + u.cost, 0);
  // One line per item: what it is, how many and their cost. Its daily use,
  // unit price and price source sit beside it on wide screens; on a phone
  // they open under it on a tap, and a cost in the price's warning colour
  // flags what the hidden chip says.
  function shopLineHtml(result, u) {
    const src = shopSourceChip(result, u), perDay = u.perDay == null ? '—' : fmt(u.perDay, 2), flag = shopPriceFlag(result, u);
    return `<div class="fb-shop-line${flag ? ` fb-shop-${flag}` : ''}"><div class="fb-shop-row">
        <span class="fb-shop-item">${u.role === 'equipment' ? gearCard(u) : itemCard(u.code)}${src ? `<span class="fb-shop-tags">${src}</span>` : ''}</span>
        <span class="fb-shop-fig fb-shop-wide">${perDay}</span><span class="fb-shop-fig fb-shop-wide">${coins(u.unitCost)}</span>
        <span class="fb-shop-fig fb-shop-qty">${u.quantity == null ? '—' : `×${fmtNum(u.quantity)}`}</span>
        <span class="fb-shop-fig fb-shop-cost">${coins(u.cost)}</span>
        <button type="button" class="fb-shop-open" aria-expanded="false" aria-label="Daily use, unit price and price source"></button></div>
      <div class="fb-shop-more"><span>Used a day <b>${perDay}</b></span><span>Unit price <b>${coins(u.unitCost)}</b></span>${src}</div></div>`;
  }
  function shopHtml(result, list = shopList(result)) {
    const rows = [...list.rows].sort(byShopOrder);
    const groups = SHOP_GROUPS[result.pilled ? 'pilled' : 'unpilled'].map(g => ({ ...g, rows: rows.filter(g.has) })).filter(g => g.rows.length);
    const count = (n) => `${fmtNum(n)} item${n === 1 ? '' : 's'}`;
    const groupHtml = (g) => {
      return `<details class="fb-shop-group fb-shop-${g.id}" ${foldAttrs(`shop-${g.id}`, true)}>
        <summary><span class="fb-shop-title">${g.title}</span><span class="fb-shop-count">${count(g.rows.length)}</span>
          <span class="fb-shop-sub">${coins(groupCost(g.rows))}</span></summary>
        <div class="fb-shop-head"><span>Item</span><span>Used a day</span><span>Unit price</span><span>Buy</span><span>Cost</span></div>
        ${g.rows.map(u => shopLineHtml(result, u)).join('')}</details>`;
    };
    return `<div class="fb-shop-groups${result.pilled ? ' fb-shop-phased' : ''}">${groups.map(groupHtml).join('')}</div>
      <div class="fb-shop-cash">Total <span>${coins(list.total)}</span></div>`;
  }
  function renderShop() {
    const el = document.getElementById('fb-shop-body'), c = findBuild(selectedId);
    if (!el || !c) return;
    const list = shopList(c.result);
    el.innerHTML = shopHtml(c.result, list);
    setFoldSummary('shop', shopOverview(c.result, list));
    syncShopBar();
  }
  // The toolbar stays put while the list redraws (so typing in the days box
  // keeps focus); only its selected states and note follow the settings.
  function syncShopBar() {
    document.querySelectorAll('[data-fb-shop-days]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.fbShopDays === shopDays));
    document.querySelectorAll('[data-fb-shop-own]').forEach(b => b.setAttribute('aria-pressed', (b.dataset.fbShopOwn === '1') === shopOwnGear));
    const note = document.getElementById('fb-shop-note');
    if (note) note.textContent = `Whole items for ${shopPeriod()} at current prices, ${
      shopOwnGear ? 'starting with the gear owned and fully repaired' : 'the first set of gear included'}.`;
  }

  // The selected build in its other pill state: for a pilled build, the
  // days you hold the pill; for an unpilled one, a pill cycle. Same skills
  // and gear, so switching needs no reset and no purchase.
  // The next step up from a counterpart: the cheapest choice that does more
  // damage, with what the extra damage costs, so going over budget is a
  // choice the player can see.
  function nextHtml(other) {
    const n = other.next;
    if (!n) return '';
    const a = other.result.figures, b = n.result.figures;
    const extraCost = b.dailyBalance != null && a.dailyBalance != null ? a.dailyBalance - b.dailyBalance
      : b.dailyFightingCost - a.dailyFightingCost;
    const extraDmg = b.dailyDamage - a.dailyDamage;
    const loadout = (p) => [p.food, p.ammo].filter(Boolean).map(code => escapeHtml(itemName(code))).join(' + ') || 'nothing';
    const phases = n.result.phases.map(p => `${n.result.pilled ? `${PHASE_LABEL[p.phase]}: ` : ''}${loadout(p)}`).join('; ');
    return `<p class="fb-note fb-next"><strong>Next step up:</strong> ${phases} gives ${dmg(b.dailyDamage)} damage/day
      (+${dmg(extraDmg)}, +${Math.round(extraDmg / a.dailyDamage * 100)}%) for ${coins(extraCost)} a day more${
      b.dailyBalance == null ? '' : `, a balance of ${signed(b.dailyBalance)}/day`}: ${
      coins(1000 * extraCost / extraDmg, 2)} per 1,000 extra damage. It goes over the budget.</p>`;
  }

  function counterpartFold(candidate) {
    const pilled = candidate.result.pilled, other = counterpartOf(candidate);
    const title = pilled ? 'Holding the pill' : 'On a pill cycle';
    const help = pilled ? `For days you keep your pill for later. Your attack is at full strength, not the debuff's
        reduction, so the debuff loadout usually underspends. Same skills and gear (the buff or debuff set, whichever does
        more); food and ammunition are picked again. The pick is the most damage within the budget: the same as this
        build spends before pills, or that plus what its pills cost. The budget choice is kept in this browser, not in
        snapshots.`
      : `This build with a pill every cycle: same skills and gear, food and ammunition picked again for the buff and
        the debuff. The pick is the most damage whose spending, pills aside, is no more than this build's.`;
    const budget = pilled ? `<div class="fb-controls fb-hold-row"><span class="fb-detail">Budget on hold days</span>
      <div class="fb-views fb-hold-budget" role="radiogroup" aria-label="Budget on hold days">${[['same', 'Same as pilled'], ['pill', 'Spend the pill money']]
        .map(([v, label]) => `<button type="button" role="radio" aria-checked="${holdBudget === v}" class="${holdBudget === v ? 'fb-on' : ''}"
          data-fb-hold-budget="${v}">${label}</button>`).join('')}</div></div>` : '';
    if (!other) return fold('counterpart', title, { detail: 'not available' }, `${budget}<p class="fb-note">${pilled
      ? 'No food and ammunition choice for this build can be costed.' : 'No pill has a market price, so there is no pill cycle to value.'}</p>`, { help });
    const a = candidate.result.figures, b = other.result.figures;
    const pct = a.dailyDamage > 0 ? Math.round((b.dailyDamage / a.dailyDamage - 1) * 100) : null;
    const same = (x, y) => JSON.stringify(x || null) === JSON.stringify(y || null);
    const gearNote = !pilled || same(candidate.strategy.equipment, candidate.strategy.debuff?.equipment || candidate.strategy.equipment)
      ? '' : same(other.strategy.equipment, candidate.strategy.equipment) ? 'buff gear' : 'debuff gear';
    const row = (label, x, y) => `<tr><td>${label}</td><td class="num">${x}</td><td class="num">${y}</td></tr>`;
    const phaseRows = other.result.phases.map(p => `
      <tr><td>${PHASE_LABEL[p.phase]}${p.hours && other.result.pilled ? ` (${p.hours} h)` : ''}${gearNote ? ` <span class="fb-tag">${gearNote}</span>` : ''}</td>
        <td><div class="fb-loadout">${[p.food, p.ammo].filter(Boolean).map(itemTile).join('') || '—'}</div></td>
        <td class="num">${fmt(p.attacksPerDay, 1)}</td><td class="num">${dmg(p.dailyDamage)}</td></tr>`).join('');
    const body = `${budget}
      ${other.result.pilled ? `<p class="fb-note">One ${escapeHtml(itemName(other.result.schedule.pill))} every ${other.result.schedule.periodHours} h.</p>` : ''}
      <table class="fb-table"><thead><tr><th></th><th class="num">This build</th><th class="num">${title}</th></tr></thead><tbody>
        ${row('Daily damage', dmg(a.dailyDamage), dmg(b.dailyDamage))}
        ${row('Daily fighting cost', coins(a.dailyFightingCost), coins(b.dailyFightingCost))}
        ${row('Daily balance', signed(a.dailyBalance), signed(b.dailyBalance))}</tbody></table>
      <table class="fb-table fb-stack"><thead><tr><th>Phase</th><th>Food / ammo</th><th class="num">Attacks/day</th>
        <th class="num">Damage/day</th></tr></thead><tbody>${phaseRows}</tbody></table>${nextHtml(other)}`;
    return fold('counterpart', title, { head: `${dmg(b.dailyDamage)} ${unit('dmg/day')}`,
      detail: [pct == null ? '' : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}% damage`,
        b.dailyBalance == null ? '' : `${signed(b.dailyBalance)}/day`].filter(Boolean).join(' · ') }, body, { help });
  }

  function buildHtml(snapshot, result, candidate) {
    const f = result.figures;
    const tile = (label, value, sub, cls = '') => `
      <div class="fb-tile ${cls}"><div class="fb-tile-label">${label}</div>
        <div class="fb-tile-value">${value}</div><div class="fb-tile-sub">${sub}</div></div>`;
    const cost = result.fightingCost;
    const co = result.companies, work = co.selfWork, job = co.managerJob;
    const kept = co.kept.flatMap(c => c.staff.filter(e => e.kept)).length;
    const managers = co.kept.filter(c => c.manager?.kept && !c.manager.inactive).length;
    const places = co.newCompanies ? `your ${co.owned} and ${co.newCompanies} new`
      : co.dropped.length ? `your best ${co.count} of ${co.owned}` : `your ${co.count}`;
    const detail = {
      production: co.engineIncome == null || work.income == null ? 'A product is unpriced or a company did not load.'
        : `Engines in ${places} companies ${coins(co.engineIncome)} + self-work ${coins(work.income)}: ${fmt(work.worksPerDay, 1)}
           works a day, ${fmtNum(Math.round(work.outputPP))} PP of ${escapeHtml(itemName(work.item))} at ${coins(work.margin, 3)} per PP`,
      employees: co.employeesIncome == null ? 'A product is unpriced or a company did not load.'
        : `${kept} employee${kept === 1 ? '' : 's'} in ${places} companies after wages${
            managers ? ` and ${managers} manager${managers === 1 ? '' : 's'}` : ''}${
            co.newCompany?.slots && co.newCompany.hired ? `, ${co.newCompanies * co.newCompany.slots} of them new at ${coins(co.newCompany.perEmployee)} each` : ''}
           · your Management +${fmt(2 * result.effectiveSkills.management.value, 0)}%`,
      manager: job.locked ? `Manager jobs open at level ${job.openAt}.`
        : job.rate == null ? 'Manager pay unavailable.'
        : `${job.points} Management points × ${coins(job.rate, 4)} an hour${job.taxPct ? `, less ${fmt(job.taxPct, 0)}% manager tax` : ''}`,
      bounty: `${coins(snapshot.settings.bountyPer1000, 3)} per 1,000 damage`,
      cases: `${fmt(result.rewards.cases.case1, 2)} case1 + ${fmt(result.rewards.cases.case2, 4)} case2 a day`,
      scrap: result.rewards.scraps == null ? 'Durability or rarity unknown for some gear.'
        : `${fmt(result.rewards.scraps, 1)} scraps a day from worn-out gear`,
    };
    const ledgerRows = result.ledger.map(r => `
      <tr class="${r.enabled ? '' : 'fb-off'}">
        <td><label class="fb-toggle"><input type="checkbox" data-fb-toggle="${r.id}" ${r.enabled ? 'checked' : ''}> ${r.label}</label>${
          r.saleProceeds ? ' <span class="fb-tag">estimated sale proceeds</span>' : ''}
          <div class="fb-detail">${detail[r.id] || ''}</div></td>
        <td class="num">${coins(r.amount)}</td></tr>`).join('');
    // Each company this build runs, its staff and manager, then any it
    // leaves out and the new ones it builds.
    const staffTile = (label, value, cls = '') => `<div class="fb-staff-tile ${cls}"><small>${label}</small><span>${value}</span></div>`;
    const staffRow = (who, status, tiles, off) => `<div class="fb-staff-row ${off ? 'fb-staff-off' : ''}">
        <div class="fb-staff-who"><strong>${who}</strong><span class="fb-staff-status">${status}</span></div>${tiles}</div>`;
    const companyHead = (c, status) => `<div class="fb-staff-company ${status ? 'fb-staff-off' : ''}">
        <strong>${escapeHtml(c.name || itemName(c.item))}</strong> <span class="fb-staff-status">${escapeHtml(itemName(c.item))}${
          c.disabled ? ' · disabled' : ` · engine level ${c.engineLevel}`}${status ? ` · ${status}` : ''}</span>
        <span class="fb-staff-value">${coins(c.value)}</span></div>`;
    const companyRows = (c, status = '') => companyHead(c, status) + c.staff.map(e => staffRow(escapeHtml(e.name || 'Employee'),
        status ? 'left out' : e.kept ? 'kept' : 'let go: loses money',
        `${staffTile('Output / day', `${fmtNum(Math.round(e.outputPP))} PP`)}${staffTile('Wage / day', coins(e.wage))}${
          staffTile('Net / day', coins(e.contribution), e.contribution < 0 ? 'fb-staff-neg' : '')}`, status || !e.kept)).join('')
      + (c.manager ? staffRow(`Manager (+${fmt(c.manager.bonusPct, 0)}%)`,
        c.manager.inactive ? 'inactive: no bonus, no pay' : status ? 'left out' : c.manager.kept ? 'kept' : 'let go: costs more than they add',
        `${staffTile('Adds / day', coins(c.manager.adds))}${staffTile('Pay / day', coins(c.manager.pay))}${
          staffTile('Net / day', coins(c.manager.adds == null ? null : c.manager.adds - c.manager.pay), c.manager.adds < c.manager.pay ? 'fb-staff-neg' : '')}`,
        status || !c.manager.kept || c.manager.inactive) : '');
    const fresh = co.newCompany ? `<div class="fb-staff-company"><strong>${co.newCompanies} new compan${co.newCompanies === 1 ? 'y' : 'ies'}</strong>
        <span class="fb-staff-status">${escapeHtml(itemName(co.target?.item))} · engine level ${co.newCompany.engineLevel} · ${co.newCompany.hired
          ? `${co.newCompany.slots} employee${co.newCompany.slots === 1 ? '' : 's'} each at ${coins(co.newCompany.perEmployee)} a day` : 'no employees'}</span>
        <span class="fb-staff-value">${coins(co.newCompanies * (co.newCompany.engineIncome + co.newCompany.employeesIncome))}</span></div>` : '';
    const staffRows = co.employeesIncome == null ? '' : co.kept.map(c => companyRows(c)).join('')
      + co.dropped.map(c => companyRows(c, 'left out: over the company count')).join('') + fresh;
    const phaseRows = result.phases.map(p => `
      <tr><td>${PHASE_LABEL[p.phase]}${p.hours && result.pilled ? ` (${p.hours} h)` : ''}</td>
        <td><div class="fb-loadout">${p.equipment.map(gearTile).join('') || 'no gear'}</div></td>
        <td><div class="fb-loadout">${[p.food, p.ammo].filter(Boolean).map(itemTile).join('') || '—'}</div></td>
        <td class="num">${fmt(p.attacksPerDay, 1)}</td><td class="num">${dmg(p.dailyDamage)}</td>
        <td class="num">${coins(p.loadoutPrice, 0)}</td></tr>`).join('');
    const [verdict, verdictClass] = result.sustainable == null ? ['incomplete', '']
      : result.sustainable ? ['earns money: sustainable', 'fb-sustainable'] : ['loses money: not sustainable', 'fb-unsustainable'];
    const income = FightingCompare.FIGURES.find(x => x.key === 'dailyIncome').of(result);
    const shop = shopList(result);
    // A pilled build's schedule section is the live debuff spend-down (renderDebuff).
    const fighting = result.pilled ? `<div id="fb-debuff" data-cadence="One ${escapeHtml(itemName(result.schedule.pill))} every
      ${result.schedule.periodHours} h (${result.schedule.buffHours} h buff, then ${result.schedule.debuffHours} h debuff)."></div>` : `
      <table class="fb-table fb-stack"><thead><tr><th>Phase</th><th>Gear</th><th>Food / ammo</th>
        <th class="num">Attacks/day</th>
        <th class="num">Damage/day</th><th class="num">Loadout price</th></tr></thead><tbody>${phaseRows}</tbody></table>`;
    const shopping = `
      <div class="fb-shop-bar">
        <div class="fb-shop-ctl"><span class="fb-shop-key">Period</span>
          <div class="fb-shop-seg" role="group" aria-label="Period">${SHOP_PRESETS.map(d =>
            `<button type="button" data-fb-shop-days="${d}">${d}d</button>`).join('')}<label class="fb-shop-seg-input"><input
            id="fb-shop-days" type="number" min="0.5" step="0.5" value="${shopDays}" aria-label="Days"> days</label></div></div>
        <div class="fb-shop-ctl fb-shop-ctl-gear"><span class="fb-shop-key">Gear</span>
          <div class="fb-shop-seg" role="group" aria-label="Gear"><button type="button" data-fb-shop-own="0">Buy it</button><button
            type="button" data-fb-shop-own="1">Already own</button></div></div>
        <p id="fb-shop-note" class="fb-shop-note"></p>
      </div>
      <div id="fb-shop-body">${shopHtml(result, shop)}</div>`;
    const ledger = `
      <table class="fb-table"><tbody>${ledgerRows}
        <tr><td>Daily fighting cost</td><td class="num">${f.dailyFightingCost == null ? '—' : `−${coins(f.dailyFightingCost)}`}</td></tr>
        <tr class="fb-total"><td>Daily balance</td><td class="num">${coins(f.dailyBalance)}</td></tr></tbody></table>`;
    const skillsBody = skillsHtml(snapshot, result);
    return `
      <h3 class="fb-h">Selected build ${candidate ? flags(candidate) : ''}</h3>
      ${result.missingPrices.length ? `<div class="status error">Incomplete: no market price for ${result.missingPrices.map(c => escapeHtml(itemName(c))).join(', ')}.</div>` : ''}
      ${result.missingRarity.length ? `<div class="status error">Incomplete: no rarity, so no scrap estimate, for ${result.missingRarity.map(escapeHtml).join(', ')}.</div>` : ''}
      <div class="fb-tiles">
        ${tile('Daily damage', dmg(f.dailyDamage), `${fmt(result.combat.attacksPerDay, 1)} attacks/day${result.pilled ? ', schedule average' : ''}`)}
        ${tile('Daily fighting cost', coins(f.dailyFightingCost), `ammo ${coins(cost.ammo)} · food ${coins(cost.food)} · wear ${coins(cost.wear)}${
          result.pilled ? ` · pills ${coins(cost.pill)}` : ''}`)}
        ${tile('Cost per 1,000 damage', coins(f.costPer1000Damage, 3), 'fighting cost only, before income')}
        ${tile('Equipment purchase price', coins(f.equipmentPurchasePrice), 'one-off, not in daily cost')}
        ${tile('Daily balance', signed(f.dailyBalance), `${verdict}<br>income ${coins(income)} − fighting cost ${coins(f.dailyFightingCost)}`, verdictClass)}
      </div>
      ${candidate ? `<div class="fb-controls"><button id="fb-save" class="secondary">Save this build as a snapshot</button>${
        candidate.manual ? '' : '<button id="fb-edit" class="secondary">Copy to your build</button>'}</div>` : ''}
      ${fold('fighting', result.pilled ? 'Pill schedule' : 'Fighting',
        { head: `${fmt(result.combat.attacksPerDay, 1)} ${unit('attacks/day')}`,
          detail: result.pilled ? `${escapeHtml(itemName(result.schedule.pill))} every ${result.schedule.periodHours} h` : '' },
        fighting, { open: true, help: result.pilled ? DEBUFF_HELP : '' })}
      ${candidate ? counterpartFold(candidate) : ''}
      ${fold('shop', 'Shopping list', shopOverview(result, shop), shopping, { help: `Daily figures average wear out; here each
        worn-out item is a whole one bought. Period sets how many days to buy for; Already own leaves out the first set of
        gear. Gear prices are estimates from recent sales (hover the chip, or tap the row on a phone, for its source); a roll
        with no recent sales uses the price you enter in Your build.` })}
      ${fold('ledger', 'Daily ledger', { head: `${money(f.dailyBalance)} ${unit('/day')}`,
        detail: `income ${coins(income)} − fighting cost ${coins(f.dailyFightingCost)}` }, ledger,
        { help: 'Enabled income minus daily fighting cost. Untick a stream to leave it out (the search reruns).' })}
      ${staffRows ? fold('staff', 'Companies and employees', { head: `${co.count} ${unit('companies')}`, detail: [
        `${kept} employees`, managers ? `${managers} manager${managers === 1 ? '' : 's'}` : '',
        co.dropped.length ? `${co.dropped.length} left out` : '', co.newCompanies ? `${co.newCompanies} new` : ''].filter(Boolean).join(', ') },
        `<div class="fb-staff">${staffRows}</div>`, { help: `Your companies as they run today, each with its engine,
        employees and manager. This build's Management sets the bonus you give every employee (2% a point), so output and
        net figures follow it. Anyone who would lose you money after their wage is let go, and so is a manager who costs
        more than their bonus adds. With fewer company places than companies, the least profitable are left out; with
        more, each new company copies your median one and makes your self-work product.` }) : ''}
      ${fold('skills', 'Skills', { head: `${result.skillPoints.spent}${unit(`/${result.skillPoints.budget} points`)}` }, skillsBody, { help: `Laid
        out as on the game's skills page. The count is of ordinary skill points; hatched segments are your fixed prestige
        levels, from their own budget. Where a skill differs from today, the change in ordinary level is shown.` })}`;
  }

  // --- Your build (manual) ---
  // The editor draws from the market snapshot, so it can show before the
  // first search round; its figures follow the run like every other build.
  // Typing changes only the editor's working copy (`edit`): the build is
  // valued, plotted and compared once it's applied, so a half-entered roll
  // never redraws the page.
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // The editor holds a pilled build's debuff companion whole: the parts it
  // doesn't set are the buff loadout's.
  function toEdit(strategy) {
    const e = clone(strategy);
    if (e.pill && e.debuff) {
      e.debuff = { equipment: e.debuff.equipment || clone(e.equipment),
        food: 'food' in e.debuff ? e.debuff.food : e.food, ammo: 'ammo' in e.debuff ? e.debuff.ammo : e.ammo };
    }
    return e;
  }
  const editedStrategy = () => FightingCompare.cleanStrategy(market, edit);
  const editDirty = () => !!edit && JSON.stringify(editedStrategy()) !== JSON.stringify(manual);
  const loadoutOf = (phase) => phase === 'debuff' ? edit.debuff : edit;
  // The gear in the editor carrying a price you entered, both phases.
  const editPricedGear = () => [edit.equipment, edit.debuff?.equipment]
    .flatMap(e => Object.values(e || {})).filter(g => g?.price != null);
  function clearEditPrices() {
    for (const g of editPricedGear()) delete g.price;
    renderManual();
  }

  // --- The editor's pieces ---
  // Gear slots are buttons showing what's in them; each opens the picker.
  // Food, ammunition and the pill are rows of tiles to tap.
  const optionsFor = (slot) => FightingCompare.manualOptions(market).slots[slot];
  const rollPrice = (item, e) => item?.rolls.find(r => FightingCore.sameStats(r.stats, e.stats))?.price ?? null;
  function slotButton(phase, slot) {
    const e = loadoutOf(phase).equipment[slot];
    const item = e && optionsFor(slot).find(i => i.code === e.code);
    const sold = item ? item.rolls.some(r => FightingCore.sameStats(r.stats, e.stats)) : false;
    const price = !item ? '' : sold ? coins(rollPrice(item, e)) : e.price != null ? `${coins(e.price)} <span class="fb-tag fb-tag-own">your price</span>` : '<span class="fb-tag fb-tag-warn" title="No recent sales of this roll: enter what you\'d pay, or the build can\'t be valued">no price</span>';
    const tile = e ? gearTile({ ...e, slot, rarity: item?.rarity })
      : `<span class="fb-slot fb-slot-empty"><img src="${emptySlotImage(slot)}" alt="" loading="lazy"></span>`;
    return `<button type="button" class="fb-pick-slot" data-fb-m="open" data-fb-phase="${phase}" data-fb-slot="${slot}"
        data-fb-slot-row="${phase}:${slot}" aria-label="${SLOT_LABEL[slot]}: ${e ? escapeHtml(gearName({ slot, code: e.code })) : 'empty'}. Change">
      ${tile}<span class="fb-gear-text"><span class="fb-gear-name">${e ? escapeHtml(gearName({ slot, code: e.code })) : SLOT_LABEL[slot]}
        ${e ? `<span class="fb-gear-rarity">${item?.rarity ? cap(item.rarity) : ''}</span>` : ''}</span>
        <span class="fb-gear-stats">${e ? Object.entries(e.stats).map(([k, v]) => `<span><b>+${v}</b> ${escapeHtml(STAT_SHORT[k] || SKILL_LABEL[k] || k)}</span>`).join('')
          : 'Empty: tap to choose'}</span>
        ${price ? `<span class="fb-detail">${price}</span>` : ''}</span></button>`;
  }
  function tileChoices(kind, phase, list, current, none) {
    return `<div class="fb-pick-row" role="radiogroup" aria-label="${kind}">${[{ code: '' }, ...list].map(i => `
      <button type="button" class="fb-pick-item ${(current || '') === i.code ? 'fb-picked' : ''}" role="radio" aria-checked="${(current || '') === i.code}"
        data-fb-m="${kind}" ${phase ? `data-fb-phase="${phase}"` : ''} data-fb-value="${i.code}">
        ${i.code ? itemTile(i.code) : '<span class="fb-slot fb-slot-sm fb-slot-empty"></span>'}
        <span><span class="fb-gear-name">${i.code ? escapeHtml(itemName(i.code)) : none}</span>
          ${i.code ? `<span class="fb-detail">${i.price == null ? 'no price' : coins(i.price)}</span>` : ''}</span></button>`).join('')}</div>`;
  }
  function loadoutHtml(phase, o) {
    const l = loadoutOf(phase);
    return `<div class="fb-pick-slots">${FightingCore.SLOTS.map(slot => slotButton(phase, slot)).join('')}</div>
      <div class="fb-pick-label">Food</div>${tileChoices('food', phase, o.foods, l.food, 'None')}
      <div class="fb-pick-label">Ammunition</div>${tileChoices('ammo', phase, o.ammo, l.ammo, 'None')}`;
  }

  // Skills as the Skills section draws them, the segments tappable: a
  // segment sets that level (the top one again clears it), and − and + step.
  function skillRow(name, max, eff) {
    const s = eff[name], level = edit.skills[name] || 0;
    const total = (market.config.skills[name]?.values.length || 11) - 1;
    const prestige = s.level - s.ordinary;
    const segs = Array.from({ length: total }, (_, i) => {
      const l = i + 1, locked = l > max;
      return `<button type="button" class="fb-seg ${l <= level ? 'on' : l <= level + prestige ? 'prestige' : ''}${locked ? ' locked' : ''}"
        data-fb-m="seg" data-fb-skill="${name}" data-fb-level="${l}" ${locked ? 'disabled' : ''}
        aria-label="${SKILL_LABEL[name]} level ${l}${locked ? ', locked at your level' : ''}"></button>`;
    }).join('');
    return `<div class="fb-skill fb-skill-edit fb-sk-${SKILL_COLOUR[name] || 'gray'}" data-fb-skill-row="${name}">
      <div class="fb-skill-head">${skillIcon(name)}<span class="fb-skill-value">${fmt(s.value, Number.isInteger(s.value) ? 0 : 1)}${SKILL_UNIT[name] || ''}</span>
        <span class="fb-skill-name">${SKILL_LABEL[name]}</span>
        <span class="fb-skill-level">level ${s.level}${prestige ? ` <span class="fb-tag">+${prestige} prestige</span>` : ''}</span>
        <span class="fb-skill-step">
          <button type="button" class="secondary fb-small" data-fb-m="dec" data-fb-skill="${name}" ${level <= 0 ? 'disabled' : ''} aria-label="${SKILL_LABEL[name]} down a level">−</button>
          <button type="button" class="secondary fb-small" data-fb-m="inc" data-fb-skill="${name}" ${level >= max ? 'disabled' : ''} aria-label="${SKILL_LABEL[name]} up a level">+</button>
        </span></div>
      <div class="fb-segs">${segs}</div></div>`;
  }
  function skillEditorHtml(o) {
    const max = Object.fromEntries(o.skills.map(k => [k.name, k.max]));
    const eff = FightingCore.effectiveSkills(market, edit.skills);
    return `<div class="fb-skill-groups">${SKILL_GROUPS.map(([title, names]) => {
      const rows = names.filter(n => n in max).map(n => skillRow(n, max[n], eff)).join('');
      return rows ? `<section class="fb-skill-group"><h4>${title}</h4>${rows}</section>` : '';
    }).join('')}</div>`;
  }

  const editPoints = () => Object.values(edit.skills).reduce((t, l) => t + costToReachLevel(+l || 0), 0);
  function renderManual() {
    const el = document.getElementById('fb-manual');
    if (!el || !manual) return;
    edit ||= toEdit(manual);
    const o = FightingCompare.manualOptions(market);
    const phases = !edit.pill ? loadoutHtml('buff', o) : `
      <h4 class="fb-manual-phase">Buff phase <span class="fb-detail">while the pill works</span></h4>
      ${loadoutHtml('buff', o)}
      <h4 class="fb-manual-phase">Debuff phase <span class="fb-detail">after it wears off</span></h4>
      <div class="fb-controls"><label class="fb-toggle"><input type="checkbox" data-fb-m="same" ${edit.debuff ? '' : 'checked'}> Same loadout as the buff phase</label></div>
      ${edit.debuff ? loadoutHtml('debuff', o) : ''}`;
    const pills = `<div class="fb-pick-label">Pill</div>${tileChoices('pill', '', o.pills, edit.pill, 'No pill')}`;
    const body = `
      <h4 class="fb-manual-phase">Skills <span id="fb-manual-points" class="fb-detail"></span></h4>
      ${skillEditorHtml(o)}
      ${pills}
      ${edit.pill ? '' : '<h4 class="fb-manual-phase">Gear</h4>'}
      ${phases}
      <div class="fb-controls fb-manual-apply">
        <button id="fb-manual-apply">Apply changes</button>
        <button id="fb-manual-discard" class="secondary">Discard changes</button>
        <button id="fb-manual-clear-prices" class="secondary">Clear your prices</button>
        <span id="fb-manual-dirty" class="fb-detail"></span>
      </div>
      <div id="fb-manual-summary"></div>`;
    el.innerHTML = fold('manual', 'Your build', {}, body, { help: `The skills and gear you fight with, or any build you want
      to try. It starts from your current skill levels and the gear and ammunition you have equipped. Tap a skill's segments to
      set its level, and a gear slot to choose its item and stats; a roll with no recent sales needs the price you'd pay.
      Apply changes to value it like the search's builds, at the same
      settings and prices; it is then plotted on the chart as "Your build" and kept in this browser.` });
    renderEditState();
    renderManualSummary();
  }

  // The parts of the editor that follow typing, updated in place.
  function renderEditState() {
    const points = document.getElementById('fb-manual-points');
    if (!points) return;
    const budget = market.profile.ordinarySkillBudget, spent = editPoints();
    points.innerHTML = `${spent} of ${budget} ordinary skill points${spent > budget ? ' <span class="fb-tag fb-tag-warn">over budget</span>' : ''}`;
    const dirty = editDirty();
    document.getElementById('fb-manual-apply').disabled = !dirty;
    document.getElementById('fb-manual-discard').disabled = !dirty;
    const own = editPricedGear().length;
    const clear = document.getElementById('fb-manual-clear-prices');
    clear.disabled = !own;
    clear.textContent = own ? `Clear your prices (${own})` : 'Clear your prices';
    document.getElementById('fb-manual-dirty').textContent = dirty ? 'Changes not applied yet: the figures below are for the build as last applied.' : '';
    renderManualOverview(dirty);
  }

  function renderManualOverview(edited = editDirty()) {
    const c = manualCandidate();
    const hand = c ? handPriced(c.result) : 0;
    const missing = c && !c.result.complete ? c.result.missingPrices.map(itemName).join(', ') : '';
    // Missing prices stop the figures, so they outrank hand-entered ones.
    const foldEl = $out.querySelector('details[data-fb-fold="manual"]');
    foldEl?.classList.toggle('fb-fold-missing', !!missing);
    foldEl?.classList.toggle('fb-fold-own', !missing && hand > 0);
    // Unapplied edits take the headline: the figures are for the build as last applied.
    const dirty = edited ? 'changes not applied' : '';
    if (!c) return setFoldSummary('manual', { head: dirty });
    const f = c.result.figures;
    if (missing) return setFoldSummary('manual', { head: `no price for ${escapeHtml(missing)}`, detail: ['incomplete', dirty].filter(Boolean).join(' · ') });
    setFoldSummary('manual', { head: dirty || `${money(f.dailyBalance)} ${unit('/day')}`, detail: [
      dirty ? net(f.dailyBalance) : '', `${dmg(f.dailyDamage)} damage/day`, `gear ${coins(f.equipmentPurchasePrice, 0)}`,
      c.result.pilled ? `${PILL_ICON}pilled` : '', hand ? `${hand} hand-entered price${hand === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') });
  }

  function renderManualSummary() {
    const el = document.getElementById('fb-manual-summary');
    const c = manualCandidate();
    renderManualOverview();
    if (!el || !c) return;
    const f = c.result.figures, sp = c.result.skillPoints;
    const tile = (label, value) => `<div class="fb-tile"><div class="fb-tile-label">${label}</div><div class="fb-tile-value">${value}</div></div>`;
    el.innerHTML = `
      <p class="fb-note">As applied: ${sp.spent} of ${sp.budget} ordinary skill points ${flags(c)}</p>
      ${c.result.issues.length ? `<div class="status error">${c.result.issues.map(escapeHtml).join('<br>')}</div>` : ''}
      <div class="fb-tiles">
        ${tile('Daily damage', dmg(f.dailyDamage))}
        ${tile('Daily balance', signed(f.dailyBalance))}
        ${tile('Equipment purchase price', coins(f.equipmentPurchasePrice, 0))}
        ${tile('Daily fighting cost', coins(f.dailyFightingCost))}
      </div>
      <div class="fb-controls">
        <button id="fb-manual-show" class="secondary" ${selectedId === 'manual' ? 'disabled' : ''}>Show as the selected build</button>
        <button id="fb-manual-save" class="secondary">Save as a snapshot</button>
        <button id="fb-manual-reset" class="secondary">Start again from my current skills and gear</button>
      </div>`;
  }

  // Applying values the edited build: its point, the selection and the
  // comparison follow.
  function applyManual() {
    manual = editedStrategy();
    edit = toEdit(manual);
    writeManual();
    renderManual();
    if (run?.result && !run.result.infeasible.length) { renderCharts(); renderBrowse(); if (selectedId === 'manual') renderBuild(); }
    renderCompare();
  }

  // An edit only touches `edit`, redrawing just what it changes: a skill's
  // row, a slot's button, a row of tiles. A pill or a separate debuff
  // loadout changes the editor's shape, so that redraws it.
  function redrawSlot(phase, slot) {
    const row = document.querySelector(`#fb-manual [data-fb-slot-row="${phase}:${slot}"]`);
    if (row) row.outerHTML = slotButton(phase, slot);
  }
  function redrawSkill(name) {
    const o = FightingCompare.manualOptions(market);
    const max = o.skills.find(k => k.name === name)?.max ?? 0;
    const row = document.querySelector(`#fb-manual [data-fb-skill-row="${name}"]`);
    if (row) row.outerHTML = skillRow(name, max, FightingCore.effectiveSkills(market, edit.skills));
  }

  function editManual(t, committed) {
    const d = t.dataset, v = t.value, kind = d.fbM;
    if (!kind || !edit) return;
    if (kind === 'stat' || kind === 'price') return editPicked(t, committed);
    if (kind === 'same' && committed) {
      if (t.checked) delete edit.debuff;
      else edit.debuff = { equipment: clone(edit.equipment), food: edit.food, ammo: edit.ammo };
      renderManual();
    }
  }

  // Taps on the editor's buttons and the picker's.
  function clickManual(b) {
    const d = b.dataset, kind = d.fbM;
    const max = (name) => FightingCompare.manualOptions(market).skills.find(k => k.name === name)?.max ?? 0;
    if (kind === 'seg' || kind === 'inc' || kind === 'dec') {
      const cur = edit.skills[d.fbSkill] || 0, l = +d.fbLevel;
      const next = kind === 'inc' ? cur + 1 : kind === 'dec' ? cur - 1 : l === cur ? l - 1 : l;
      edit.skills[d.fbSkill] = Math.max(0, Math.min(max(d.fbSkill), next));
      redrawSkill(d.fbSkill);
      // Keep focus on the control tapped, for stepping with the keyboard.
      document.querySelector(`#fb-manual [data-fb-skill-row="${d.fbSkill}"] [data-fb-m="${kind}"]${kind === 'seg' ? `[data-fb-level="${l}"]` : ''}`)?.focus();
    } else if (kind === 'food' || kind === 'ammo' || kind === 'pill') {
      if (kind === 'pill') {
        edit.pill = d.fbValue || null;
        if (!edit.pill) delete edit.debuff;
        renderManual();
      } else {
        loadoutOf(d.fbPhase)[kind] = d.fbValue || null;
        for (const x of b.parentElement.children) {
          const on = x === b;
          x.classList.toggle('fb-picked', on);
          x.setAttribute('aria-checked', on);
        }
      }
    } else if (kind === 'open') return openPicker(d.fbPhase, d.fbSlot);
    else if (kind === 'pick-item') return pickItem(d.fbCode);
    else if (kind === 'pick-roll') return pickRoll(+d.fbIndex);
    else if (kind === 'pick-change') { picker.step = 'item'; return renderPicker(); }
    else if (kind === 'pick-done') return document.getElementById('fb-picker').close();
    renderEditState();
  }

  // --- Gear picker ---
  // A dialog over the page (a sheet from the bottom on a phone). First the
  // slot's items, cheapest-first rarity order, each with its stat ranges and
  // cheapest recent sale; then the item's stats, set with a slider or typed,
  // or taken from a roll sold recently. A roll nobody has sold recently has
  // no market price, so it asks what you'd pay for it.
  let picker = null;   // { phase, slot, step: 'item' | 'roll' }
  const pickedGear = () => loadoutOf(picker.phase).equipment[picker.slot];
  const pickedItem = () => { const e = pickedGear(); return e && optionsFor(picker.slot).find(i => i.code === e.code); };
  const statKeys = (item, e) => [...new Set([...Object.keys(item.ranges || {}),
    ...item.rolls.flatMap(r => Object.keys(r.stats)), ...Object.keys(e?.stats || {})])].sort();
  const rangeLine = (item) => Object.entries(item.ranges || {}).map(([k, [lo, hi]]) =>
    `${escapeHtml(STAT_SHORT[k] || SKILL_LABEL[k] || k)} ${lo}–${hi}`).join(' · ');

  function openPicker(phase, slot) {
    picker = { phase, slot, step: loadoutOf(phase).equipment[slot] ? 'roll' : 'item' };
    renderPicker();
    const dialog = document.getElementById('fb-picker');
    if (!dialog.open) dialog.showModal();
  }

  function renderPicker() {
    const dialog = document.getElementById('fb-picker');
    if (!dialog || !picker) return;
    const { slot } = picker, phaseNote = edit.pill ? ` · ${picker.phase === 'debuff' ? 'debuff' : 'buff'} phase` : '';
    const head = (title) => `<div class="fb-picker-head"><h3>${title}<span class="fb-detail">${phaseNote}</span></h3>
      <button type="button" class="secondary fb-small" data-fb-m="pick-done">Done</button></div>`;
    if (picker.step === 'item') {
      const cur = pickedGear()?.code || '';
      const items = optionsFor(slot).map(i => {
        const cheapest = i.rolls.find(r => r.price != null)?.price;
        return `<button type="button" class="fb-pick-card ${cur === i.code ? 'fb-picked' : ''}" data-fb-m="pick-item" data-fb-code="${i.code}">
          ${gearTile({ slot, code: i.code, rarity: i.rarity, stats: {} })}
          <span class="fb-gear-text"><span class="fb-gear-name">${escapeHtml(gearName({ slot, code: i.code }))}
            <span class="fb-gear-rarity">${i.rarity ? cap(i.rarity) : ''}</span></span>
            <span class="fb-detail">${rangeLine(i)}</span>
            <span class="fb-detail">${cheapest == null ? 'no recent sales' : `from ${coins(cheapest)}`}</span></span></button>`;
      }).join('');
      dialog.innerHTML = `${head(`Choose ${SLOT_LABEL[slot].toLowerCase()}`)}
        <div class="fb-pick-cards">${items}
          <button type="button" class="fb-pick-card ${cur ? '' : 'fb-picked'}" data-fb-m="pick-item" data-fb-code="">
            <span class="fb-slot fb-slot-empty"><img src="${emptySlotImage(slot)}" alt="" loading="lazy"></span>
            <span class="fb-gear-name">Nothing in this slot</span></button></div>`;
      return;
    }
    const e = pickedGear(), item = pickedItem();
    const stats = statKeys(item, e).map(k => {
      const [lo, hi] = item.ranges?.[k] || [0, Math.max(100, e.stats[k] || 0)];
      const label = escapeHtml(STAT_SHORT[k] || SKILL_LABEL[k] || k);
      return `<div class="fb-pick-stat"><span class="fb-pick-stat-name">${label}</span>
        <input type="range" min="${lo}" max="${hi}" step="1" value="${e.stats[k] ?? lo}" data-fb-m="stat" data-fb-key="${k}" aria-label="${label}">
        <input type="number" min="0" step="1" value="${e.stats[k] ?? ''}" data-fb-m="stat" data-fb-key="${k}" aria-label="${label}, typed">
        <span class="fb-detail">${item.ranges?.[k] ? `${lo}–${hi}` : ''}</span></div>`;
    }).join('');
    dialog.innerHTML = `${head(`${escapeHtml(gearName({ slot, code: e.code }))} <span class="fb-gear-rarity">${item.rarity ? cap(item.rarity) : ''}</span>`)}
      <div class="fb-controls"><button type="button" class="secondary fb-small" data-fb-m="pick-change">Change item</button></div>
      <h4 class="fb-manual-phase">Stats</h4>
      <p class="fb-note">Set them to match your item: drag, type, or tap a roll sold recently below.</p>
      ${stats}
      <div id="fb-picker-price" class="fb-pick-price"></div>
      <h4 class="fb-manual-phase">Sold recently <span class="fb-detail">cheapest first</span></h4>
      <div id="fb-picker-rolls" class="fb-pick-rolls"></div>`;
    renderPickerPrice(true);
    renderPickerRolls();
  }

  // The rolls sold recently, the one matching the stats marked.
  function renderPickerRolls() {
    const el = document.getElementById('fb-picker-rolls');
    if (!el) return;
    const e = pickedGear(), item = pickedItem();
    el.innerHTML = item.rolls.length ? item.rolls.map((r, i) => `
      <button type="button" class="fb-pick-roll ${FightingCore.sameStats(r.stats, e.stats) ? 'fb-picked' : ''}" data-fb-m="pick-roll" data-fb-index="${i}">
        <span class="fb-gear-stats">${Object.entries(r.stats).map(([k, v]) => `<span><b>+${v}</b> ${escapeHtml(STAT_SHORT[k] || SKILL_LABEL[k] || k)}</span>`).join('')}</span>
        <span class="fb-pick-roll-price">${r.price == null ? 'no price' : coins(r.price)}</span></button>`).join('')
      : '<p class="fb-note">None in the market data.</p>';
  }

  // The price the build uses: a recent sale of exactly these stats, else
  // what you'd pay. Redrawn only when that changes, so typing keeps focus.
  function renderPickerPrice(force = false) {
    const el = document.getElementById('fb-picker-price');
    if (!el) return;
    const e = pickedGear(), item = pickedItem();
    const sold = item.rolls.find(r => FightingCore.sameStats(r.stats, e.stats));
    const state = sold ? `sold:${sold.price}` : 'own';
    if (!force && el.dataset.state === state) return;
    el.dataset.state = state;
    // A suggestion: the cheapest sale at least as good in every stat.
    const better = item.rolls.find(r => r.price != null && Object.entries(e.stats).every(([k, v]) => (r.stats[k] || 0) >= v));
    el.innerHTML = sold
      ? `<span>Price <b>${sold.price == null ? 'unknown' : coins(sold.price)}</b></span>
         <span class="fb-detail">A roll with exactly these stats sold recently; the build is priced at that sale.</span>`
      : `<label>You'd pay <input type="number" min="0" step="0.01" value="${e.price ?? ''}" placeholder="${better ? fmt(better.price, 2) : 'no sales'}" data-fb-m="price"></label>
         <span class="fb-detail">Nobody has sold a roll with exactly these stats recently, so there's no market price for it.
           Enter what it's worth to you; it prices the gear and its wear.${better ? ` The cheapest roll at least as good in every stat sold for ${coins(better.price)}.` : ''}</span>`;
  }

  function pickItem(code) {
    const { phase, slot } = picker;
    const item = code && optionsFor(slot).find(i => i.code === code);
    const cur = pickedGear();
    if (!item) { loadoutOf(phase).equipment[slot] = null; redrawSlot(phase, slot); renderEditState(); return document.getElementById('fb-picker').close(); }
    if (cur?.code !== code) {
      // A new item starts from its cheapest sold roll, else the bottom of its ranges.
      const first = item.rolls.find(r => r.price != null) || item.rolls[0];
      const stats = first ? { ...first.stats } : Object.fromEntries(Object.entries(item.ranges || {}).map(([k, [lo]]) => [k, lo]));
      loadoutOf(phase).equipment[slot] = { code, stats };
    }
    picker.step = 'roll';
    redrawSlot(phase, slot);
    renderEditState();
    renderPicker();
  }

  function pickRoll(i) {
    const roll = pickedItem()?.rolls[i];
    if (!roll) return;
    const e = pickedGear();
    loadoutOf(picker.phase).equipment[picker.slot] = { code: e.code, stats: { ...roll.stats } };
    for (const input of document.querySelectorAll('#fb-picker [data-fb-m="stat"]')) input.value = roll.stats[input.dataset.fbKey] ?? '';
    afterPickedChange();
  }

  // A stat moved (its slider and box kept together) or a price typed.
  function editPicked(t) {
    const e = pickedGear();
    if (!e) return;
    if (t.dataset.fbM === 'price') e.price = t.value === '' ? null : +t.value;
    else {
      const k = t.dataset.fbKey;
      e.stats[k] = t.value === '' ? 0 : +t.value;
      for (const other of document.querySelectorAll(`#fb-picker [data-fb-m="stat"][data-fb-key="${k}"]`)) if (other !== t) other.value = t.value;
    }
    afterPickedChange();
  }
  function afterPickedChange() {
    renderPickerPrice();
    const e = pickedGear();
    for (const [i, b] of [...document.querySelectorAll('#fb-picker .fb-pick-roll')].entries()) {
      b.classList.toggle('fb-picked', FightingCore.sameStats(pickedItem().rolls[i].stats, e.stats));
    }
    redrawSlot(picker.phase, picker.slot);
    renderEditState();
  }

  // Any build can start a manual one, its debuff companion included. A roll
  // the market has no sales of keeps the price it was valued at, as what
  // you'd pay.
  function copyToManual(c) {
    if (!c) return;   // a stale button: the search that drew it has been replaced
    const draft = clone(c.strategy);
    for (const equipment of [draft.equipment, draft.debuff?.equipment]) {
      for (const ref of Object.values(equipment || {})) {
        if (!ref || (market.equipment[ref.code] || []).some(t => FightingCore.sameStats(t.stats, ref.stats))) continue;
        const e = c.result.equipment.find(x => x.code === ref.code && FightingCore.sameStats(x.stats, ref.stats));
        if (e?.price != null) ref.price = e.price;
      }
    }
    edit = toEdit(FightingCompare.cleanStrategy(market, draft));
    applyManual();
    flashFold('manual', { scroll: true });
  }

  function saveCandidate(c) {
    if (!c) return;
    const role = run.result?.picks.find(p => p.candidate?.id === c.id)?.label;
    const name = `${c.manual ? 'Your build' : role || (c.result.pilled ? 'Pilled build' : 'Build')} · ${dmg(c.result.figures.dailyDamage)} dmg`;
    const entry = FightingStore.createEntry(c.strategy, { savedAt: new Date().toISOString(), name, by: market.profile.username });
    const from = run.id ? {} : { shared: { by: market.profile.username } };
    setSaved(FightingStore.addEntry(saved, c.manual ? { ...entry, ...from, manual: true } : { ...entry, ...from }));
  }

  // --- Comparison ---
  function compareChoices() {
    const out = [];
    const sel = findBuild(selectedId);
    if (sel) out.push({ value: 'selected', label: 'Selected build', group: 'Search' });
    for (const p of run?.result?.picks || []) if (p.candidate) out.push({ value: `pick:${p.role}`, label: p.label, group: 'Search' });
    if (manual) out.push({ value: 'manual', label: 'Your build', group: 'Yours' });
    for (const e of saved) out.push({ value: `saved:${e.id}`, label: `${e.name || 'Saved build'}${e.manual ? ' (manual)' : ''}`, group: 'Saved snapshots' });
    return out;
  }
  const compareCandidate = (v) => v === 'selected' ? findBuild(selectedId)
    : v?.startsWith('pick:') ? withFull(run?.result?.picks.find(p => p.role === v.slice(5))?.candidate) || null
    : findBuild(v);

  function renderCompare() {
    const el = document.getElementById('fb-compare');
    if (!el || !run?.snapshot) return;
    const choices = compareChoices();
    // A choice that isn't available yet (no selection before the first
    // round) stands in for now and comes back once it is.
    const has = (v) => choices.some(c => c.value === v);
    const pick = { a: has(compare.a) ? compare.a : choices[0]?.value ?? null };
    pick.b = has(compare.b) ? compare.b : choices.find(c => c.value !== pick.a)?.value ?? pick.a;
    const picker = (side) => `<label>${side.toUpperCase()} <select id="fb-compare-${side}">${
      [...new Set(choices.map(c => c.group))].map(g => `<optgroup label="${g}">${choices.filter(c => c.group === g).map(c =>
        `<option value="${escapeHtml(c.value)}" ${pick[side] === c.value ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}</optgroup>`).join('')
    }</select></label>`;
    const a = compareCandidate(pick.a), b = compareCandidate(pick.b);
    const name = (side) => escapeHtml(choices.find(c => c.value === pick[side])?.label || side.toUpperCase());
    const ba = a && b && b.result.figures.dailyBalance != null && a.result.figures.dailyBalance != null
      ? b.result.figures.dailyBalance - a.result.figures.dailyBalance : null;
    const overview = !(a && b) ? {} : {
      head: ba == null ? '' : Math.abs(ba) < 0.005 ? unit('no difference') : `B ${money(ba)} ${unit('/day')}`,
      detail: `${name('a')} ${net(a.result.figures.dailyBalance)} · ${name('b')} ${net(b.result.figures.dailyBalance)}` };
    el.innerHTML = fold('compare', 'Compare', overview, `
      ${choices.length < 2 ? '<p class="fb-note">Once the search finds builds, or you save some, pick two here.</p>' : `
      <div class="fb-controls">${picker('a')} <button id="fb-compare-swap" class="secondary fb-small">Swap</button> ${picker('b')}</div>
      ${a && b ? compareHtml(a, b, name('a'), name('b')) : ''}`}`, { help: `Any two builds side by side: from the search, your
      build, or saved snapshots. Both are valued at the current settings and prices, so a snapshot's figures here can differ
      from those it was saved with.` });
  }

  function compareHtml(a, b, nameA, nameB) {
    const c = FightingCompare.compareBuilds(a, b);
    const month = FightingCompare.MONTH_DAYS;
    const FIG = {
      dailyDamage: ['Daily damage', dmg, v => v == null ? '—' : `${v > 0 ? '+' : ''}${dmg(v)}`],
      dailyIncome: ['Daily income', v => coins(v), v => signed(v), 'the enabled ledger streams'],
      dailyFightingCost: ['Daily fighting cost', v => coins(v), v => signed(v), 'ammunition, food, pills and gear wear'],
      dailyBalance: ['Net a day', v => signed(v), v => signed(v), 'income − fighting cost'],
      equipmentPurchasePrice: ['Gear bought up front', v => coins(v, 0), v => signed(v, 0), 'one-off'],
      monthNet: [`Net over ${month} days`, v => signed(v, 0), v => signed(v, 0), `${month} days' net, less the gear bought up front`],
      costPer1000Damage: ['Cost per 1,000 damage', v => coins(v, 3), v => signed(v, 3), 'fighting cost only'],
    };
    const byKey = Object.fromEntries(c.figures.map(f => [f.key, f]));
    const says = (side, name) => {
      const v = byKey.dailyBalance[side], inc = byKey.dailyIncome[side], cost = byKey.dailyFightingCost[side];
      return `<b>${side.toUpperCase()}: ${name}</b> ${v == null ? 'has no daily net: a price or income is missing'
        : `${v >= 0 ? 'earns' : 'loses'} <b>${coins(Math.abs(v))}</b> a day`} (income ${coins(inc)} − fighting cost ${coins(cost)})`;
    };
    const d = byKey.dailyBalance.delta, m = byKey.monthNet.delta;
    const headline = `<div class="fb-compare-headline"><div>${says('a', nameA)}</div><div>${says('b', nameB)}</div>${
      d == null ? '' : Math.abs(d) < 0.005 ? '<div>Both net the same a day.</div>'
        : `<div>B nets <b>${coins(Math.abs(d))} a day ${d > 0 ? 'more' : 'less'}</b> than A${
          m == null ? '' : `; over ${month} days, gear bought up front included, ${m >= 0 ? `${coins(m, 0)} more` : `${coins(-m, 0)} less`}`}.</div>`}</div>`;
    const head = (first) => `<thead><tr><th>${first}</th><th>A: ${nameA}</th><th>B: ${nameB}</th><th class="num">B − A</th></tr></thead>`;
    const figures = c.figures.map(f => { const [label, show, diff, note] = FIG[f.key]; return `<tr class="${f.key === 'dailyBalance' ? 'fb-total' : ''}"><td>${label}${
      note ? `<div class="fb-detail">${note}</div>` : ''}</td>
      <td class="num ${f.better === 'a' ? 'fb-better' : ''}">${show(f.a)}</td><td class="num ${f.better === 'b' ? 'fb-better' : ''}">${show(f.b)}</td>
      <td class="num">${diff(f.delta)}</td></tr>`; }).join('');
    const lvl = (s) => `${s.level}${s.prestige ? ` <span class="fb-detail">(${s.ordinary} + prestige)</span>` : ''}`;
    const skills = c.skills.map(k => `<tr class="${k.same ? '' : 'fb-diff'}"><td>${SKILL_LABEL[k.name] || k.name}</td>
      <td>${lvl(k.a)}</td><td>${lvl(k.b)}</td><td class="num">${k.same ? '' : `${k.b.level - k.a.level > 0 ? '+' : ''}${k.b.level - k.a.level}`}</td></tr>`).join('');
    const PHASE = { unpilled: 'Loadout', buff: 'Buff phase', debuff: 'Debuff companion' };
    const cell = (e) => e ? gearCard(e) : '<span class="fb-detail">none</span>';
    const item = (code) => code ? itemCard(code) : '<span class="fb-detail">none</span>';
    const phases = c.phases.map(p => `<tr class="fb-compare-phase"><th colspan="4">${PHASE[p.phase]}${
      p.missing ? ` <span class="fb-detail">· ${p.missing.toUpperCase()} takes no pill</span>` : ''}</th></tr>
      ${p.gear.map(g => `<tr class="${g.same ? '' : 'fb-diff'}"><td>${SLOT_LABEL[g.slot]}</td><td>${cell(g.a)}</td><td>${cell(g.b)}</td><td></td></tr>`).join('')}
      <tr class="${p.food.same ? '' : 'fb-diff'}"><td>Food</td><td>${item(p.food.a)}</td><td>${item(p.food.b)}</td><td></td></tr>
      <tr class="${p.ammo.same ? '' : 'fb-diff'}"><td>Ammunition</td><td>${item(p.ammo.a)}</td><td>${item(p.ammo.b)}</td><td></td></tr>`).join('');
    const issues = [[a, 'A'], [b, 'B']].filter(([x]) => x.result.issues.length)
      .map(([x, side]) => `<div class="status error">${side}: ${x.result.issues.map(escapeHtml).join(' ')}</div>`).join('');
    return `${issues}${headline}
      <table class="fb-table fb-compare">${head('Figure')}<tbody>${figures}</tbody></table>
      <table class="fb-table fb-compare">${head('Skill (level)')}<tbody>${skills}</tbody></table>
      <table class="fb-table fb-compare">${head('Gear and consumables')}<tbody>
        <tr class="${c.pill.same ? '' : 'fb-diff'}"><td>Pill</td><td>${item(c.pill.a)}</td><td>${item(c.pill.b)}</td><td></td></tr>
        ${phases}</tbody></table>`;
  }

  // --- Rarer settings ---
  // Locks drawn like the skills page: a segment locks the skill at that
  // effective level (the locked one again drops to the lowest it can be),
  // and the padlock frees it or locks it at your current level.
  const PADLOCK = (closed) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="${closed ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 5.8-1.1'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/></svg>`;
  // Companies run at the full capacity of the effective companies level.
  const companyCount = (level) => Math.max(FightingCore.MIN_COMPANIES, Math.floor((run?.snapshot || market).config.skills.companies.values[level]));
  function lockFloor(name) { return FightingCore.effectiveSkills(market, {})[name].level; }
  function lockEditorHtml(locks, modelled) {
    const max = Object.fromEntries(FightingCompare.manualOptions(market).skills.map(k => [k.name, k.max]));
    const floor = FightingCore.effectiveSkills(market, {});
    const top = FightingCore.effectiveSkills(market, max);
    const current = FightingCore.effectiveSkills(market, market.profile.currentSkills || {});
    const row = (name) => {
      const lock = locks[name], locked = lock != null;
      const total = market.config.skills[name].values.length - 1;
      const low = floor[name].level, high = name in max ? top[name].level : total;
      const segs = Array.from({ length: total }, (_, i) => {
        const l = i + 1, off = l < low || l > high;
        return `<button type="button" class="fb-seg ${locked && l <= lock ? 'on' : l <= low ? 'prestige' : ''}${off ? ' locked' : ''}"
          data-fb-lock-skill="${name}" data-fb-lock-level="${l}" ${off ? 'disabled' : ''}
          aria-label="Lock ${SKILL_LABEL[name]} at level ${l}"></button>`;
      }).join('');
      return `<div class="fb-skill fb-skill-edit fb-lock-row ${locked ? 'fb-lock-on' : ''} fb-sk-${SKILL_COLOUR[name] || 'gray'}">
        <div class="fb-skill-head">${skillIcon(name)}<span class="fb-skill-name">${SKILL_LABEL[name]}</span>
          <span class="fb-skill-level">${locked ? `locked at level ${lock}${name === 'companies' ? `, ${companyCount(lock)} companies` : ''}`
            : `free, now level ${current[name].level}`}</span>
          <button type="button" class="secondary fb-small fb-lock-btn" data-fb-lock-toggle="${name}" aria-pressed="${locked}"
            title="${locked ? 'Locked: click to free' : `Free: click to lock at level ${current[name].level}`}">${PADLOCK(locked)}</button></div>
        <div class="fb-segs">${segs}</div></div>`;
    };
    return `<div class="fb-skill-groups">${SKILL_GROUPS.map(([title, names]) => {
      const rows = names.filter(n => modelled.includes(n)).map(row).join('');
      return rows ? `<section class="fb-skill-group"><h4>${title}</h4>${rows}</section>` : '';
    }).join('')}</div>`;
  }
  function changeLock(name, level) {
    const locks = { ...(st().skillLocks || {}) };
    if (level == null) delete locks[name]; else locks[name] = level;
    changeSettings({ skillLocks: locks });
    renderPanels();
  }

  // A fold whose overrides are set is highlighted, so a closed fold still says
  // the search is constrained.
  const locksActive = s => Object.values(s.skillLocks || {}).some(l => l != null) || s.equipmentBudget != null;
  function locksOverview(s) {
    const locks = Object.values(s.skillLocks || {}).filter(l => l != null).length;
    const set = [locks ? `${locks} lock${locks === 1 ? '' : 's'}` : '', s.equipmentBudget != null ? `budget ${coins(s.equipmentBudget, 0)}` : ''];
    return { head: set.filter(Boolean).join(' · ') || unit('defaults') };
  }
  const managerOverview = (s) => ({ head: s.managerRate != null ? `${fmt(s.managerRate, 4)} ${unit('a point an hour')}`
    : market.production?.managerRate == null ? 'pay unavailable' : 'market average' });
  function renderSettingFolds(s) {
    setFoldSummary('companies', managerOverview(s));
    setFoldSummary('locks', locksOverview(s));
    $out.querySelector('details[data-fb-fold="locks"]')?.classList.toggle('fb-fold-on', locksActive(s));
  }

  // --- Debuff spend-down ---
  // While a pill's debuff runs, anything the bars would regenerate past full
  // before it ends is wasted. The global tick on each UTC hour adds
  // hourlyBarRegen (10% of max) to health and hunger (watched live across
  // the 17:00 tick, 2026-10-24), so with n ticks left a bar can go down to
  // max − n·regen and still be full when the debuff ends. The bars move by
  // the minute, so they're read live rather than from the frozen snapshot.
  const HOUR_MS = 3_600_000;
  let debuffLive = null;   // the live bars and debuff end, or { error }
  let debuffToken = 0;

  const hourMark = (t) => Math.floor(t / HOUR_MS);
  const barFloor = (bar, ticks) => Math.max(0, bar.max - ticks * bar.regen);
  const barNum = (v) => fmt(Math.max(0, v), 1);
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const DEBUFF_HELP = `<p>While a pill's debuff runs, your bars refill by 10% of their size on every hour's tick. Anything that
    would refill past full before the debuff ends is lost. This works out how low you can take health and hunger now
    so the ticks left bring both back to full by the end, ready for the next pill.</p>
    <p>It reads your live bars and the gear you're wearing, not the snapshot the search uses. Each attack is counted
    at full cost after armor. Dodges cost nothing, so you usually get a few more. Eat when your health is low, so no
    healing goes to waste. Military-unit help isn't counted.</p>`;

  async function loadDebuff() {
    const userId = market?.profile.userId, mine = ++debuffToken;
    if (!userId) return;
    try {
      const u = await trpc('user.getUserById', { userId }, { retry: true, fresh: true });
      if (mine !== debuffToken) return;
      const bar = (s) => ({ now: s?.currentBarValue ?? 0, max: s?.total ?? s?.value ?? 0,
        regen: s?.hourlyBarRegen ?? (s?.total ?? s?.value ?? 0) / 10 });
      debuffLive = { at: Date.now(), health: bar(u.skills?.health), hunger: bar(u.skills?.hunger),
        armor: u.skills?.armor?.total || 0, dodge: u.skills?.dodge?.total || 0,
        endAt: u.buffs?.debuffEndAt ? Date.parse(u.buffs.debuffEndAt) : null, code: u.buffs?.debuffCodes?.[0] };
    } catch (e) {
      if (mine !== debuffToken) return;
      debuffLive = { error: e.message };
    }
    renderDebuff();
  }

  function renderDebuff() {
    const el = document.getElementById('fb-debuff');
    if (!el || !market) return;
    const d = debuffLive, now = Date.now();
    const refresh = (label) => `<button type="button" class="secondary" data-fb-debuff-refresh>${label}</button>`;
    let overview, body;
    if (!d) {
      body = '<p class="fb-note">Reading your live health, hunger and debuff…</p>';
    } else if (d.error) {
      body = `<p class="fb-note">Your live bars couldn't be read: ${escapeHtml(d.error)}</p>${refresh('Try again')}`;
    } else if (!d.endAt || d.endAt <= now) {
      body = `<p class="fb-note">${el.dataset.cadence} No debuff is running now${d.endAt ? ` (the last one ended at ${clock(d.endAt)})` : ''}.
        While one runs, this shows how low to take your bars so they're full again when it ends.</p>${refresh('Check for a debuff')}`;
    } else {
      // Bars change only on a tick, so the reading plus any ticks since is still current.
      const ticks = hourMark(d.endAt) - hourMark(now), since = hourMark(now) - hourMark(d.at);
      const current = (b) => Math.min(b.max, b.now + since * b.regen);
      const health = current(d.health), hunger = current(d.hunger);
      const hFloor = barFloor(d.health, ticks), gFloor = barFloor(d.hunger, ticks);
      const armor = FightingCore.softCapPercent(d.armor, market.config.skills.armor?.softCap) / 100;
      const perAttack = market.config.healthCost * (1 - armor);
      const attacks = Math.max(0, Math.floor((health - hFloor) / perAttack + 1e-9));
      const foods = Math.max(0, Math.floor(hunger - gFloor + 1e-9));
      const lastTick = hourMark(d.endAt) * HOUR_MS;
      const full = ticks === 0 ? 'No tick is left before it ends, so nothing more comes back: keep what you have.'
        : `The ${clock(lastTick)} tick brings both bars back to full.`;
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const pct = (v, max) => max > 0 ? Math.min(100, Math.max(0, v / max * 100)) : 0;

      // How far through the debuff, when the pill's debuff length is known.
      const debuffHours = market.config.items[d.code]?.debuffHours;
      const through = debuffHours ? pct(now - (d.endAt - debuffHours * HOUR_MS), debuffHours * HOUR_MS) : null;
      const tile = (label, value, sub, extra = '') => `<div class="fb-db-tile"><span class="fb-db-tile-label">${label}</span>
        <span class="fb-db-tile-value">${value}</span><span class="fb-detail">${sub}</span>${extra}</div>`;
      const tiles = `<div class="fb-db-tiles">
        ${tile('Debuff ends', clock(d.endAt), `in ${formatDuration(d.endAt - now)} · ${plural(ticks, 'tick')} left`,
          through == null ? '' : `<span class="fb-db-progress" role="img" aria-label="${Math.round(through)}% of the debuff gone"><span style="width:${through}%"></span></span>`)}
        ${tile('Spare attacks', attacks, `${barNum(perAttack)} health each after ${Math.round(armor * 100)}% armor`)}
        ${tile('Spare food', foods, foods ? `eat ${foods === 1 ? 'it' : 'them'} when health is low` : 'none above the floor')}
      </div>`;

      // A bar as the game draws it: what to keep, what to spend, and the
      // empty rest, with a notch at each tick's 10%.
      const meter = (name, label, bar, have, floor, spend) => {
        const f = pct(floor, bar.max), c = pct(have, bar.max), below = have < floor;
        return `<div class="fb-db-meter fb-sk-${SKILL_COLOUR[name]}">
          <div class="fb-db-meter-head">${skillIcon(name)}<span class="fb-db-meter-name">${label}</span>
            <span class="fb-db-meter-now">${barNum(have)} <span class="fb-detail">/ ${barNum(bar.max)}</span></span></div>
          <div class="fb-db-track" role="img" aria-label="${label} ${barNum(have)} of ${barNum(bar.max)}; go down to ${barNum(floor)}">
            <span class="fb-db-keep" style="width:${Math.min(c, f)}%"></span>
            <span class="fb-db-spend" style="left:${f}%;width:${Math.max(0, c - f)}%"></span>
            <span class="fb-db-floor" style="left:${f}%"></span>
          </div>
          <div class="fb-db-meter-foot"><span>Go down to <strong>${barNum(floor)}</strong></span>
            <span>${below ? `<span class="fb-db-below">${barNum(floor - have)} under: spend nothing</span>` : spend}</span></div>
        </div>`;
      };
      const meters = `<div class="fb-db-meters">
        ${meter('health', 'Health', d.health, health, hFloor, `spend ${barNum(health - hFloor)} · <strong>${plural(attacks, 'attack')}</strong>`)}
        ${meter('hunger', 'Hunger', d.hunger, hunger, gFloor, `spend ${barNum(hunger - gFloor)} · <strong>${foods} food</strong>`)}
        <div class="fb-db-legend"><span><span class="fb-db-key fb-db-key-keep"></span>keep</span>
          <span><span class="fb-db-key fb-db-key-spend"></span>spend</span><span><span class="fb-db-key fb-db-key-floor"></span>go down to</span>
          <span>each notch is one tick's refill</span></div>
      </div>`;

      // How low to go if you play later: the floor rises with each tick that
      // passes. Both bars refill the same share an hour, so one column holds both.
      const marks = Array.from({ length: ticks + 1 }, (_, k) => k ? (hourMark(now) + k) * HOUR_MS : now);
      const firstShown = Math.max(0, marks.findLastIndex((_, k) => barFloor(d.health, ticks - k) === 0 && barFloor(d.hunger, ticks - k) === 0));
      const later = marks.slice(firstShown).map((t, i) => {
        const left = ticks - firstShown - i, when = i + firstShown === 0 ? 'Now' : clock(t);
        return { when, left, health: barFloor(d.health, left), hunger: barFloor(d.hunger, left), share: pct(barFloor(d.health, left), d.health.max) };
      });
      const columns = later.map(r => `<div class="fb-db-col${r.when === 'Now' ? ' fb-db-col-now' : ''}"
          title="${r.when === 'Now' ? 'Now' : `After the ${r.when} tick`}: keep ${barNum(r.health)} health and ${barNum(r.hunger)} hunger (${plural(r.left, 'tick')} left)">
          <span class="fb-db-col-pct">${Math.round(r.share)}%</span>
          <span class="fb-db-col-track"><span style="height:${r.share}%"></span></span>
          <span class="fb-db-col-when">${r.when}</span></div>`).join('');
      const rows = later.map(r => `<tr><td>${r.when === 'Now' ? 'Now' : `After the ${r.when} tick`}</td>
          <td class="num">${barNum(r.health)}</td><td class="num">${barNum(r.hunger)}</td><td class="num">${r.left}</td></tr>`).join('');
      const timeline = ticks ? `<h4 class="fb-db-h">If you play later</h4>
        <p class="fb-detail">The share of each bar to keep, by when you next attack. It rises 10% with every tick.</p>
        <div class="fb-db-cols">${columns}</div>
        <details class="fb-db-table"><summary>Exact numbers</summary>
        <table class="fb-table"><thead><tr><th>When you play</th><th class="num">Health floor</th><th class="num">Hunger floor</th>
          <th class="num">Ticks left</th></tr></thead><tbody>${rows}</tbody></table></details>` : '';

      overview = { head: `keep ${barNum(hFloor)} ${unit('health ·')} ${barNum(gFloor)} ${unit('hunger')}`,
        detail: `${plural(attacks, 'attack')} spare` };
      body = `
        ${tiles}
        <p class="fb-note">${full} Take the bars down to the marker now and nothing refills past full.</p>
        ${meters}
        ${timeline}
        <div class="fb-controls fb-db-foot">${refresh('Refresh bars')}<span class="fb-detail">Read at ${clock(d.at)}; re-read after each tick.</span></div>`;
    }
    el.innerHTML = body;
    // While debuffed, the section's summary says how low to go; once the
    // debuff ends, the build redraws to put the schedule's summary back.
    const debuffed = !!overview;
    if (debuffed) setFoldSummary('fighting', overview);
    el.closest('details')?.classList.toggle('fb-fold-on', debuffed);
    if (el.dataset.debuffed && !debuffed) return renderBuild();
    el.dataset.debuffed = debuffed ? '1' : '';
  }

  // Redraw each half minute so the countdown keeps up, and re-read the bars
  // just after each tick lands (about 15 s past the hour). Only while the
  // tool is on screen: the router hides an inactive view rather than removing
  // it, and activate re-reads the bars on the way back.
  const $view = document.querySelector('.view[data-view="fighting-build"]');
  setInterval(() => {
    if (!market || !$view?.classList.contains('active') || document.hidden || !document.getElementById('fb-debuff')) return;
    if (debuffLive?.at && hourMark(Date.now() - 30_000) > hourMark(debuffLive.at)) loadDebuff();
    else renderDebuff();
  }, 30_000);
  document.addEventListener('click', (e) => { if (e.target.closest?.('[data-fb-debuff-refresh]')) loadDebuff(); });

  const modelledSkills = () => SKILL_GROUPS.flatMap(([, names]) => names).filter(k => market.config.skills[k]);
  // Every modelled skill locked at the player's current level.
  const currentLocks = () => {
    const current = FightingCore.effectiveSkills(market, market.profile.currentSkills || {});
    return Object.fromEntries(modelledSkills().map(k => [k, current[k].level]));
  };

  function renderPanels() {
    const s = FightingSnapshot.withSettings(market, settings).settings;
    const modelled = modelledSkills();
    document.getElementById('fb-panels').innerHTML = `
      ${fold('companies', 'Manager job', managerOverview(s), `
        <div class="fb-controls">
          <label>Pay per Management point an hour <input id="fb-manager-rate" type="number" min="0" step="0.0001" placeholder="${
            market.production?.managerRate == null ? 'market' : fmt(market.production.managerRate, 4)}" value="${s.managerRate ?? ''}"></label>
        </div>`, { help: `What managing another player's company pays you, for the Your manager job line. It's your
          Management points times this, every hour; blank uses the average of today's manager offers. Your companies,
          employees and managers are always valued as they run today.` })}
      ${fold('locks', 'Locks &amp; budget', locksOverview(s), `
        <div class="fb-controls">
          <button type="button" id="fb-lock-current" class="secondary">Lock all at your current levels</button>
          <button type="button" id="fb-lock-clear" class="secondary" ${locksActive(s) ? '' : 'disabled'}>Clear locks and budget</button>
        </div>
        ${lockEditorHtml(s.skillLocks || {}, modelled)}
        <div class="fb-controls">
          <label class="fb-toggle"><input id="fb-budget-on" type="checkbox" ${s.equipmentBudget != null ? 'checked' : ''}> Equipment budget</label>
          <label>Target ₿ <input id="fb-budget" type="number" min="0" step="10" value="${s.equipmentBudget ?? 500}" ${s.equipmentBudget == null ? 'disabled' : ''}></label>
        </div>`, { on: locksActive(s), help: `Lock a skill at a final effective level (prestige included).
          Locking Companies fixes how many companies every build runs. A lock that can't be met is explained, never relaxed.
          The equipment budget is a soft target: it steers the starting builds and labels builds above it, which stay
          browsable.` })}`;
  }

  // --- Saved snapshots ---
  // When a build was saved, as a relative chip ("5d") with the full date on
  // hover. Its prices are the page's, dated by the age pill at the top.
  const since = (ms) => ms < 60_000 ? '<1m' : formatDuration(ms).split(' ')[0];
  function savedChip(iso) {
    const ms = Math.max(0, Date.now() - Date.parse(iso));
    return Number.isFinite(ms) ? `<span class="fb-saved-chip" title="Saved ${escapeHtml(when(iso))}">saved ${since(ms)}</span>`
      : '<span class="fb-saved-chip" title="Saved at an unknown time">saved ?</span>';
  }
  // Days of balance it takes to earn back the gear.
  function payback(f) {
    const gear = f.equipmentPurchasePrice, bal = f.dailyBalance;
    if (gear == null || bal == null || !(gear > 0)) return '';
    if (!(bal > 0)) return 'never pays back';
    const days = gear / bal;
    return days < 1 ? 'pays back within a day' : `pays back in ${days < 10 ? days.toFixed(1) : fmtNum(Math.round(days))}d`;
  }
  function renderSaved() {
    const el = document.getElementById('fb-saved');
    if (!el) return;
    const tile = (label, value, sub = '') => `<div class="fb-saved-tile"><div class="fb-saved-k">${label}</div><div class="fb-saved-v">${value}</div>${
      sub ? `<div class="fb-saved-sub">${sub}</div>` : ''}</div>`;
    const cards = saved.map(e => {
      const r = run?.snapshot ? savedCandidate(e).result : null, f = r?.figures || {}, id = escapeHtml(e.id), on = shown.has(e.id);
      const missing = r && !r.complete ? r.missingPrices.map(itemName).join(', ') : '';
      const why = on && unplotted(shownBuilds().find(c => c.entry.id === e.id));
      return `<div class="fb-saved-card${on ? ' fb-saved-on' : ''}">
        <div class="fb-saved-head"><div class="fb-saved-name">${renaming === e.id
          ? `<input class="fb-rename" data-fb-rename-input="${id}" value="${escapeHtml(e.name || '')}" maxlength="80" aria-label="Snapshot name">`
          : `${escapeHtml(e.name || 'Build')} <button class="fb-rename-btn" data-fb-rename="${id}" title="Rename" aria-label="Rename">✎</button>`}
          <div class="fb-saved-chips">${savedChip(e.savedAt)}</div>
          <div class="fb-detail">${e.modelVersion}${e.manual ? ' · entered by hand' : ''}${
          e.shared ? ` · shared${e.shared.by ? ` by ${escapeHtml(e.shared.by)}` : ''}` : ''}</div></div>
          ${e.strategy.pill ? pilledTag : ''}</div>
        <div class="fb-saved-tiles">${tile('Damage/day', dmg(f.dailyDamage))}${tile('Balance/day', signed(f.dailyBalance))}${
          tile('Upfront gear', coins(f.equipmentPurchasePrice, 0), payback(f))}</div>
        ${r ? '' : '<div class="fb-detail">Load a player to value this build.</div>'}
        ${missing ? `<div class="fb-detail fb-saved-missing">Incomplete: no market price for ${escapeHtml(missing)}.</div>` : ''}
        ${why ? `<div class="fb-detail">Not plotted: ${escapeHtml(why)}</div>` : ''}
        <div class="fb-saved-foot">
          <button class="secondary fb-saved-chart" data-fb-show="${id}" aria-pressed="${on}" ${run?.result ? '' : 'disabled'}>${on ? '✓ On chart' : 'Show on chart'}</button>
          <button class="secondary" data-fb-edit-saved="${id}" ${run?.snapshot ? '' : 'disabled'}>Copy to your build</button>
          <details class="fb-saved-more"><summary aria-label="More actions" title="More actions">⋯</summary>
            <div class="fb-saved-menu"><button data-fb-share="${id}" ${market ? '' : 'disabled'}>Copy share link</button>
              <button class="fb-saved-remove" data-fb-remove="${id}">Remove</button></div></details>
        </div></div>`;
    }).join('');
    el.innerHTML = fold('saved', 'Saved snapshots', saved.length ? { head: `${saved.length} saved`, detail: shown.size ? `${shown.size} on the chart` : '' }
      : { head: unit('none yet') }, `
      <div class="fb-controls">
        <button id="fb-export" class="secondary" ${saved.length ? '' : 'disabled'}>Export JSON</button>
        <label class="secondary fb-file">Import JSON <input id="fb-import" type="file" accept="application/json,.json"></label>
      </div>
      ${saved.length ? `<div class="fb-saved-list">${cards}</div>` : '<p class="fb-note">Nothing saved yet.</p>'}`, { help: `Saved
      builds keep their skills, gear and consumables, never prices. Each is valued with the market prices, production and
      settings loaded on this page, so reloading brings them up to date. A gear roll with no recent sales leaves a build's
      figures incomplete.` });
  }

  function renameSaved(id, name) {
    renaming = null;
    const e = saved.find(x => x.id === id);
    if (!e || !name.trim() || name.trim() === e.name) return renderSaved();
    setSaved(FightingStore.replaceEntry(saved, { ...e, name: name.trim() }));
    if (shown.has(id) && run?.result) renderResults();
  }

  // --- Sharing ---
  // A share link carries a saved build's strategy, name and author in the
  // hash (#fighting-build?b=…), never prices: the recipient's copy is valued
  // with their own player, settings and market, like any saved build.
  //
  // The code is plain text, short enough to paste into chat, using only
  // URL-safe separators: fields split by ~, gear slots by _, numbers by dots.
  //   3~skills~gear~food~ammo~pill~debuff gear~debuff food~debuff ammo~author~priced~name
  // Skills are levels in SHARE_SKILLS order, a base-36 digit each. A slot is item.stat.stat….price,
  // stats in the order of the item's rolled stats (alphabetical), the price in
  // hundredths; an empty slot or consumable is empty. A debuff field or slot
  // of - is the same as the buff phase. Links are written without prices and
  // with priced left empty; a price in an incoming link is ignored. The
  // retired Entrepreneurship skill keeps its place so older links still read.
  const SHARE_SKILLS = ['attack', 'precision', 'criticalChance', 'criticalDamages', 'armor', 'dodge', 'health', 'hunger',
    'lootChance', 'companies', 'entrepreneurship', 'production', 'management', 'energy'];
  const shareStatKeys = (snapshot, code) => Object.keys(snapshot.config.items[code]?.ranges || {}).sort();
  const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);


  function shareLink(e) {
    const st = e.strategy, d = st.pill ? st.debuff : null;
    const slot = (ref) => ref ? [ref.code, ...shareStatKeys(market, ref.code).map(k => ref.stats[k] ?? 0)].join('.') : '';
    const gear = (equipment, same) => FightingCore.SLOTS.map(s =>
      same && sameJson(equipment[s], same[s]) ? '-' : slot(equipment[s])).join('_');
    const inherit = (k) => !d || !(k in d) || d[k] === st[k] ? '-' : d[k] || '';
    const fields = [3, SHARE_SKILLS.map(k => Math.min(35, st.skills?.[k] || 0).toString(36)).join(''), gear(st.equipment || {}),
      st.food || '', st.ammo || '', st.pill || '',
      d?.equipment ? gear(d.equipment, st.equipment || {}).replace(/^-(_-)*$/, '-') : '-', inherit('food'), inherit('ammo'),
      e.shared?.by || e.by || '', '',
      e.name || ''];
    return `${location.origin}${location.pathname}#fighting-build?b=${encodeURIComponent(fields.join('~')).replace(/%20/g, '+')}`;
  }

  // { name, by, strategy(snapshot) }: the strategy needs the item config to
  // read gear stats.
  async function readShare(code) {
    try {
      const f = code.split('~');
      if (f[0] !== '3' || f.length < 12) throw new Error();
      const [, skills, gear, food, ammo, pill, dGear, dFood, dAmmo, by] = f;
      const name = f.slice(11).join('~');
      const levels = [...skills].map(c => parseInt(c, 36));
      const slots = (snapshot, text, same) => Object.fromEntries(text.split('_').map((t, i) => {
        const s = FightingCore.SLOTS[i];
        if (t === '-' && same) return [s, same[s]];
        if (!t) return [s, null];
        const [code, ...nums] = t.split('.');
        const keys = shareStatKeys(snapshot, code);
        return [s, { code, stats: Object.fromEntries(keys.map((k, j) => [k, +nums[j] || 0])) }];
      }).filter(([s]) => s));
      return { name, by, strategy: (snapshot) => {
        const equipment = slots(snapshot, gear);
        const out = { skills: Object.fromEntries(SHARE_SKILLS.map((k, i) => [k, +levels[i] || 0])),
          equipment, food: food || null, ammo: ammo || null };
        if (pill) {
          out.pill = pill;
          out.debuff = {
            ...(dGear !== '-' ? { equipment: slots(snapshot, dGear, equipment) } : {}),
            ...(dFood !== '-' ? { food: dFood || null } : {}),
            ...(dAmmo !== '-' ? { ammo: dAmmo || null } : {}),
          };
        }
        return out;
      } };
    } catch { throw new Error('This share link is damaged or comes from a different version of the optimiser.'); }
  }

  async function copyShareLink(e) {
    const url = shareLink(e);
    try {
      await navigator.clipboard.writeText(url);
      setStatus(`Share link for "${e.name || 'Build'}" copied.`);
    } catch {
      window.prompt('Copy this share link:', url);
    }
  }

  // Add the build from a share link once there's a player to value it with.
  async function takeShared() {
    const code = pendingShare;
    if (!code) return;
    let data;
    try { data = await readShare(code); } catch (err) { pendingShare = null; return setStatus(err.message, true); }
    const name = data.name || 'Shared build';
    if (!run?.snapshot || !market) return setStatus(`Load your player to add the shared build "${name}" to your saved snapshots.`);
    if (pendingShare !== code) return;
    pendingShare = null;
    const strategy = FightingCompare.cleanStrategy(market, data.strategy(market));
    const entry = FightingStore.createEntry(strategy, { savedAt: new Date().toISOString(), name, by: data.by || null });
    setSaved(FightingStore.addEntry(saved, { ...entry, shared: { by: data.by || null } }));
    setStatus(`Added "${name}"${data.by ? ` from ${data.by}` : ''} to your saved snapshots, valued with your settings and market prices.`);
    flashFold('saved', { scroll: true });
  }

  function setSaved(entries) {
    saved = entries;
    if (!FightingStore.persist(saved)) setStatus('Could not store snapshots in this browser; export them to keep them.', true);
    renderSaved();
    renderCompare();
  }

  // --- Events ---
  function changeSettings(patch) {
    settings = { ...settings, ...patch,
      ...(patch.incomeToggles ? { incomeToggles: { ...settings.incomeToggles, ...patch.incomeToggles } } : {}) };
    startSearch();
    renderSettingFolds(FightingSnapshot.withSettings(market, settings).settings);
  }

  $out.addEventListener('input', e => {
    if (e.target.closest('#fb-manual, #fb-picker')) return editManual(e.target, false);
    if (e.target.id === 'fb-shop-days') {
      const d = +e.target.value;
      if (d > 0) { shopDays = d; renderShop(); }
      return;
    }
  });

  $out.addEventListener('change', e => {
    if (!market) return;
    const t = e.target, v = t.value;
    const n = v === '' || !isFinite(+v) ? null : +v;
    if (t.closest('#fb-manual, #fb-picker')) return editManual(t, true);
    if (t.id === 'fb-compare-a' || t.id === 'fb-compare-b') {
      compare = { a: document.getElementById('fb-compare-a').value, b: document.getElementById('fb-compare-b').value };
      return renderCompare();
    }
    if (t.dataset.fbToggle) return changeSettings({ incomeToggles: { [t.dataset.fbToggle]: t.checked } });
    if (t.id === 'fb-import') return importFile(t.files?.[0]);
    if (t.matches('.fb-replay-file')) return openReplay(t);
    if (t.id === 'fb-shop-days') return;
    const patch = {
      'fb-savings':         () => n == null ? null : { savingsTarget: n },
      'fb-loss':            () => n == null ? null : { lossAllowance: Math.max(0, n) },
      'fb-pill-mode':       () => ({ pillMode: v }),
      'fb-include-stale':   () => ({ includeStale: t.checked }),
      'fb-same-gear':       () => ({ sameGearBothPhases: t.checked }),
      // Matching the profile (or blank) follows the profile through refreshes.
      'fb-rank-damage':     () => ({ rankDamagePct: n == null || n === market.profile.rankDamagePct ? null : Math.max(0, n) }),
      'fb-battle-bonus':    () => n == null ? null : { battleBonus: n / 100 },
      'fb-bounty':          () => ({ bountyPer1000: n ?? 0 }),
      'fb-mu-help':         () => ({ muHelpHealthPerDay: n ?? 0 }),
      'fb-manager-rate':    () => ({ managerRate: n == null ? null : Math.max(0, n) }),
      'fb-budget-on':       () => {
        document.getElementById('fb-budget').disabled = !t.checked;
        return { equipmentBudget: t.checked ? +document.getElementById('fb-budget').value || 0 : null };
      },
      'fb-budget':          () => n == null ? null : { equipmentBudget: n },
    }[t.id]?.();
    if (patch) changeSettings(patch);
  });

  // While the slider is dragged (live), the chart, role cards and slider
  // follow once a frame, and the selected build's details and the comparison
  // wait until it rests: drawing those for every build passed over is what
  // made dragging lag.
  let selectFrame = 0, selectRest = 0;
  function select(id, { live = false } = {}) {
    if (!findBuild(id, { full: !live })) return;
    selectedId = id;
    cancelAnimationFrame(selectFrame);
    clearTimeout(selectRest);
    const quick = () => { renderCharts({ live: true }); renderRoles({ live: true }); renderBrowse({ live: true }); };
    const rest = () => {
      document.getElementById('fb-build')?.classList.remove('fb-pending');
      renderBuild();
      // The counterpart the drag left off the chart, now that it's worked out.
      if (counterpartLater) renderCharts({ live: true });
      renderManualSummary(); renderCompare();
    };
    // A tap draws the build first, which works out its counterpart, so the
    // chart draws it straight away.
    if (!live) { counterpartLater = false; rest(); quick(); return; }
    document.getElementById('fb-build')?.classList.add('fb-pending');
    selectFrame = requestAnimationFrame(quick);
    selectRest = setTimeout(rest, 200);
  }

  $out.addEventListener('click', async e => {
    const t = e.target;
    for (const m of $out.querySelectorAll('details.fb-saved-more[open]')) if (!m.contains(t) || t.closest('.fb-saved-menu')) m.open = false;
    // A phone's shopping-list line opens on a tap anywhere along it.
    const line = t.closest?.('.fb-shop-row')?.parentElement;
    if (line && getComputedStyle(line.querySelector('.fb-shop-open')).display !== 'none') {
      const open = line.classList.toggle('fb-shop-opened');
      line.querySelector('.fb-shop-open').setAttribute('aria-expanded', open);
      return;
    }
    const go = t.closest?.('[data-fb-go]');
    if (go) {
      const f = $out.querySelector(`[data-fb-fold="${go.dataset.fbGo}"], [data-fb-card="${go.dataset.fbGo}"]`);
      if (!f) return;
      if (f.tagName === 'DETAILS') f.open = true;
      if (go.dataset.fbFocus) document.getElementById(go.dataset.fbFocus)?.focus({ preventScroll: true });
      // A brief outline marks where the jump landed.
      f.classList.remove('fb-flash'); void f.offsetWidth; f.classList.add('fb-flash');
      // Clear of the pinned line, which shows once the cards scroll away;
      // re-aimed when the scroll ends, as content loading in on the way shifts it.
      const gap = () => f.getBoundingClientRect().top - document.getElementById('fb-pinned').offsetHeight - 8;
      if (Math.abs(gap()) <= 2) return;
      window.addEventListener('scrollend', () => { if (Math.abs(gap()) > 2) window.scrollBy(0, gap()); }, { once: true });
      return window.scrollTo({ top: scrollY + gap(), behavior: 'smooth' });
    }
    const mb = t.closest?.('button[data-fb-m]');
    if (mb && mb.closest('#fb-manual, #fb-picker')) return clickManual(mb);
    // A click on the picker's backdrop closes it.
    if (t.id === 'fb-picker') {
      const r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) t.close();
      return;
    }
    if (t.id === 'fb-stop') {
      run.stop = true;
      stopWorkers(run);
      return;
    }
    const lk = t.closest?.('[data-fb-lock-skill], [data-fb-lock-toggle]');
    if (lk) {
      const { fbLockSkill: name, fbLockLevel: level, fbLockToggle: toggle } = lk.dataset;
      const locks = st().skillLocks || {};
      if (toggle) changeLock(toggle, locks[toggle] != null ? null
        : FightingCore.effectiveSkills(market, market.profile.currentSkills || {})[toggle].level);
      else changeLock(name, locks[name] === +level ? lockFloor(name) : +level);
      const sel = toggle ? `[data-fb-lock-toggle="${toggle}"]` : `[data-fb-lock-skill="${name}"][data-fb-lock-level="${level}"]`;
      return document.querySelector(`#fb-panels ${sel}`)?.focus();
    }
    if (t.id === 'fb-lock-current' || t.id === 'fb-lock-clear') {
      changeSettings(t.id === 'fb-lock-clear' ? { skillLocks: {}, equipmentBudget: null } : { skillLocks: currentLocks() });
      renderPanels();
      return document.getElementById(locksActive(st()) ? t.id : 'fb-lock-current')?.focus();
    }
    if (t.id === 'fb-longer') return drive(LONGER_MS);
    if (t.id === 'fb-replay-save') return downloadInputs();
    if (t.closest?.('#fb-age')) { $username.value = market.profile.username; return handleSubmit(); }
    if (t.closest?.('#fb-chart-full')) return openFullChart();
    const view = t.closest?.('[data-fb-view]');
    if (view) { ({ bands, all: chartAll = false } = VIEWS[+view.dataset.fbView]); renderCharts(); return renderBrowse(); }
    if (t.id === 'fb-prev' || t.id === 'fb-next') return stepTo(neighbour(t.id === 'fb-next' ? 1 : -1));
    if (t.id === 'fb-chart-close') return closeFullChart();
    if (t.id === 'fb-save') return saveCandidate(findBuild(selectedId));
    if (t.id === 'fb-edit') return copyToManual(findBuild(selectedId));
    if (t.dataset?.fbEditSaved) return copyToManual(findBuild(`saved:${t.dataset.fbEditSaved}`));
    if (t.id === 'fb-manual-show') { select('manual'); return document.getElementById('fb-build')?.scrollIntoView({ behavior: 'smooth' }); }
    if (t.id === 'fb-manual-save') return saveCandidate(manualCandidate());
    if (t.id === 'fb-manual-apply') return applyManual();
    if (t.id === 'fb-manual-discard') { edit = toEdit(manual); return renderManual(); }
    if (t.id === 'fb-manual-clear-prices') return clearEditPrices();
    if (t.id === 'fb-manual-reset') { edit = toEdit(FightingCompare.profileDraft(market)); return applyManual(); }
    if (t.id === 'fb-compare-swap') {
      compare = { a: document.getElementById('fb-compare-b').value, b: document.getElementById('fb-compare-a').value };
      return renderCompare();
    }
    if (t.dataset?.fbHoldBudget) {
      holdBudget = t.dataset.fbHoldBudget;
      try { localStorage.setItem(HOLD_KEY, holdBudget); } catch {}
      renderBuild();
      return renderCharts();
    }
    if (t.dataset?.fbShopDays) {
      shopDays = +t.dataset.fbShopDays;
      document.getElementById('fb-shop-days').value = shopDays;
      return renderShop();
    }
    if (t.dataset?.fbShopOwn) {
      shopOwnGear = t.dataset.fbShopOwn === '1';
      return renderShop();
    }
    if (t.dataset?.fbShow) {
      const id = t.dataset.fbShow;
      if (!shown.delete(id)) shown.add(id);
      const c = shownBuilds().find(x => x.entry.id === id);
      if (c && !unplotted(c)) selectedId = c.id;
      renderSaved();
      return renderResults();
    }
    if (t.dataset?.fbRename) {
      renaming = t.dataset.fbRename;
      renderSaved();
      const input = $out.querySelector('input[data-fb-rename-input]');
      input?.focus();
      return input?.select();
    }
    if (t.dataset?.fbShare) {
      const e = saved.find(x => x.id === t.dataset.fbShare);
      return e && copyShareLink(e).catch(err => setStatus(err.message, true));
    }
    if (t.dataset?.fbRemove) {
      const wasShown = shown.delete(t.dataset.fbRemove);
      setSaved(FightingStore.removeEntry(saved, t.dataset.fbRemove));
      if (wasShown && run?.result) renderResults();
      return;
    }
    if (t.id === 'fb-export') {
      const blob = new Blob([FightingStore.exportEntries(saved)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'fighting-build-snapshots.json' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const sel = t.closest?.('[data-fb-select]');
    if (sel && !(sel.closest('svg') && performance.now() - scrubEnded < 400)) select(sel.dataset.fbSelect);
  });
  $out.addEventListener('focusout', e => {
    const id = e.target.dataset?.fbRenameInput;
    if (id && renaming === id) renameSaved(id, e.target.value);
  });
  $out.addEventListener('keydown', e => {
    if (e.target.dataset?.fbRenameInput) {
      if (e.key === 'Enter') renameSaved(e.target.dataset.fbRenameInput, e.target.value);
      if (e.key === 'Escape') { renaming = null; renderSaved(); }
      return;
    }
    // Enter in the editor applies it, once the field's change is in.
    if (e.key === 'Enter' && e.target.matches?.('#fb-manual input')) {
      editManual(e.target, true);
      if (editDirty()) applyManual();
      return;
    }
    const sel = e.target.closest?.('.fb-role[data-fb-select]');
    if (sel && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(sel.dataset.fbSelect); }
    if (e.target.id === 'fb-step') {
      const page = Math.max(1, Math.round(browseSteps.length / 10)), at = browseSteps.findIndex(c => c.id === selectedId);
      const to = { Home: () => browseSteps[0], End: () => browseSteps.at(-1),
        PageDown: () => browseSteps[Math.max(0, at - page)], PageUp: () => browseSteps[Math.min(browseSteps.length - 1, at + page)],
        ArrowLeft: () => neighbour(-1), ArrowDown: () => neighbour(-1), ArrowRight: () => neighbour(1), ArrowUp: () => neighbour(1) }[e.key];
      if (to) { e.preventDefault(); stepTo(to()); }
    }
  });
  // Dragging sideways across the chart steps through its builds, the one
  // nearest the finger in cost each time; an upward or downward drag is
  // left to scroll the page, and a tap still selects the point under it.
  let scrub = null, scrubEnded = 0;
  $out.addEventListener('pointerdown', e => {
    if (e.button || !e.target.closest?.('#fb-charts .fb-chart svg')) return;
    scrub = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
  });
  $out.addEventListener('pointermove', e => {
    if (!scrub || scrub.id !== e.pointerId) return;
    if (!scrub.on) {
      const dx = Math.abs(e.clientX - scrub.x), dy = Math.abs(e.clientY - scrub.y);
      if (dy > dx && dy > 8) { scrub = null; return; }
      if (dx < 8) return;
      scrub.on = true;
      $out.setPointerCapture(e.pointerId);
      document.getElementById('fb-chart-wrap')?.classList.add('fb-scrubbing');
      hideTooltip();
    }
    const svg = document.querySelector('#fb-charts .fb-chart svg');
    if (!svg || !chartScale || !browseSteps.length) return;
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * chartScale.W / r.width;
    const gap = browseSteps.map(c => Math.abs(chartScale.sx(netCost(c)) - x));
    stepTo(browseSteps[gap.indexOf(Math.min(...gap))], e);
  });
  const endScrub = (e) => {
    if (!scrub || scrub.id !== e.pointerId) return;
    if (scrub.on) scrubEnded = performance.now();
    scrub = null;
    document.getElementById('fb-chart-wrap')?.classList.remove('fb-scrubbing');
  };
  $out.addEventListener('pointerup', endScrub);
  $out.addEventListener('pointercancel', endScrub);
  $out.addEventListener('mousemove', showTooltip);
  // The tooltip is fixed to the viewport: scrolling moves the chart from
  // under a still pointer without a mousemove, so hide it then too.
  const hideTooltip = () => {
    const tip = document.getElementById('fb-tooltip');
    if (tip && !tip.classList.contains('hidden')) tip.classList.add('hidden');
  };
  $out.addEventListener('mouseleave', hideTooltip);
  window.addEventListener('scroll', hideTooltip, { passive: true, capture: true });

  async function importFile(file) {
    if (!file) return;
    try {
      setSaved(FightingStore.mergeEntries(saved, FightingStore.importEntries(await file.text())));
      setStatus('');
      flashFold('saved');
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  let loadToken = 0;
  async function handleSubmit() {
    const raw = $username.value.trim();
    if (!raw) { setStatus('Please enter an in-game username.', true); $username.focus(); return; }
    if (insecure()) { setStatus(insecure(), true); return; }
    // A load started over a stalled one replaces it: the old one's results
    // are dropped when they arrive.
    const mine = ++loadToken;
    $go.disabled = true;
    replay = null;
    renderReplay();
    endRun();
    $out.innerHTML = '';
    $hint.classList.add('hidden');
    setStatus('');
    restoreSteps.hide();
    steps.reset();
    try {
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      const player = await ProfitCore.resolveUsername(raw);
      if (mine !== loadToken) return;
      if (!player) { steps.markActiveAsError('No user found'); throw new Error(`No War Era user found with username "${raw}".`); }
      enforceIrishOnly(player.country ?? player.countryId, player.username);
      steps.setStep(1, 'done', { count: `→ ${player.username}` });
      try { window.history.replaceState(null, '', `#fighting-build?u=${encodeURIComponent(player.username)}`); } catch {}

      const loaded = await FightingSnapshot.load(player, { step: (n, state, info) => { if (mine === loadToken) steps.setStep(n, state, info); } });
      if (mine !== loadToken) return;
      market = loaded;
      const stored = readManualStore()[market.profile.userId];
      manual = stored ? FightingCompare.cleanStrategy(market, stored) : FightingCompare.profileDraft(market);
      edit = toEdit(manual);
      setStatus('');
      // A fresh load starts with the skills as they are; unlock any to let the search move points.
      settings = { skillLocks: currentLocks() };
      selectedId = null;
      steps.fadeOut(300);
      renderShell();
      startSearch();
      takeShared();
      RecentPlayers.remember(player.username);
    } catch (e) {
      if (mine !== loadToken) return;
      steps.markActiveAsError(e.message);
      setStatus(e.message, true);
    } finally {
      if (mine === loadToken) $go.disabled = false;
    }
  }

  $go.addEventListener('click', handleSubmit);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  RecentPlayers.mount(document.getElementById('fb-recent'), u => { $username.value = u; handleSubmit(); });

  let restoredOnce = false;
  return {
    async activate(params) {
      const u = (params && params.get && params.get('u')) || '';
      const b = params?.get?.('b');
      if (b) {
        pendingShare = b;
        try { window.history.replaceState(null, '', `#fighting-build${u ? `?u=${encodeURIComponent(u)}` : ''}`); } catch {}
      }
      if (run) renderDataAge();
      if (market && document.getElementById('fb-debuff')) loadDebuff();
      if (!restoredOnce) {
        restoredOnce = true;
        const mine = loadToken;
        if (await restoreSearch(u, mine)) return takeShared();
        if (mine !== loadToken) return;
      }
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; handleSubmit(); }
      else if (!u && !$username.value) $username.focus();
      takeShared();
    },
  };
})();
