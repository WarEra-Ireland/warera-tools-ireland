/* ═══════════════════════════════════════════════════════════════════
 *  EMPLOYEE TRAINING  (#training)
 *
 *  Tabs over the loaded account: Overview
 *  (where to spend energy), Employees, Train (rank the hand an employee
 *  was dealt), Keep or replace, Hire and Assignments. The
 *  tab and the selected employee live in the hash:
 *  #training?u=<username>&tab=<tab>&emp=<employee id>. A loaded account
 *  is required; the employee tabs work on one selected employee.
 *
 *  All rankings come from EmployeeCore (js/employee-core.js), which
 *  prices each card as the production points it adds over the
 *  employee's working life.
 *
 *  Data, all from the official API:
 *
 *    • Your employees: username → companies → employee.getCompanyEmployees
 *      and employee.getCompanyEstimate. These answer for any company with
 *      any key, so they go through the shared proxy. Selecting an employee
 *      fills the Train tab, including the hand they were dealt and haven't
 *      picked from yet (pendingTraining.offers).
 *    • Product prices: each product's margin per PP (sale price after
 *      market tax, minus inputs, over its production points, from the
 *      latest trades, as in the Top products) over the game's value of
 *      a PP. 1.00× is an average product.
 *
 *  Access: loading employees is for Irish citizens (enforceIrishOnly), like
 *  the Top products. bypass=1 lifts it.
 * ═══════════════════════════════════════════════════════════════════ */
const EmployeeTrainingTool = (() => {
  const EC = EmployeeCore;
  const STAT = { production: 'Production', responsibility: 'Responsibility', luck: 'Luck' };
  const STAT_SHORT = { production: 'Prod', responsibility: 'Resp', luck: 'Luck' };
  const RARITY_NAME = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
  const RECENT_KEY = 'tr:recent-usernames';
  const RECENT_MAX = 8;
  const IRELAND = IRELAND_COUNTRY_ID;
  const PRICE_SAMPLE_TRADES = 100;
  const PRICE_MAX_AGE_MS = 24 * 3600 * 1000;
  const PRODUCT_NAME = { cocain: 'Pill', coca: 'Mysterious Plant', cookedFish: 'Cooked Fish', heavyAmmo: 'Heavy Ammo', lightAmmo: 'Light Ammo' };
  const words = code => code.replace(/([A-Z])/g, ' $1').replace(/^./, ch => ch.toUpperCase());
  const productName = code => PRODUCT_NAME[code] || words(code);

  const $calc     = document.getElementById('tr-calc-body');
  const $username = document.getElementById('tr-username');
  const $load     = document.getElementById('tr-load');
  const $recent   = document.getElementById('tr-recent');
  const $shell    = document.getElementById('tr-shell');
  const $hint     = document.getElementById('tr-hint');
  const $tabs     = document.getElementById('tr-tabs');
  const $pick     = document.getElementById('tr-pick');
  const $work     = document.getElementById('tr-work');
  const $side     = document.getElementById('tr-side');
  const $empHead  = document.getElementById('tr-emp-head');
  const $team     = document.getElementById('tr-team');
  const $roster   = document.getElementById('tr-roster');
  const setStatus = makeStatus(document.getElementById('tr-status'));
  const steps = makeSteps(document.getElementById('tr-steps'));

  function help(label, content, trait = false) {
    return `<span class="tr-help${trait ? ' tr-trait-help' : ' tr-section-help'}"><button type="button" class="tr-help-trigger" aria-expanded="false"${trait ? '' : ` aria-label="${escapeHtml(label)}"`}>${trait ? label : '<span aria-hidden="true">ⓘ</span>'}</button><span class="tr-help-content" role="tooltip" hidden>${content}</span></span>`;
  }

  function wireHelp() {
    const view = document.querySelector('[data-view="training"]');
    let active = null;
    let pinned = false;
    let nextId = 0;
    let closeTimer;
    const close = () => {
      clearTimeout(closeTimer);
      if (!active) return;
      active.querySelector('.tr-help-content').hidden = true;
      active.querySelector('button').setAttribute('aria-expanded', 'false');
      active = null;
      pinned = false;
    };
    const position = () => {
      if (!active) return;
      if (!active.isConnected || !view.classList.contains('active')) { close(); return; }
      const tip = active.querySelector('.tr-help-content');
      const rect = active.querySelector('button').getBoundingClientRect();
      const gap = 8;
      tip.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - tip.offsetWidth - gap))}px`;
      const below = rect.bottom + gap;
      tip.style.top = `${Math.max(gap, below + tip.offsetHeight <= innerHeight - gap ? below : rect.top - tip.offsetHeight - gap)}px`;
    };
    const show = wrapper => {
      clearTimeout(closeTimer);
      if (active === wrapper) return;
      close();
      active = wrapper;
      const tip = active.querySelector('.tr-help-content');
      const button = active.querySelector('button');
      if (!tip.id) tip.id = `tr-help-${++nextId}`;
      button.setAttribute('aria-describedby', tip.id);
      button.setAttribute('aria-expanded', 'true');
      tip.hidden = false;
      position();
    };
    view.addEventListener('pointerover', ev => {
      const wrapper = ev.target.closest('.tr-help');
      if (wrapper) clearTimeout(closeTimer);
      if (wrapper && ev.pointerType === 'mouse' && !pinned) show(wrapper);
    });
    view.addEventListener('pointerout', ev => {
      if (active && !pinned && !active.contains(ev.relatedTarget) && !active.contains(document.activeElement)) closeTimer = setTimeout(close, 150);
    });
    view.addEventListener('focusin', ev => {
      const wrapper = ev.target.closest('.tr-help');
      if (wrapper) show(wrapper);
    });
    view.addEventListener('focusout', ev => {
      if (active && !active.contains(ev.relatedTarget)) close();
    });
    document.addEventListener('click', ev => {
      const button = ev.target.closest('.tr-help-trigger');
      if (button && view.contains(button)) {
        if (active === button.parentElement && pinned) close();
        else { show(button.parentElement); pinned = true; }
      } else if (active && !active.contains(ev.target)) close();
    });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') close(); });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    new MutationObserver(() => { if (active) position(); }).observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  let mounted = false;
  // Called with a fresh snapshot() whenever the Overview redraws (watch).
  const watchers = new Set();
  // { ppValue, list: [{ code, perPP, ratio }] best first }, once loaded.
  let market = null;
  let marketLoad = null;
  // The loaded player: { username, management, companies: [{ company, employees, estimate }] }.
  let team = null;
  let nextActionsExpanded = false;
  let busy = false;
  let assignments = null;
  const TABS = ['overview', 'employees', 'train', 'keep', 'hire', 'assignments'];
  // Tabs about one employee, under the shared picker.
  const EMP_TABS = ['train', 'keep'];
  // The open tab; emp is an employee asked for by the link, until the team loads.
  const view = { tab: 'overview', emp: null };
  // The background planner's latest result (EmployeeAssignments onResult).
  let plan = null;
  // Cards marked as taken since the last load: employee id → { text, rolled }.
  // Their records in `team` already carry the card (EmployeeCore.takeCard).
  const taken = new Map();

  const readRecent = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const writeRecent = list => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {} };
  function rememberUsername(username) {
    writeRecent([username, ...readRecent().filter(x => x.toLowerCase() !== username.toLowerCase())]);
    renderRecent();
  }
  function renderRecent() {
    const list = readRecent();
    $recent.classList.toggle('hidden', !list.length);
    $recent.innerHTML = list.length ? '<span class="stg-recent-label">Recent:</span>' + list.map(username => {
      const s = escapeHtml(username);
      return `<span class="stg-recent-chip"><button type="button" class="stg-recent-pick" data-tr-recent="${s}">${s}</button><button type="button" class="stg-recent-del" data-tr-recent-del="${s}" aria-label="Remove ${s} from recent users" title="Remove">×</button></span>`;
    }).join('') : '';
  }

  /* ── Market: product margins over the PP value ───────────── */
  async function loadMarket() {
    const [ppValue, config, country] = await Promise.all([
      trpc('gameStat.getPpMoneyValue', null, { retry: true }),
      trpc('gameConfig.getGameConfig', {}, { retry: true }),
      trpc('country.getCountryById', { countryId: IRELAND }, { retry: true }).catch(() => null),
    ]);
    const items = config?.items || {};
    const codes = Object.keys(items).filter(c => items[c]?.productionPoints);
    const pages = await trpcManyValues('transaction.getPaginatedTransactions', codes.map(itemCode => ({
      transactionType: 'trading', itemCode, limit: PRICE_SAMPLE_TRADES,
    })));
    const cutoff = Date.now() - PRICE_MAX_AGE_MS;
    const price = {};
    pages.forEach((page, i) => {
      let money = 0, qty = 0;
      for (const tx of page?.items || []) {
        if (!(tx.quantity > 0) || typeof tx.money !== 'number' || new Date(tx.createdAt).getTime() < cutoff) continue;
        money += tx.money; qty += tx.quantity;
      }
      if (qty > 0) price[codes[i]] = money / qty;
    });
    const tax = (country?.taxes?.market || 0) / 100;
    const list = codes.flatMap(code => {
      if (price[code] == null || !(ppValue > 0)) return [];
      let inputs = 0;
      for (const [need, n] of Object.entries(items[code].productionNeeds || {})) {
        if (price[need] == null) return [];
        inputs += n * price[need];
      }
      const perPP = (price[code] * (1 - tax) - inputs) / items[code].productionPoints;
      return [{ code, perPP, ratio: perPP / ppValue }];
    }).sort((a, b) => b.ratio - a.ratio);
    const types = Object.fromEntries(codes.map(c => [c, items[c].type]));
    return { ppValue: ppValue > 0 ? ppValue : null, list, types };
  }
  const productFor = code => market?.list.find(p => p.code === code) || null;

  /* ── Calculator ──────────────────────────────────────────── */
  // The cards a hand of each rarity can hold, by kind. Trait kinds take one
  // trait (two for a Habit pair) from the lists below.
  const TRAIT_KINDS = {
    uncommon:  [{ card: 'wildCard' }],
    rare:      [{ card: 'rehab', polarity: 'negative' }, { card: 'habit', polarity: 'mixed' }],
    epic:      [{ card: 'habit', polarity: 'positive' }],
    legendary: [{ card: 'habitPair', polarity: 'positive' }, { card: 'rehabAll' }],
  };
  // Mentoring isn't in the game's own card pool, so its rarity is unknown:
  // a hand of any rarity may hold it.
  const handKinds = r => [...EC.NUMERIC_CARDS[r], ...(TRAIT_KINDS[r] || []), { card: 'mentoring' }];
  const traitName = code => EC.TRAIT[code]?.name || words(code);
  const traitDescription = code => (EC.TRAIT[code]?.when || 'Effect unknown for this trait.')
    .replace(/\bProd\b/g, 'Production').replace(/\bResp\b/g, 'Responsibility');
  function traitHelp(code, label = escapeHtml(traitName(code)), extra = '') {
    return help(label, `${escapeHtml(traitDescription(code))}${extra ? ` ${escapeHtml(extra)}` : ''}`, true);
  }

  const heldCodes = () => input.traits.map(t => t.code);
  // A trait's rolled target: a product, a stat, or a coworker (Old Friends
  // names an employee by id).
  function argText(t) {
    if (!t.arg) return '';
    if (EC.TRAIT[t.code]?.arg === 'good') return ` (${productName(t.arg)})`;
    if (STAT[t.arg]) return ` (${STAT[t.arg]})`;
    const who = findEmployee(t.arg)?.emp.name;
    return who ? ` (${who})` : /^[0-9a-f]{24}$/.test(t.arg) ? ' (a former coworker)' : ` (${t.arg})`;
  }

  // A link to a company's page in the game. Employees have no page of
  // their own; the company page lists them, so their names link there too.
  // The title carries the full text too, for names cut short by an ellipsis.
  const gameLink = (company, text) =>
    `<a href="${GAME_BASE}/company/${encodeURIComponent(company._id)}" target="_blank" rel="noopener" title="${escapeHtml(text)}: open in game">${escapeHtml(text)}</a>`;
  const companyLink = company => gameLink(company, companyName(company));
  // A company's name, numbered when several share it (new companies are
  // all "My new company"); with its product for lists.
  function companyName(company) {
    const name = company.name || 'Company';
    const same = (team?.companies || []).map(x => x.company).filter(c => (c.name || 'Company') === name);
    const n = same.findIndex(c => c._id === company._id);
    return `${name}${same.length > 1 && n >= 0 ? ` (${n + 1})` : ''}`;
  }
  const companyLabel = company => `${companyName(company)} · ${productName(company.itemCode || '?')}`;
  function productIcon(code) {
    const name = escapeHtml(productName(code || '?'));
    const file = ProductPickerTool.ITEMS[code]?.file;
    return file ? `<img class="tr-product-icon" src="images/${escapeHtml(file)}" alt="${name}" title="${name}" width="22" height="22">` : name;
  }
  const companyLabelHtml = company => `${escapeHtml(companyName(company))} · ${productIcon(company.itemCode)}`;

  // The game's own icons (Material Design paths), for the hand cards.
  const GAME_ICON = {
    production: 'M14.79,10.62L3.5,21.9L2.1,20.5L13.38,9.21L14.79,10.62M19.27,7.73L19.86,7.14L19.07,6.35L19.71,5.71L18.29,4.29L17.65,4.93L16.86,4.14L16.27,4.73C14.53,3.31 12.57,2.17 10.47,1.37L9.64,3.16C11.39,4.08 13,5.19 14.5,6.5L14,7L17,10L17.5,9.5C18.81,11 19.92,12.61 20.84,14.36L22.63,13.53C21.83,11.43 20.69,9.47 19.27,7.73Z',
    responsibility: 'M6,2L10,6L7,17L12,22L17,17L14,6L18,2Z',
    luck: 'M12,11.18C15.3,8.18 17,6.64 17,4.69C17,3.19 15.75,2 14.25,2C13.39,2 12.57,2.36 12,3C11.43,2.36 10.61,2 9.69,2C8.19,2 7,3.25 7,4.75C7,6.64 8.7,8.18 12,11.18M11.18,12C8.18,8.7 6.64,7 4.69,7C3.19,7 2,8.25 2,9.75C2,10.61 2.36,11.43 3,12C2.36,12.57 2,13.39 2,14.31C2,15.81 3.25,17 4.75,17C6.64,17 8.18,15.3 11.18,12M12.83,12C15.82,15.3 17.36,17 19.31,17C20.81,17 22,15.75 22,14.25C22,13.39 21.64,12.57 21,12C21.64,11.43 22,10.61 22,9.69C22,8.19 20.75,7 19.25,7C17.36,7 15.82,8.7 12.83,12M12,12.82C8.7,15.82 7,17.36 7,19.31C7,20.81 8.25,22 9.75,22C10.61,22 11.43,21.64 12,21C12.57,21.64 13.39,22 14.31,22C15.81,22 17,20.75 17,19.25C17,17.36 15.3,15.82 12,12.82Z',
    drill: 'M20.57,14.86L22,13.43L20.57,12L17,15.57L8.43,7L12,3.43L10.57,2L9.14,3.43L7.71,2L5.57,4.14L4.14,2.71L2.71,4.14L4.14,5.57L2,7.71L3.43,9.14L2,10.57L3.43,12L7,8.43L15.57,17L12,20.57L13.43,22L14.86,20.57L16.29,22L18.43,19.86L19.86,21.29L21.29,19.86L19.86,18.43L22,16.29L20.57,14.86Z',
    wildCard: 'M19.78,3H11.22C10.55,3 10,3.55 10,4.22V8H16V14H19.78C20.45,14 21,13.45 21,12.78V4.22C21,3.55 20.45,3 19.78,3M12.44,6.67C11.76,6.67 11.21,6.12 11.21,5.44C11.21,4.76 11.76,4.21 12.44,4.21A1.23,1.23 0 0,1 13.67,5.44C13.67,6.12 13.12,6.67 12.44,6.67M18.56,12.78C17.88,12.79 17.33,12.24 17.32,11.56C17.31,10.88 17.86,10.33 18.54,10.32C19.22,10.31 19.77,10.86 19.78,11.56C19.77,12.23 19.23,12.77 18.56,12.78M18.56,6.67C17.88,6.68 17.33,6.13 17.32,5.45C17.31,4.77 17.86,4.22 18.54,4.21C19.22,4.2 19.77,4.75 19.78,5.44C19.78,6.12 19.24,6.66 18.56,6.67M4.22,10H12.78A1.22,1.22 0 0,1 14,11.22V19.78C14,20.45 13.45,21 12.78,21H4.22C3.55,21 3,20.45 3,19.78V11.22C3,10.55 3.55,10 4.22,10M8.5,14.28C7.83,14.28 7.28,14.83 7.28,15.5C7.28,16.17 7.83,16.72 8.5,16.72C9.17,16.72 9.72,16.17 9.72,15.5A1.22,1.22 0 0,0 8.5,14.28M5.44,11.22C4.77,11.22 4.22,11.77 4.22,12.44A1.22,1.22 0 0,0 5.44,13.66C6.11,13.66 6.66,13.11 6.66,12.44V12.44C6.66,11.77 6.11,11.22 5.44,11.22M11.55,17.33C10.88,17.33 10.33,17.88 10.33,18.55C10.33,19.22 10.88,19.77 11.55,19.77A1.22,1.22 0 0,0 12.77,18.55H12.77C12.77,17.88 12.23,17.34 11.56,17.33H11.55Z',
    negotiation: 'M16 12C18.76 12 21 9.76 21 7S18.76 2 16 2 11 4.24 11 7 13.24 12 16 12M21.45 17.6C21.06 17.2 20.57 17 20 17H13L10.92 16.27L11.25 15.33L13 16H15.8C16.15 16 16.43 15.86 16.66 15.63S17 15.12 17 14.81C17 14.27 16.74 13.9 16.22 13.69L8.95 11H7V20L14 22L22.03 19C22.04 18.47 21.84 18 21.45 17.6M5 11H.984V22H5V11Z',
    secondWind: 'M4,10A1,1 0 0,1 3,9A1,1 0 0,1 4,8H12A2,2 0 0,0 14,6A2,2 0 0,0 12,4C11.45,4 10.95,4.22 10.59,4.59C10.2,5 9.56,5 9.17,4.59C8.78,4.2 8.78,3.56 9.17,3.17C9.9,2.45 10.9,2 12,2A4,4 0 0,1 16,6A4,4 0 0,1 12,10H4M19,12A1,1 0 0,0 20,11A1,1 0 0,0 19,10C18.72,10 18.47,10.11 18.29,10.29C17.9,10.68 17.27,10.68 16.88,10.29C16.5,9.9 16.5,9.27 16.88,8.88C17.42,8.34 18.17,8 19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14H5A1,1 0 0,1 4,13A1,1 0 0,1 5,12H19M18,18H4A1,1 0 0,1 3,17A1,1 0 0,1 4,16H18A3,3 0 0,1 21,19A3,3 0 0,1 18,22C17.17,22 16.42,21.66 15.88,21.12C15.5,20.73 15.5,20.1 15.88,19.71C16.27,19.32 16.9,19.32 17.29,19.71C17.47,19.89 17.72,20 18,20A1,1 0 0,0 19,19A1,1 0 0,0 18,18Z',
    habit: 'M2,22V20C2,20 7,18 12,18C17,18 22,20 22,20V22H2M11.3,9.1C10.1,5.2 4,6.1 4,6.1C4,6.1 4.2,13.9 9.9,12.7C9.5,9.8 8,9 8,9C10.8,9 11,12.4 11,12.4V17C11.3,17 11.7,17 12,17C12.3,17 12.7,17 13,17V12.8C13,12.8 13,8.9 16,7.9C16,7.9 14,10.9 14,12.9C21,13.6 21,4 21,4C21,4 12.1,3 11.3,9.1Z',
    rehab: 'M17.73,12L21.71,8.04C22.1,7.65 22.1,7 21.71,6.63L17.37,2.29C17,1.9 16.35,1.9 15.96,2.29L12,6.27L8,2.29C7.8,2.1 7.55,2 7.29,2C7.04,2 6.78,2.1 6.59,2.29L2.25,6.63C1.86,7 1.86,7.65 2.25,8.04L6.23,12L2.25,16C1.86,16.39 1.86,17 2.25,17.41L6.59,21.75C7,22.14 7.61,22.14 8,21.75L12,17.77L15.96,21.75C16.16,21.95 16.41,22.04 16.67,22.04C16.93,22.04 17.18,21.94 17.38,21.75L21.72,17.41C22.11,17 22.11,16.39 21.72,16L17.73,12M12,9A1,1 0 0,1 13,10A1,1 0 0,1 12,11A1,1 0 0,1 11,10A1,1 0 0,1 12,9M7.29,10.96L3.66,7.34L7.29,3.71L10.91,7.33L7.29,10.96M10,13A1,1 0 0,1 9,12A1,1 0 0,1 10,11A1,1 0 0,1 11,12A1,1 0 0,1 10,13M12,15A1,1 0 0,1 11,14A1,1 0 0,1 12,13A1,1 0 0,1 13,14A1,1 0 0,1 12,15M14,11A1,1 0 0,1 15,12A1,1 0 0,1 14,13A1,1 0 0,1 13,12A1,1 0 0,1 14,11M16.66,20.34L13.03,16.72L16.66,13.09L20.28,16.71L16.66,20.34Z',
    mentoring: 'M12,3L1,9L12,15L21,10.09V17H23V9M5,13.18V17.18L12,21L19,17.18V13.18L12,17L5,13.18Z',
    rehabAll: 'M19.36,2.72L20.78,4.14L15.06,9.85C16.13,11.39 16.28,13.24 15.38,14.44L9.06,8.12C10.26,7.22 12.11,7.37 13.65,8.44L19.36,2.72M5.93,17.57C3.92,15.56 2.69,13.16 2.35,10.92L7.23,8.83L14.67,16.27L12.58,21.15C10.34,20.81 7.94,19.58 5.93,17.57Z',
    question: 'M10,19H13V22H10V19M12,2C17.35,2.22 19.68,7.62 16.5,11.67C15.67,12.67 14.33,13.33 13.67,14.17C13,15 13,16 13,17H10C10,15.33 10,13.92 10.67,12.92C11.33,11.92 12.67,11.33 13.5,10.67C15.92,8.43 15.32,5.26 12,5A3,3 0 0,0 9,8H6A6,6 0 0,1 12,2Z',
    arrow: 'M14 16.94V12.94H5.08L5.05 10.93H14V6.94L19 11.94Z',
  };
  GAME_ICON.habitPair = GAME_ICON.habit;
  const gameIcon = (name, cls = '') => GAME_ICON[name]
    ? `<svg class="tr-gi${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${GAME_ICON[name]}"/></svg>` : '';

  // Game card titles (the training hand's own names).
  function cardTitle(c) {
    if (c.card === 'drill') return c.delta > 1 ? 'Intensive drill' : 'Drill';
    return { negotiation: 'Negotiation', secondWind: 'Second wind', habit: 'New habit', habitPair: 'Two new habits',
      rehab: 'Rehab', rehabAll: 'Clean slate', wildCard: 'Wild card', mentoring: 'Mentoring' }[c.card];
  }
  function effectText(c) {
    if (c.card === 'drill') return `+${c.delta} ${STAT[c.stat]}`;
    if (c.card === 'negotiation') return `−${Math.round(c.drop * 100)}% wage expectation`;
    if (c.card === 'secondWind') return `+${c.gain} training potential`;
    if (c.card === 'habit' || c.card === 'rehab') return c.code ? traitName(c.code) : 'pick the trait';
    if (c.card === 'habitPair') return (c.codes || []).map(traitName).join(' + ') || 'pick the traits';
    if (c.card === 'mentoring') return c.code && c.to ? `${traitName(c.code)} → ${traitName(c.to)}` : 'moves a trait one step up its ladder';
    if (c.card === 'rehabAll') return 'removes every negative trait';
    return 'a random trait, good or bad, and +1 to a random stat';
  }

  // Traits a slot's trait card could name. Rehab: what the employee holds,
  // or every trait of that polarity when the traits aren't known.
  function traitChoices(kind, exclude = []) {
    if (kind.card === 'rehab') {
      const held = input.traits.filter(t => EC.TRAIT[t.code]?.polarity === 'negative').map(t => EC.TRAIT[t.code]);
      return held.length ? held : EC.TRAITS.filter(t => t.polarity === 'negative' && t.weight > 0);
    }
    const held = [...heldCodes(), ...exclude];
    return EC.eligibleTraits(held, input.sit.gender, [kind.polarity]);
  }

  // A hand read from the game names its traits, so those are the only choices.
  const slotChoices = (kind, slot, part, exclude) =>
    slot[part] ? [{ code: slot[part], name: traitName(slot[part]) }] : traitChoices(kind, exclude);

  // The card in a hand slot, with its trait(s) chosen.
  function slotCard(slot) {
    const kind = handKinds(input.hand.rarity)[slot.k];
    if (!kind) return null;
    if (kind.card === 'habit' || kind.card === 'rehab') {
      const list = slotChoices(kind, slot, 'a');
      const code = list.some(t => t.code === slot.a) ? slot.a : list[0]?.code;
      return { ...kind, code };
    }
    if (kind.card === 'mentoring') return { ...kind, code: slot.a, to: slot.b };
    if (kind.card === 'habitPair') {
      const first = slotChoices(kind, slot, 'a');
      const a = first.some(t => t.code === slot.a) ? slot.a : first[0]?.code;
      const second = slotChoices(kind, slot, 'b', [a]);
      const b = second.some(t => t.code === slot.b) ? slot.b : second[0]?.code;
      return { ...kind, codes: [a, b].filter(Boolean) };
    }
    return kind;
  }

  // The hand an employee was dealt and hasn't picked from yet, as hand
  // slots: `pendingTraining.offers` on every employee record. Offers look
  // like { card, rarity, stat, delta } for drills, { card, rarity, delta }
  // for Negotiation (the wage drop) and Second wind, and name the trait in
  // `traitTo` for a habit. Two new habits is a legendary habit with a second
  // trait in `traitTo2`. Rehab names its `trait`. Mentoring names the held
  // `trait` and the step up it becomes, `traitTo`. An offer that matches no
  // card of the rarity leaves its slot empty and counts it in `missing`.
  function pendingHand(emp) {
    const offers = emp.pendingTraining?.offers;
    if (!Array.isArray(offers) || !offers.length) return null;
    const rarity = offers[0].rarity;
    if (!EC.RARITIES.includes(rarity)) return null;
    const kinds = handKinds(rarity);
    const codeOf = t => typeof t === 'string' ? t : t?.code;
    let missing = 0;
    const slots = offers.slice(0, 3).map(o => {
      const card = o.card === 'habit' && o.traitTo2 ? 'habitPair' : o.card;
      const codes = (card === 'mentoring' ? [o.trait, o.traitTo] : [o.traitTo ?? o.trait, o.traitTo2]).map(codeOf).filter(Boolean);
      const k = kinds.findIndex(kind => kind.card === card && (
        kind.card === 'drill' ? kind.stat === o.stat && kind.delta === o.delta
          : kind.card === 'habit' || kind.card === 'rehab' ? EC.TRAIT[codes[0]]?.polarity === kind.polarity
            : true));
      if (k < 0) { missing++; console.warn('[training] unknown offer', o); return { k: -1 }; }
      return codes.length ? { k, a: codes[0], ...(codes[1] ? { b: codes[1] } : {}) } : { k };
    });
    while (slots.length < 3) { missing++; slots.push({ k: -1 }); }
    return { rarity, slots, missing, drawnAt: emp.pendingTraining.drawnAt || null };
  }

  // The selected employee as the model's inputs (inputsFor), with the hand
  // they were dealt (pendingHand) or null. Set by useEmployee.
  let input = { pick: '', hand: null };

  // One line over the hand, for what the employee header doesn't say: cards
  // that couldn't be read, or no hand drawn yet.
  function dealtNote() {
    const hand = input.hand, emp = findEmployee(input.pick).emp;
    const reload = label => `<button type="button" class="tr-link" data-reload>${label}</button>`;
    const text = hand ? hand.missing && `${plural(hand.missing, 'card')} couldn't be read. ${reload('Reload')} to try again.`
      : !doneToday(emp) && (emp.potentialMax || 0) > (emp.potential || 0) && `No hand yet. Draw one in the game, then ${reload('reload')}.`;
    return text ? `<p class="tr-calc-sub tr-dealt">${text}</p>` : '';
  }

  // The one employee picker, over the employee tabs: the loaded employees by
  // company, with previous and next.
  const allEmployees = () => (team?.companies || []).flatMap(x => x.employees);
  function renderPicker() {
    $work.hidden = $pick.hidden = !EMP_TABS.includes(view.tab) || !team;
    if ($pick.hidden) return;
    renderSide();
    renderEmpHead();
    const options = team.companies.filter(x => x.employees.length).map(({ company, employees }) =>
      `<optgroup label="${escapeHtml(companyLabel(company))}">${employees.map(emp => {
        const left = (emp.potentialMax || 0) - (emp.potential || 0);
        const notes = [`Prod ${emp.base?.production ?? '?'}`, `${left} left`,
          ...(pendingHand(emp) ? ['hand waiting'] : trainedToday(emp) ? ['trained'] : [])];
        return `<option value="${emp._id}"${emp._id === input.pick ? ' selected' : ''}>${escapeHtml(`${emp.name} · ${notes.join(' · ')}`)}</option>`;
      }).join('')}</optgroup>`).join('');
    $pick.innerHTML = `<button type="button" class="tr-pick-step" data-step="-1" aria-label="Previous employee">‹</button>
      <select data-pick aria-label="Employee">${options}</select>
      <button type="button" class="tr-pick-step" data-step="1" aria-label="Next employee">›</button>`;
  }

  // The owner's Management level for training card odds, as the game reads
  // it: the skill's total less its value at level 0 (TheCraicen 2026-10-29:
  // level 10, value and total 11, so 10).
  const managementLevel = sk => !sk ? 0 : sk.total == null ? Math.max(0, sk.level || 0)
    : Math.max(0, sk.total - ((sk.value ?? sk.total) - (sk.level ?? 0)));

  // An employee's inputs (inputsFor) → the model's employee and context.
  function employeeOf(inp) {
    return {
      ...EC.DEFAULT_EMPLOYEE,
      age: inp.age, production: inp.production, extraProduction: inp.extraProduction,
      responsibility: inp.responsibility, luck: inp.luck,
      bonus: inp.bonusPct / 100, traitBonus: (inp.traitBonusPct || 0) / 100, specialization: inp.specPct, wageExpectation: 1 + inp.wagePct / 100,
      happinessLoss: inp.happinessLoss, happiness: inp.happiness ?? null, potentialLeft: inp.potentialLeft, trainingsPerDay: inp.trainingsPerDay,
      traits: inp.traits, negotiationExpectation: inp.negotiationExpectation,
    };
  }
  function contextOf(inp) {
    const product = productFor(inp.product);
    const itemType = market?.types?.[inp.product] || inp.sit.itemType;
    return {
      ...EC.DEFAULT_CONTEXT, management: inp.management, sellRatio: product?.ratio ?? 1,
      coworkerOutput: inp.coworkerOutput ?? undefined,
      situation: { ...inp.sit, itemType, product: product ? inp.product : null },
    };
  }
  const employee = () => employeeOf(input);
  const context = () => contextOf(input);

  const fmtPP = v => Math.abs(v) >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1);
  const signedPP = v => `${v < 0 ? '−' : ''}${fmtPP(Math.abs(v))}`;
  const moneyOf = v => {
    if (!market?.ppValue) return null;
    const m = v * market.ppValue;
    return `${m < 0 ? '−' : ''}${Math.abs(m).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} money`;
  };
  const ARG_SHORT = { production: 'Prod', responsibility: 'Resp', luck: 'Luck', match: 'its product', other: 'other good' };

  let cardPricer = null, cardRevision = null;

  // Handy and Improviser hang on holding a tool. Card values start from the
  // registered tools the assignment plan hands out, and may give the employee
  // another that suits their company (EmployeePlanner cardSession).
  const TOOL_TRAITS = ['handy', 'improviser'];
  const plannedTool = id => plan && !plan.running ? (plan.tools || []).find(x => x.employee === id)?.tool || null : null;
  const plannedTools = () => Object.fromEntries((plan && !plan.running ? plan.tools || [] : []).map(x => [x.employee, x.tool.id]));
  const withTool = ctx => ({ ...ctx, situation: { ...ctx.situation, hasTool: true } });
  const spareTools = () => assignments?.cardSettings().inventory || [];
  const toolTypeFor = code => Object.keys(EmployeePlanner.TOOL_TYPES).find(t => EmployeePlanner.TOOL_TYPES[t].includes(code)) || null;
  const cardKey = c => JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'value')));
  function prepareCardPricing() {
    if (!cardPricer) cardPricer = EmployeeAssignments.createCardPricer({
      workerFactory: () => {
        const tag = name => document.querySelector(`script[src*="js/${name}.js"]`)?.getAttribute('src')?.match(/[?&]v=([\w.-]+)/)?.[1] || '';
        const url = document.getElementById('tr-assignments-body').dataset.worker;
        return new Worker(`${url}&core=${tag('employee-core')}&planner=${tag('employee-planner')}`);
      },
      onUpdate: () => { renderResult(); renderTeam(); },
    });
    const settings = assignments?.cardSettings();
    const revision = JSON.stringify([team, market, settings]);
    if (revision !== cardRevision) {
      cardRevision = revision;
      const prepared = settings ? EmployeeAssignments.snapshotOf(team, market, settings) : { errors: ['No workforce loaded.'] };
      cardPricer.reset(revision, prepared.errors.length ? null : { ...prepared.snapshot, ppValue: market.ppValue });
    }
    return cardPricer;
  }
  function pricingJob(emp, entry, cards, feed = false) {
    const inp = inputsFor(emp, entry);
    return { subjectId: emp._id, cards, options: { employee: { ...employeeOf(inp), potentialMax: emp.potentialMax },
      context: plannedTool(emp._id) ? withTool(contextOf(inp)) : contextOf(inp), feed, assigned: plannedTools() } };
  }
  function selectedPricing(cards, kind) {
    const pricer = prepareCardPricing();
    const found = findEmployee(input.pick);
    if (taken.get(found.emp._id)?.rolled.length) return { status: 'fallback', reason: 'Reload to resolve the rolled card outcome.' };
    if (input.hand?.missing) return { status: 'fallback', reason: 'The dealt hand contains an unknown card. Reload its offers.' };
    if (!cards.length) return { status: 'fallback', reason: 'No hand dealt.' };
    const job = pricingJob(found.emp, found.entry, cards);
    return pricer.request(JSON.stringify([kind, job]), [job], kind === 'hand' ? 0 : 1);
  }
  function pricingLabel(batch, group = batch.result?.groups[0]) {
    if (batch.status === 'pending') return 'Recalculating arrangements; current-company values shown. Choice pending.';
    if (batch.status === 'fallback') return `Current-company fallback: ${batch.reason}`;
    return `Rearranged estimate over ${group.horizon} workforce days. ${group.coverage.tested} of ${group.coverage.total} local arrangements tested; equipped tools fixed. Without the card assumes ${group.baseline.description}. No future hires, training or inventory search. Second Wind is a numeric-training forecast. ${group.warnings.join(' ')}`;
  }
  function quoteDetail(q) {
    if (q.value === null) return q.note || 'Not priced.';
    const plans = q.outcomes.length ? [...new Set(q.outcomes.map(o => o.plan.description))].join(' / ') : q.plan.description;
    return `Here ${signedPP(q.stay)} PP; rearranged ${signedPP(q.value)} PP, of which ${signedPP(q.value - q.stay)} from rearranging. Assumes ${plans}. ${q.forecast ? 'Forecast of future numeric trainings.' : q.note || ''}`;
  }

  // Each slot's card with its value and, for traits rolled on gain, the
  // outcomes. Unpriced cards have value null.
  function pricedHand(e, ctx) {
    if (plannedTool(input.pick)) ctx = withTool(ctx);
    const rows = (input.hand?.slots || []).map((h, slot) => {
      const c = slotCard(h);
      if (!c) return null;
      const value = EC.cardValue(e, c, ctx);
      const tv = c.card === 'habit' && c.code ? EC.traitValue(c.code, e, ctx) : null;
      const t = EC.TRAIT[c.card === 'mentoring' ? c.to : c.code] || null;
      return { slot, c, value, outcomes: tv?.outcomes || [], note: t?.unpriced, when: t?.when };
    }).filter(Boolean);
    const batch = selectedPricing(rows.map(x => x.c), 'hand');
    const group = batch.result?.groups[0];
    if (batch.status === 'done') rows.forEach((row, i) => {
      const q = group.quotes[i];
      Object.assign(row, q, { note: q.note || row.note, detail: quoteDetail(q) });
    });
    rows.pricing = batch;
    rows.scope = pricingLabel(batch);
    // Per-day values average over the employee's remaining working days.
    rows.days = EC.workingDays(e);
    return rows;
  }

  const rollName = arg => ARG_SHORT[arg] || (EC.TRAIT[arg] ? traitName(arg) : arg);
  // A card's outcomes merged by what was rolled (a Wild card lists each
  // trait once per stat), with each group's average value.
  function rollGroups(outcomes) {
    const groups = new Map();
    for (const o of outcomes) {
      const g = groups.get(o.arg) || { arg: o.arg, p: 0, sum: 0 };
      g.p += o.p; g.sum += o.p * o.value;
      groups.set(o.arg, g);
    }
    return [...groups.values()].map(g => ({ arg: g.arg, p: g.p, value: g.sum / g.p }));
  }
  // Up to this many rolls are listed on a card; more show as a range.
  const ROLLS_LISTED = 4;

  // The card to take, or a line saying why there's none yet.
  function verdict(hand) {
    if (!hand.length) return { best: null, html: '' };
    if (hand.pricing?.status === 'pending') return { best: null, html: '<p class="tr-calc-sub">Still working out the values. Wait before you pick.</p>' };
    const best = hand.filter(x => x.value !== null).sort((a, b) => b.value - a.value)[0];
    return best ? { best, html: '' } : { best: null, html: '<p class="tr-calc-sub">None of these cards can be priced. Pick by the traits.</p>' };
  }

  // A card's effect as the game draws it: a drill shows the gain and the
  // stat before and after.
  function cardFace(c) {
    if (c.card === 'drill') {
      const now = c.stat === 'production' ? input.production + input.extraProduction : input[c.stat];
      const stat = (v, cls = '') => `<span class="tr-stat-${c.stat}${cls}">${gameIcon(c.stat)}</span>${v}`;
      return `<div class="tr-gc-gain">${stat(`+${c.delta}`)}</div>
        <div class="tr-gc-change">${stat(now)}${gameIcon('arrow', 'tr-gc-arrow')}${stat(now + c.delta)}</div>`;
    }
    if (c.card === 'mentoring' && c.code && c.to) return `<div class="tr-gc-effect">${escapeHtml(traitName(c.code))}${gameIcon('arrow', 'tr-gc-arrow')}${escapeHtml(traitName(c.to))}</div>`;
    if (c.card === 'wildCard') {
      const risk = EC.wildCardRisk(input.traits.map(t => t.code), input.sit.gender);
      return `<span class="tr-gc-mark">${gameIcon('question')}</span><div class="tr-gc-effect">Random trait, +1 random stat</div>${risk == null ? '' : `<div class="tr-gc-note">${Math.round(100 * risk)}% chance of a bad trait</div>`}`;
    }
    return `<div class="tr-gc-effect">${escapeHtml(effectText(c))}</div>`;
  }

  function cardWage(c) {
    if (c.card !== 'negotiation' && !(c.card === 'drill' && c.stat === 'production')) return '';
    const emp = findEmployee(input.pick)?.emp;
    if (!Number.isFinite(emp?.wage)) return '';
    const e = { ...employee(), wage: emp.wage };
    const after = EC.cardOutcomes(e, c)[0]?.employee.wage;
    if (!Number.isFinite(after)) return '';
    const wage = n => n.toFixed(4);
    return `<div class="tr-gc-note">Wage /h: ${wage(emp.wage)} → ${wage(after)}</div>`;
  }

  // A card value as average profit per day over the employee's working days, or
  // null before market prices load.
  function perDayText(value, days) {
    if (!(market?.ppValue > 0) || !(days > 0)) return null;
    const v = value * market.ppValue / days;
    return `${v < 0 ? '−' : '+'}₿${Math.abs(v).toLocaleString('en', { maximumFractionDigits: 3 })}/day`;
  }

  // The hand as the game shows it, with each card's value as a footer.
  function handCards(hand, best) {
    if (!hand.length) return '';
    const rolls = new Map(hand.map(x => [x, rollGroups(x.outcomes)]));
    const listed = x => rolls.get(x).length <= ROLLS_LISTED ? rolls.get(x) : [];
    const top = Math.max(0, ...hand.map(x => Math.max(x.value ?? 0, ...listed(x).map(g => g.value))));
    const pctOf = v => top > 0 ? Math.max(0, Math.min(100, v / top * 100)) : 0;
    return `<div class="tr-hand-view" style="--tier: var(--tr-${input.hand.rarity})">${hand.map(x => {
      const isBest = best && x.slot === best.slot;
      const daily = x.value === null ? null : perDayText(x.value, hand.days);
      const groups = listed(x);
      const values = x.outcomes.map(o => o.value);
      const split = groups.length ? `<div class="tr-split">${groups.map(g =>
        `<span class="tr-arg-${g.arg}" style="flex:${g.p}" title="${escapeHtml(`${rollName(g.arg)}: ${signedPP(g.value)} PP, ${Math.round(g.p * 100)}% chance`)}">${g.p >= 0.2 ? signedPP(g.value) : ''}</span>`).join('')}</div>
        <div class="tr-gc-note">${groups.map(g => `${escapeHtml(rollName(g.arg))} ${Math.round(g.p * 100)}%`).join(' · ')}</div>`
        : x.outcomes.length ? `<div class="tr-gc-note">Random: ${signedPP(Math.min(...values))} to ${signedPP(Math.max(...values))} PP</div>` : '';
      const bar = `<div class="tr-gc-bar"><i style="width:${pctOf(x.value)}%"></i></div>`;
      return `<div class="tr-gc${isBest ? ' best' : ''}"${x.when ? ` title="${escapeHtml(x.when)}"` : ''}>
        ${isBest ? '<span class="tr-take">TAKE</span>' : ''}
        <span class="tr-gc-rarity">${RARITY_NAME[input.hand.rarity]}</span>
        ${gameIcon(x.c.card, 'tr-gc-icon')}
        <div class="tr-gc-title">${escapeHtml(cardTitle(x.c))}</div>
        <div class="tr-gc-face">${cardFace(x.c)}${cardWage(x.c)}
        ${x.c.card === 'mentoring' ? (x.c.to ? traitHelp(x.c.to, 'Trait effect') : '') : x.c.code ? traitHelp(x.c.code, 'Trait effect') : (x.c.codes || []).map(code => traitHelp(code)).join('')}</div>
        <div class="tr-gc-value">
          ${x.value === null ? `<div class="tr-gc-pp muted">not priced</div><div class="tr-gc-note">${escapeHtml(x.note || 'depends on the trait')}</div>`
            : `<div class="tr-gc-pp${x.value < 0 ? ' neg' : ''}"${x.detail ? ` title="${escapeHtml(x.detail)}"` : ''}><span class="tr-gc-num">${x.outcomes.length ? '≈ ' : ''}${daily || `${signedPP(x.value)} PP`}</span>${x.outcomes.length ? ' <em>avg</em>' : ''}</div>
               ${daily ? `<div class="tr-gc-note">${signedPP(x.value)} PP</div>` : ''}
               ${split}${groups.length ? '' : bar}`}
        </div>
        <button type="button" class="tr-took${isBest ? ' btn-primary' : ''}" data-took="${x.slot}">I took this</button>
      </div>`;
    }).join('')}</div>`;
  }

  function renderResult() {
    if (!findEmployee(input.pick)) return;
    const t = taken.get(input.pick);
    if (t) {
      $calc.innerHTML = `<p class="tr-emp-took" role="status" tabindex="-1"><strong>Took ${escapeHtml(t.text)}.</strong> Estimates updated locally. This does not choose a card in the game. <button type="button" class="tr-link" data-reload>Reload from the game</button> to ${t.rolled.length ? `fetch the actual ${escapeHtml(t.rolled.join(' and '))} and ` : ''}replace these estimates with current game data. Next training at 00:00 UTC.</p>`;
      return;
    }
    const e = employee();
    const ctx = context();
    const days = EC.workingDays(e);
    const profit = EC.hourlyProfit(e, ctx);
    const who = escapeHtml(input.who);
    // Warnings only; the employee header covers the rest.
    const warnings = [
      profit < 0 && `${who} is losing money on this product.`,
      days <= input.potentialLeft / input.trainingsPerDay && `${who} retires before using up their potential, so Second Wind is wasted.`,
    ].filter(Boolean);
    const hand = pricedHand(e, ctx);
    const v = verdict(hand);
    const note = dealtNote();

    $calc.innerHTML = `
      ${note ? `<div class="tr-hand">${note}</div>` : ''}
      ${toolLine(hand)}
      ${v.html}
      ${hand.length ? `<div class="tr-hand-row">${handCards(hand, v.best)}
        ${help('What the card values mean', `Each value is the extra profit per day the card adds, at the PP money value, averaged over the employee's remaining working days. Below it are the production points the card adds before retirement, counting coworkers and moves between your companies. ${escapeHtml(hand.scope)} Wild card averages every eligible trait equally, excluding held traits, conflicts, gender mismatches and partner traits. Wages use hired and trained Production; Negotiation reduces wage expectation before Greedy or Modest applies.`)}</div>` : ''}
      ${warnings.length ? `<ul class="tr-facts">${warnings.map(w => `<li class="tr-warn">${w}</li>`).join('')}</ul>` : ''}`;
  }

  // Over a hand where holding a tool changes a card's value (the employee
  // holds Handy or Improviser, or a card gives or takes one): which tool the
  // values count, or a prompt to register one that suits their company.
  function toolLine(hand) {
    const { emp, entry } = findEmployee(input.pick);
    const codes = hand.flatMap(({ c }) => c.card === 'habitPair' ? c.codes || [] : c.card === 'mentoring' ? [c.code, c.to]
      : c.card === 'habit' || c.card === 'rehab' ? [c.code] : []);
    if (emp.toolItem || ![...(emp.traits || []).map(t => t.code), ...codes].some(code => TOOL_TRAITS.includes(code))) return '';
    const who = escapeHtml(emp.name), planned = plannedTool(emp._id), type = toolTypeFor(entry.company.itemCode);
    const suits = spareTools().filter(r => r.type === type).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    const add = type ? ` <button type="button" class="tr-link" data-add-tool="${type}">Add a ${type}</button>` : '';
    const text = planned ? `The assignment plan gives ${who} ${escapeHtml(planned.name)}; card values count it.`
      : plan?.running ? 'The assignment plan is still placing your tools.'
        : suits ? `Card values may give ${who} ${suits === 1 ? `your registered ${type}` : `one of your ${suits} registered ${type}s`}, for its remaining hours, when a card makes it worth more to them.`
          : type ? `No ${type} registered, so ${who} is valued without a tool. Have one?${add}`
            : `Nothing you can register suits this company, so ${who} is valued without a tool.`;
    return `<p class="tr-tool-for tr-muted">${text}</p>`;
  }

  /* ── Your employees ──────────────────────────────────────── */
  async function resolveUser(username) {
    const needle = username.trim().toLowerCase();
    const search = await trpc('search.searchAnything', { searchText: username }, { retry: true });
    const ids = (search?.userIds || []).slice(0, 10);
    if (!ids.length) throw new Error(`No user found matching "${username}"`);
    const profiles = await trpcManyValues('user.getUserLite', ids.map(userId => ({ userId })));
    const exact = profiles.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle);
    if (!exact) throw new Error(`No exact match for "${username}"`);
    return exact;
  }

  async function loadTeam(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const lite = await resolveUser(username);
    enforceIrishOnly(lite.country, lite.username);
    const user = await trpc('user.getUserById', { userId: lite._id }, { retry: true });
    steps.setStep(1, 'done', { count: user.username });
    steps.setStep(2, 'active', { sub: 'Fetching company list' });
    const list = await trpc('company.getCompanies', { userId: user._id, perPage: 100 }, { retry: true });
    const ids = list?.items || [];
    if (!ids.length) throw new Error(`"${user.username}" has no companies`);
    const companies = (await trpcManyValues('company.getById', ids.map(companyId => ({ companyId })), {
      onProgress: (done, total) => steps.setStep(2, 'active', { sub: 'Loading company details', count: `${done}/${total}` }),
    }))
      .filter(c => c && !c.disabledAt);
    steps.setStep(2, 'done', { count: `${companies.length} active` });
    steps.setStep(3, 'active', { sub: 'Loading employees, estimates and managers' });
    steps.setStep(4, 'active', { sub: 'Loading output history and prices' });
    // Profit often finishes first; it ticks off after employees so the list reads in order.
    let profitSub = '';
    const by = companies.map(c => ({ companyId: c._id }));
    const regionIds = [...new Set(companies.map(c => c.region).filter(Boolean))];
    const [rosters, estimates, regions, managers, totalProfit] = await Promise.all([
      trpcManyValues('employee.getCompanyEmployees', by, {
        onProgress: (done, total) => steps.setStep(3, 'active', { count: `${done}/${total} rosters` }),
      }),
      trpcManyValues('employee.getCompanyEstimate', by),
      trpcManyValues('region.getById', regionIds.map(regionId => ({ regionId }))),
      trpcMany('manager.getByCompanyId', by),
      ProductPickerTool.loadModel(user, (_n, state, detail) => {
        if (state === 'active') steps.setStep(4, 'active', detail);
      }).then(m => {
        const summary = { ...ProductPickerTool.incomeSummary(m), projectedSelfWork: ProductPickerTool.selfWorkProjection(m) };
        profitSub = summary.statsMissing ? 'Work history unavailable' : summary.unpriced ? 'Some products unpriced' : 'Profit and self-work estimate ready';
        steps.setStep(4, 'active', { sub: 'Waiting for employees', count: '' });
        return summary;
      }).catch(() => {
        profitSub = 'Total profit unavailable; continuing with employees';
        return null;
      }),
    ]);
    const regionById = Object.fromEntries(regionIds.map((id, i) => [id, regions[i]]));
    const countryIds = [...new Set(regions.filter(Boolean).map(r => r.country).filter(Boolean))];
    const taxes = await trpcManyValues('country.getCountryById', countryIds.map(countryId => ({ countryId })));
    const incomeTax = Object.fromEntries(countryIds.map((id, i) => [id, taxes[i]?.taxes?.income]));
    steps.setStep(3, 'done', { sub: '', count: `${rosters.reduce((n, roster) => n + (roster?.length || 0), 0)} employees` });
    steps.setStep(4, 'done', { sub: profitSub, count: '' });
    return {
      userId: user._id,
      totalProfit,
      username: user.username,
      management: managementLevel(user.skills?.management),
      energy: user.skills?.energy?.total ?? null,
      // The bar as read now; energyNow() adds what regenerates after.
      energyBar: { value: user.skills?.energy?.currentBarValue ?? null, max: user.skills?.energy?.total ?? null,
        regen: user.skills?.energy?.hourlyBarRegen ?? 0, at: Date.now() },
      companies: companies.map((company, i) => ({ company,
        employees: (Array.isArray(rosters[i]) ? rosters[i] : []).map(e => ({ ...e, traits: EC.currentTraits(e.traits) })), rosterMissing: !Array.isArray(rosters[i]),
        estimate: estimates[i] || null, region: regionById[company.region] || null,
        incomeTax: incomeTax[regionById[company.region]?.country],
        managerPct: managers[i]?.status === 'fulfilled' ? managers[i].value?.productionBonusPercent || 0 : null })),
    };
  }

  // Employee from the API → calculator inputs. The API's `base` already
  // includes trained points (breakdown.production.base is the hired value),
  // and the wage is paid on it. Trait Production is the rest of the total.
  // The wage expectation is read off the wage itself, so Greedy, Modest and
  // Climber are included.
  // `models` adds each coworker as a model employee, so cards can price what
  // this one's Production and wage do to their traits; `self` marks this
  // employee among a coworker model's peers.
  function inputsFor(emp, entry, { models = true, self = null } = {}) {
    const { company } = entry;
    const hired = emp.base?.production || 0;
    const total = emp.breakdown?.production?.total ?? hired;
    const spec = (emp.productionBonus?.contributions || []).find(c => c.source === 'specialization')?.percent || 0;
    const paidPerHour = hired / 4 * (market?.ppValue || 0);
    const expectation = paidPerHour > 0 ? emp.wage / paidPerHour : emp.wageExpectation;
    return {
      age: emp.age,
      production: hired,
      extraProduction: total - hired,
      responsibility: emp.breakdown?.responsibility?.total ?? emp.base?.responsibility ?? 0,
      luck: emp.breakdown?.luck?.total ?? emp.base?.luck ?? 0,
      bonusPct: Math.round((emp.productionBonus?.total ?? 0) * 10) / 10,
      traitBonusPct: traitBonusPct(emp),
      specPct: Math.min(20, spec),
      wagePct: (expectation - 1) * 100,
      negotiationExpectation: emp.wageExpectation,
      // The draw spends the potential, so a hand waiting has already used its own.
      potentialLeft: Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0) - (emp.pendingTraining ? 0 : 1)),
      trainingsPerDay: emp.trainingsPerDay || 1,
      management: team?.management ?? 0,
      product: productFor(company.itemCode) ? company.itemCode : 'average',
      who: emp.name,
      traits: (emp.traits || []).filter(t => t.revealed !== false).map(t => ({ code: t.code, ...(t.arg ? { arg: t.arg } : {}) })),
      ...situationFor(emp, entry, { models, self }),
    };
  }

  // Where the employee works, from the company's roster and region, for
  // pricing traits.
  // Stronger and weaker (Rival, Mentor) compare hired + trained Production,
  // before traits: Levi Rosenbaum (3, Rival +3 = 6) keeps Rival next to a
  // coworker on 5 (checked 2026-10-27).
  const paidProd = x => x.base?.production ?? 0;
  // A happiness or bonus contribution from one of the employee's own traits.
  const ownTrait = c => !!c.code || c.reason === 'trait' || c.source === 'trait' || !!EC.TRAIT[c.source];
  // The part of today's production bonus the employee's own traits give:
  // their happiness (1% a point) and any output percentages.
  const traitBonusPct = x =>
    (x.happinessBreakdown?.contributions || []).filter(ownTrait).reduce((a, c) => a + (c.delta || 0), 0)
    + (x.productionBonus?.contributions || []).filter(ownTrait).reduce((a, c) => a + (c.percent || 0), 0);
  // Happiness points an employee loses, averaged over
  // their working life. A temporary loss (one with `until`, like an event's
  // −10 for 3 days) counts for the share of that life it lasts; with
  // `lasting`, only the losses that don't expire count.
  // `shared` leaves out the employee's own traits' losses (Homesick…).
  function lifeLoss(x, { lasting = false, shared = false } = {}) {
    const hours = Math.max(1, (EC.CFG.retireAge - (x.age || 0)) * 24);
    return (x.happinessBreakdown?.contributions || []).reduce((a, c) => {
      if (!(c.delta < 0) || shared && ownTrait(c)) return a;
      if (!c.until) return a - c.delta;
      const left = Math.max(0, (Date.parse(c.until) - Date.now()) / 36e5);
      return lasting || !Number.isFinite(left) ? a : a - c.delta * Math.min(1, left / hours);
    }, 0);
  }
  // Pay compares wages (Prima Donna, Envious); peers carry both, the wage in
  // PP per hour so it compares with the model's.
  function situationFor(emp, entry, { models = true, self = null } = {}) {
    const { company, employees, region } = entry;
    const others = employees.filter(x => x._id !== emp._id);
    const own = paidProd(emp);
    const contributions = emp.happinessBreakdown?.contributions || [];
    const p = productFor(company.itemCode);
    const outputs = others.map(x => x.estimate?.production).filter(v => typeof v === 'number');
    const since = Date.parse(emp.lastMovedAt || emp.createdAt);
    const hired = Date.parse(emp.createdAt);
    const nat = emp.nationality;
    return {
      happinessLoss: Math.round(lifeLoss(emp)),
      happiness: emp.happinessBreakdown?.value ?? null,
      coworkerOutput: outputs.length ? outputs.reduce((a, v) => a + v, 0) / outputs.length * (p?.ratio ?? 1) : null,
      sit: {
        ...EC.DEFAULT_SITUATION,
        gender: emp.gender === 'female' ? 'female' : 'male',
        coworkers: others.length,
        femaleCoworkers: others.filter(x => x.gender === 'female').length,
        otherNationalities: new Set(others.map(x => x.nationality).filter(n => n && n !== nat)).size,
        strongerCoworker: others.some(x => paidProd(x) > own),
        weakerCoworker: others.some(x => paidProd(x) < own),
        betterPaid: others.filter(x => x.wage > emp.wage).length,
        coworkerHappiness: others.length && others.every(x => typeof x.happinessBreakdown?.value === 'number')
          ? others.reduce((a, x) => a + x.happinessBreakdown.value, 0) / others.length : null,
        peers: market?.ppValue ? others.map(x => ({ production: paidProd(x), wagePP: x.wage / market.ppValue, ...(x._id === self ? { self: true } : {}) })) : null,
        coworkerModels: market?.ppValue && models ? others.map(x => {
          const inp = inputsFor(x, entry, { models: false, self: emp._id });
          return { e: employeeOf(inp), ctx: contextOf(inp) };
        }) : null,
        place: !region ? EC.DEFAULT_SITUATION.place : region.country !== nat ? 'abroad' : region.initialCountry === nat ? 'homeCore' : 'home',
        itemType: market?.types?.[company.itemCode] || EC.DEFAULT_SITUATION.itemType,
        incomeTax: -(contributions.find(c => c.reason === 'incomeTax')?.delta || 0),
        tenureDays: Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 864e5)) : 0,
        employedDays: Number.isFinite(hired) ? Math.max(0, Math.floor((Date.now() - hired) / 864e5)) : 0,
        hasTool: (emp.productionBonus?.contributions || []).some(c => /tool/i.test(c.source || '')),
        // A company without the upgrade has storage level 0 (as in the game client).
        smallStorage: (company.activeUpgradeLevels?.storage ?? 0) <= 2,
        storageFull: !!company.isFull,
      },
    };
  }

  /* ── Where to spend energy ───────────────────────────────── */
  // Training and hiring both cost 10 energy. The feed lists every such
  // action open to the player, each priced as the PP it adds over the
  // working life: the next training of each employee with potential left
  // (the average best card of a hand, EmployeeCore.trainingOutlook), and a
  // hire in each company with a free Break Room slot (a fresh set's pick,
  // freshSet). Employees that already trained today come after the rest,
  // ready again at 00:00 UTC. Firing costs no energy, so it isn't here: a
  // full company has no hire until Keep or replace says who to let go.
  const COMPANY_BONUS = ['management', 'manager', 'coreRegion'];
  const companyBonusPct = emp => (emp.productionBonus?.contributions || [])
    .filter(c => COMPANY_BONUS.includes(c.source)).reduce((a, c) => a + (c.percent || 0), 0);
  const trainedToday = emp => emp.lastTrainedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10) ? emp.trainingsToday || 0 : 0;
  // Break Room level n holds n employees; a company without it has level 1, the free one.
  const headcountCap = company => company.activeUpgradeLevels?.breakRoom ?? 1;

  function trainRow(emp, entry) {
    const inp = inputsFor(emp, entry);
    const o = EC.trainingOutlook({ ...employeeOf(inp), potentialMax: emp.potentialMax }, contextOf(inp));
    const perDay = emp.trainingsPerDay || 1;
    return {
      kind: 'train', value: o.value, emp, entry, outlook: o, perDay,
      ready: trainedToday(emp) < perDay,
      left: (emp.potentialMax || 0) - (emp.potential || 0),
    };
  }

  // A company seen from someone joining it: the context and options for
  // EmployeeCore.freshSetValue / candidateValue. `newcomer` is who joins:
  // nationality (default: a citizen of the company's country), Production
  // and hourly wage (default: an average candidate's).
  function joinSetup(entry, mgmtPct, { nationality = entry.region?.country, gender = 'male', production = 2.5, wage = null } = {}) {
    const { company, employees, region } = entry;
    const p = productFor(company.itemCode);
    const coreBonus = region && region.initialCountry === region.country;
    const place = !region || !nationality ? 'home' : region.country !== nationality ? 'abroad' : region.initialCountry === nationality ? 'homeCore' : 'home';
    const hired = employees.map(paidProd);
    const outputs = employees.map(x => x.estimate?.production).filter(v => typeof v === 'number');
    // A newcomer shares the company's lasting losses, not a coworker's temporary ones.
    const losses = employees.map(x => lifeLoss(x, { lasting: true, shared: true }));
    const tax = employees.map(x => -((x.happinessBreakdown?.contributions || []).find(c => c.reason === 'incomeTax')?.delta || 0));
    // An empty company: the region's income tax, and full storage's −10.
    if (!employees.length && Number.isFinite(entry.incomeTax)) {
      tax.push(entry.incomeTax);
      losses.push(entry.incomeTax + (company.isFull ? 10 : 0));
    }
    const ctx = {
      ...EC.DEFAULT_CONTEXT, management: team?.management ?? 0, sellRatio: p?.ratio ?? 1,
      coworkerOutput: outputs.length ? outputs.reduce((a, v) => a + v, 0) / outputs.length * (p?.ratio ?? 1) : undefined,
      situation: {
        ...EC.DEFAULT_SITUATION,
        gender,
        coworkers: employees.length,
        femaleCoworkers: employees.filter(x => x.gender === 'female').length,
        otherNationalities: new Set(employees.map(x => x.nationality).filter(n => n && n !== nationality)).size,
        strongerCoworker: hired.some(v => v > production),
        weakerCoworker: hired.some(v => v < production),
        peers: market?.ppValue ? employees.map(x => ({ production: paidProd(x), wagePP: x.wage / market.ppValue })) : null,
        coworkerModels: null,
        betterPaid: wage == null ? employees.filter(x => (x.base?.production || 0) > production).length : employees.filter(x => x.wage > wage).length,
        place,
        itemType: market?.types?.[company.itemCode] || EC.DEFAULT_SITUATION.itemType,
        product: p ? company.itemCode : null,
        incomeTax: tax.length ? Math.max(...tax) : 0,
        smallStorage: (company.activeUpgradeLevels?.storage ?? 0) <= 2,
        storageFull: !!company.isFull,
      },
    };
    // The company's bonus as a coworker gets it; an empty company gets the
    // owner's management, plus the core region bonus where it applies.
    const bonusPct = employees.length ? companyBonusPct(employees[0]) : mgmtPct + (coreBonus ? 5 : 0);
    return {
      ctx,
      opts: {
        bonus: bonusPct / 100,
        happinessLoss: losses.length ? Math.round(losses.reduce((a, v) => a + v, 0) / losses.length) : undefined,
      },
    };
  }

  // Candidates come from many countries. An unseen one is drawn from the
  // nationalities the player has hired so far (they came from the same
  // pools), or is a citizen of the company's country with nobody hired yet.
  // [{ nationality, count }].
  function nationalityMix(entry) {
    const counts = new Map();
    for (const emp of (team?.companies || []).flatMap(x => x.employees)) {
      if (emp.nationality) counts.set(emp.nationality, (counts.get(emp.nationality) || 0) + 1);
    }
    return counts.size ? [...counts].map(([nationality, count]) => ({ nationality, count }))
      : [{ nationality: entry?.region?.country, count: 1 }];
  }

  // A hire into an empty slot is worth what a fresh set's pick turns out to
  // be, on average, over their whole working life.
  function hireRow(entry, alt) {
    const slots = slotsIn(entry);
    const fresh = freshSet(entry, alt, slots);
    return { kind: 'hire', value: fresh.gross, entry, fresh, slots, cap: headcountCap(entry.company), ready: true };
  }

  // The owner's Management bonus, as any of their employees gets it.
  const teamMgmt = () => Math.max(0, ...team.companies.flatMap(x => x.employees)
    .map(x => (x.productionBonus?.contributions || []).find(c => c.source === 'management')?.percent || 0));

  function energyFeed() {
    if (!team || !market) return [];
    const rows = team.companies.flatMap(entry => entry.employees
      .filter(emp => (emp.potentialMax || 0) - (emp.potential || 0) > 0).map(emp => trainRow(emp, entry)));
    rows.sort((a, b) => (b.ready - a.ready) || (b.value - a.value));
    // A hire's trainings count above what the energy earns training.
    const alt = altFrom(rows).value;
    for (const entry of team.companies) {
      if (entry.employees.length < headcountCap(entry.company)) rows.push(hireRow(entry, alt));
    }
    return rows.sort((a, b) => (b.ready - a.ready) || (b.value - a.value));
  }

  /* ── Overview: Next actions and the roster ───────────────── */
  // A Craftsman or Laborer working against their trait. Happiness and
  // specialization can still favour staying, so this only invites a comparison.
  function mismatchOf(emp, company) {
    const type = market?.types?.[company.itemCode];
    if (!type || emp.leftAt) return null;
    const has = code => (emp.traits || []).some(t => t.code === code && t.revealed !== false);
    if (has('craftsman') && type === 'raw') return 'Craftsman on raw resources';
    if (has('laborer') && type !== 'raw') return `Laborer on ${type === 'weapon' ? 'weapons' : 'manufactured goods'}`;
    return null;
  }

  // Where a mismatched employee would fit: the planner's move if it has
  // one, else the best-priced company of the right type ({ company, planned }).
  function fitFor(emp, entry) {
    const move = (plan?.moves || []).find(x => x.employee === emp._id);
    const moved = move && team.companies.find(x => x.company._id === move.to);
    if (moved) return { company: moved.company, planned: true };
    const raw = (emp.traits || []).some(t => t.code === 'laborer');
    const fits = team.companies.filter(x => x !== entry && (market?.types?.[x.company.itemCode] === 'raw') === raw)
      .sort((a, b) => (productFor(b.company.itemCode)?.ratio ?? 0) - (productFor(a.company.itemCode)?.ratio ?? 0));
    return { company: fits[0]?.company || null, planned: false };
  }

  // Energy now: the bar read at load time, plus what regenerated since.
  function energyNow() {
    const bar = team?.energyBar;
    if (!bar || bar.value == null) return null;
    const regen = bar.regen > 0 ? bar.regen * (Date.now() - bar.at) / 36e5 : 0;
    return Math.floor(Math.min(bar.max ?? Infinity, bar.value + regen));
  }
  function energyFullText() {
    const bar = team?.energyBar;
    if (bar?.value == null || bar.max == null) return 'Full time unavailable';
    if (bar.value >= bar.max) return 'Energy full';
    if (!(bar.regen > 0)) return 'Not regenerating';
    const remaining = (bar.max - bar.value) / bar.regen * 36e5 - (Date.now() - bar.at);
    return remaining <= 0 ? 'Energy full' : `Full in ${formatDuration(remaining)}`;
  }
  function updateEnergyTile() {
    const tile = $team.querySelector('#tr-energy');
    if (!tile) return;
    const energy = energyNow(), bar = team.energyBar;
    tile.querySelector('strong').textContent = `${energy}${bar.max ? ` / ${bar.max}` : ''}`;
    tile.querySelector('em').textContent = energyFullText();
  }
  const minutesTo10 = now => team?.energyBar?.regen > 0 ? Math.ceil((10 - now) / team.energyBar.regen * 60) : null;
  const doneToday = emp => trainedToday(emp) >= (emp.trainingsPerDay || 1);
  const untilReset = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d - Date.now(); };
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

  function trainingProfit(value, emp) {
    const days = EC.workingDays(emp);
    if (!(market?.ppValue > 0) || !(days > 0) || !Number.isFinite(value)) return '';
    const lifetime = value * market.ppValue;
    const daily = lifetime / days;
    const amount = n => `${n < 0 ? '−' : '+'}₿${Math.abs(n).toLocaleString('en', { maximumFractionDigits: 3 })}`;
    return `<span class="tr-act-profit" title="Expected extra lifetime profit (money) from the next training hand, including coworker effects after they retire. Actions rank by this lifetime value. Daily and hourly figures average it over their ${days} remaining working days."><span>${amount(lifetime)}/career</span><small>${amount(daily)}/day</small><small>${amount(daily / 24)}/h</small></span>`;
  }

  function replacementProfit(row) {
    if (!(market?.ppValue > 0) || !Number.isFinite(row.value)) return '';
    const amount = value => `${value < 0 ? '−' : '+'}₿${Math.abs(value * market.ppValue).toLocaleString('en', { maximumFractionDigits: 3 })}`;
    const { fresh, surplus } = row.keep;
    const daily = fresh.days > 0 ? row.value / fresh.days : null;
    return `<span class="tr-act-profit" title="Expected career profit gain from replacing this employee: new hire surplus ${amount(fresh.best)}, minus keeping surplus ${amount(surplus)}. Both careers account for the value of occupying the slot. Daily and hourly figures average this gain over the new hire's expected working days. Compare candidates before firing."><span>${amount(row.value)}/career</span>${daily == null ? '<small>expected gain</small>' : `<small>${amount(daily)}/day</small><small>${amount(daily / 24)}/h</small>`}</span>`;
  }

  // What to spend energy on, best first: trainings, hires and replacements.
  // Replacing someone spends a hire's 10 energy, so it ranks with the
  // trainings by what that energy earns: the pick less keeping them and
  // the firing, both after the slot's rate. Training and replacing the same employee rule each
  // other out, so only the better-ranked of the two stays.
  // When the planner would move someone marked Replace, the move comes
  // first (moved): it's free, and their verdict changes with the company.
  function energyActions() {
    const flagged = keepRows().filter(r => ['fire', 'replace'].includes(keepVerdict(r)));
    const moved = new Set(flagged.filter(r => plannedMove(r.emp._id)).map(r => r.emp._id));
    const replace = flagged.filter(r => !moved.has(r.emp._id))
      .map(r => ({ kind: 'replace', value: r.gain + r.alt, emp: r.emp, entry: r.entry, keep: r, ready: true }));
    const seen = new Set();
    const ready = [...feedRows().filter(r => r.ready && !(r.kind === 'train' && pendingHand(r.emp))), ...replace]
      .sort((a, b) => b.value - a.value)
      .filter(r => r.kind === 'hire' || (!seen.has(r.emp._id) && seen.add(r.emp._id)));
    return { moved, ready };
  }

  // The numbered list, top to bottom: Do now (hands dealt, moves before replacing), Spend
  // energy (trainings, hires and replacements), Check (the planner, mismatches)
  // and Trained today. Each item opens the tab that acts on it.
  function nextActions() {
    // How many traits the employee holds, hidden ones included; names on hover.
    const traitsChip = emp => {
      const list = emp.traits || [];
      return list.length ? `<span title="${escapeHtml(list.map(t => t.revealed === false ? 'Hidden trait' : traitName(t.code)).join(', '))}">${plural(list.length, 'trait')}</span>` : '<span>No traits</span>';
    };
    const groups = { now: [], energy: [], check: [], done: [] };
    const where = entry => companyLabelHtml(entry.company);
    const all = team.companies.flatMap(entry => entry.employees.map(emp => ({ emp, entry })));
    for (const { emp, entry } of all) {
      const hand = pendingHand(emp);
      if (hand) groups.now.push({ icon: '🃏', go: { tab: 'train', emp: emp._id },
        what: `Pick a card for ${escapeHtml(emp.name)}`,
        sub: `${RARITY_NAME[hand.rarity]} hand${hand.drawnAt ? `, dealt ${utcTime(new Date(hand.drawnAt))}` : ''} · ${where(entry)}` });
    }
    const energy = energyNow();
    const actions = energy == null ? null : Math.floor(energy / 10);
    const { moved, ready } = energyActions();
    for (const r of keepRows().filter(r => moved.has(r.emp._id))) {
      const m = plannedMove(r.emp._id);
      const to = team.companies.find(x => x.company._id === m.to);
      groups.now.push({ icon: '🧭', go: { tab: 'assignments', emp: r.emp._id },
        what: `Move ${escapeHtml(r.emp.name)}${to ? ` to ${companyLabelHtml(to.company)}` : ''} instead of replacing`,
        sub: `${keepVerdict(r) === 'fire' ? 'Costs more than they earn' : `A new hire beats keeping them ${odds(r.chance)} of the time`} where they are · moving is free · ${where(r.entry)}` });
    }
    const preview = ready.slice(0, Math.min(8, Math.max(3, actions ?? 3)));
    preview.push(...ready.filter(r => r.kind === 'hire' && !preview.includes(r)));
    const shown = nextActionsExpanded ? ready : preview;
    // Below this line, working yourself earns more than the action.
    const self = selfWorkValue();
    let selfShown = !self;
    const selfLine = () => { selfShown = true; groups.energy.push({ cut: `Below here, self-work earns more: ≈ ${signedPP(self.value)} PP per 10 energy (${escapeHtml(self.from)})` }); };
    shown.forEach((r, i) => {
      if (!selfShown && r.value < self.value) selfLine();
      if (r.kind === 'train') {
        const profit = trainingProfit(r.value, r.emp);
        groups.energy.push({ icon: '🎓', go: { tab: 'train', emp: r.emp._id },
        what: `Train ${escapeHtml(r.emp.name)}`,
        sub: `<span class="tr-act-company">${productIcon(r.entry.company.itemCode)} ${escapeHtml(companyName(r.entry.company))}</span>
          <span class="tr-act-details"><span>${plural(r.left, 'training')} left</span>${traitsChip(r.emp)}<span>Age ${r.emp.age}</span></span>${r.pricing
            ? `<span class="tr-act-notice" title="${escapeHtml(r.basis)}">${r.pricing === 'pending' ? 'Current company only; valuing moves…' : 'Current company only'}</span>` : ''}`,
        value: profit || `≈ ${signedPP(r.value)} PP`, unit: profit ? `≈ ${signedPP(r.value)} PP` : 'avg next hand' });
      }
      else if (r.kind === 'replace') {
        const profit = replacementProfit(r);
        groups.energy.push({ icon: '🔁', go: { tab: 'keep', emp: r.emp._id },
        what: `Replace ${escapeHtml(r.emp.name)}`,
        sub: `<span class="tr-act-company">${productIcon(r.entry.company.itemCode)} ${escapeHtml(companyName(r.entry.company))}</span>
          <span class="tr-act-details"><span title="Chance a fresh candidate set offers a better replacement">${odds(r.keep.chance)} better hire</span>${traitsChip(r.emp)}<span>Age ${r.emp.age}</span></span>${keepVerdict(r.keep) === 'fire' ? '<span class="tr-act-notice tr-warn">Costs more than they earn</span>' : ''}${r.keep.from ? `<span class="tr-act-notice tr-warn">Can be fired from ${utcTime(r.keep.from)}</span>` : ''}${plan?.running ? '<span class="tr-act-notice">Planner still checking moves</span>' : ''}${hirePrefs(without(r.entry, r.emp)).slice(0, 2).map(x => `<span class="tr-act-notice" title="${escapeHtml(x.why)}">Prefer ${escapeHtml(x.want)}</span>`).join('')}`,
        value: profit || `≈ ${signedPP(r.value)} PP`, unit: profit ? `≈ ${signedPP(r.value)} PP` : 'avg replacement' });
      }
      else groups.energy.push({ icon: '➕', go: { tab: 'hire', company: r.entry.company._id },
        what: `Hire into ${where(r.entry)}`, sub: `${r.entry.employees.length} of ${r.cap} Break Room slots used · best of ${r.slots} candidates`,
        value: `≈ ${signedPP(r.value)} PP`, unit: 'avg pick; current-company hire estimate' });
      if (actions != null && i === actions - 1 && i < shown.length - 1) groups.energy.push({ cut: `Your ${energy} energy covers the ${plural(actions, 'action')} above` });
    });
    if (!selfShown && shown.length === ready.length) selfLine();
    if (ready.length > preview.length) groups.energy.push({ cut: nextActionsExpanded ? 'Show fewer actions' : `Show ${ready.length - preview.length} more actions`, expand: true });

    if (plan?.running) groups.check.push({ icon: '🧭', go: { tab: 'assignments' }, what: 'Comparing assignments…', sub: 'The planner is searching in the background' });
    else if (plan?.gain > 1e-7) groups.check.push({ icon: '🧭', go: { tab: 'assignments' },
      what: `Rearrange: ${plan.gain >= 0 ? '+' : '−'}${Math.abs(plan.gain).toFixed(2)} ${plan.horizon === 'career' ? 'over their careers' : `over ${plural(plan.days, 'day')}`}`,
      sub: `${plural(plan.changes, 'move or tool change', 'moves or tool changes')}${plan.cancelled ? ', search cut short' : ''} · in game money after wages` });
    for (const { emp, entry } of all) {
      const m = mismatchOf(emp, entry.company);
      if (!m || moved.has(emp._id)) continue;
      const to = fitFor(emp, entry);
      groups.check.push({ icon: '⚠️', go: { tab: 'assignments' }, what: to.planned
        ? `Move ${escapeHtml(emp.name)} to ${companyLabelHtml(to.company)}`
        : `Check ${escapeHtml(emp.name)}'s company`,
        sub: `${escapeHtml(m)}: −1 Production there instead of +3 · ${where(entry)}${to.planned ? ' · the planner\'s move'
          : to.company ? ` · try ${companyLabelHtml(to.company)}${team.companies.find(x => x.company === to.company).employees.length >= headcountCap(to.company) ? ' (full, so a swap)' : ''}` : ''}` });
    }
    if (!spareTools().length) groups.check.push({ icon: '🧰', go: { tab: 'assignments', tools: true }, what: 'Enter your spare tools',
      sub: 'Equipped tools come from the game. Spare ones need entering so assignments and card values can place them' });

    for (const { emp, entry } of all) {
      if (doneToday(emp) && !pendingHand(emp)) groups.done.push({ go: { tab: 'train', emp: emp._id }, what: escapeHtml(emp.name),
        sub: taken.has(emp._id) ? `Took ${escapeHtml(taken.get(emp._id).text)} · until you reload` : where(entry) });
    }

    const energyHead = energy == null ? '' : energy >= 10
      ? ` · ${energy} energy, ${plural(actions, 'action')}`
      : ` · ${energy} energy${minutesTo10(energy) != null ? `, 10 more in ${escapeHtml(formatDuration(minutesTo10(energy) * 6e4))}` : ''}`;
    const heads = { now: 'Do now', energy: `Spend energy${energyHead}`, check: 'Check' };
    let n = 0;
    const item = (a, done) => a.cut ? `<li class="tr-act-cut">${a.expand ? `<button type="button" class="tr-act-more" data-next-actions-toggle aria-expanded="${nextActionsExpanded}" aria-controls="tr-next-actions">${escapeHtml(a.cut)}</button>` : escapeHtml(a.cut)}</li>`
      : `<li><button type="button" class="tr-act${a.go.tab === 'train' ? ' tr-act-training' : a.go.tab === 'keep' ? ' tr-act-replacement' : ''}${done ? ' done' : ''}" data-go-tab="${a.go.tab}"${a.go.emp ? ` data-go-emp="${a.go.emp}"` : ''}${a.go.tools ? ' data-go-tools' : ''}${a.go.company ? ` data-go-company="${a.go.company}"` : ''}>
          <span class="tr-act-rank">${done ? '✓' : ++n}</span><span class="tr-act-icon" aria-hidden="true">${a.icon || ''}</span>
          <span class="tr-act-main">${a.what}<small>${a.sub}</small></span>
          ${a.value ? `<span class="tr-act-value">${a.value}<small>${a.unit}</small></span>` : ''}</button></li>`;
    const body = Object.entries(groups).filter(([k, list]) => k !== 'done' && list.length).map(([k, list]) =>
      `<li class="tr-act-group">${heads[k]}</li>${list.map(a => item(a, false)).join('')}`).join('');
    return `<div class="tr-section-heading"><h3 class="tr-pane-title" id="tr-acts-h">Next actions</h3>${help('How the list is ordered', `<p><strong>Do now</strong> lists training hands waiting for a choice, and moves the planner makes for employees marked Replace: moving is free and changes their verdict, so it comes before replacing them.</p><p><strong>Spend energy</strong> ranks actions by the production points each 10 energy earns before retirement. Training uses the average value of the best card in the next hand. Hiring uses the best candidate in a fresh set. Replacing uses that candidate's value, minus the value of keeping the employee and the cost of firing.</p><p>Replacement appears when a fresh hire wins at least two times in three, or the employee costs more than they earn. If training and replacing the same employee both qualify, only the better action appears.</p><p>When your own work earns more per 10 energy than an action, a line marks where self-work takes over.</p><p><strong>Check</strong> lists assignment suggestions and employees making the wrong product type.</p>`)}</div>
      <ol class="tr-acts" id="tr-next-actions">${body || '<li class="tr-act-group">Nothing to do right now</li>'}</ol>
      ${groups.done.length ? `<details class="tr-more tr-done"${$team.querySelector('.tr-done')?.open ? ' open' : ''}><summary>Trained today (${groups.done.length}) <em>Ready at 00:00 UTC, in ${escapeHtml(formatDuration(untilReset()))}</em></summary><ol class="tr-acts">${groups.done.map(a => item(a, true)).join('')}</ol></details>` : ''}
      `;
  }

  // Flags for an employee's row: Keep or replace verdict, mismatch, a
  // hand waiting, one of the top trainings, trained today.
  function flagsOf(emp, entry, verdicts, topTrain) {
    const v = verdicts.get(emp._id);
    return [
      v && v !== 'keep' ? `<span class="tr-badge tr-badge-${v}">${VERDICT[v]}</span>` : '',
      mismatchOf(emp, entry.company) ? `<span class="tr-badge tr-badge-mismatch" title="${escapeHtml(mismatchOf(emp, entry.company))}">Mismatch</span>` : '',
      pendingHand(emp) ? '<span class="tr-badge tr-badge-hand">Hand</span>'
        : doneToday(emp) ? '<span class="tr-badge">Trained</span>'
          : topTrain.has(emp._id) ? '<span class="tr-badge tr-badge-train">Train</span>' : '',
    ].join('');
  }

  // The roster, one row per employee under a row per company.
  function rosterTable() {
    const verdicts = new Map(keepRows().map(r => [r.emp._id, keepVerdict(r)]));
    const topTrain = new Set(feedRows().filter(r => r.kind === 'train' && r.ready).slice(0, 5).map(r => r.emp._id));
    const stat = (emp, k) => {
      const base = emp.base?.[k] ?? 0, total = emp.breakdown?.[k]?.total ?? base, diff = total - base;
      return `${base}${diff ? `<span class="${diff < 0 ? 'tr-neg' : 'tr-pos'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</span>` : ''}`;
    };
    const pips = emp => `<span class="tr-emp-pips" title="${emp.potential || 0} used of ${emp.potentialMax || 0}">${Array.from({ length: emp.potentialMax || 0 }, (_, k) => `<i${k < (emp.potential || 0) ? ' class="used"' : ''}></i>`).join('')}</span>`;
    const body = team.companies.filter(x => x.employees.length || x.estimate?.production).map((entry, i) => {
      const { company, employees, estimate } = entry;
      const p = productFor(company.itemCode);
      const cProfit = p && estimate ? (estimate.production || 0) * p.perPP - (estimate.wageCost || 0) - (estimate.managerCost || 0) : null;
      const rows = employees.map(emp => {
        const profit = p && emp.estimate ? emp.estimate.production * p.perPP - emp.wage : null;
        const left = Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0));
        const traits = (emp.traits || []).map(t => t.revealed === false ? 'hidden trait' : traitName(t.code)).join(', ');
        return `<tr class="tr-roster-emp${emp._id === input.pick ? ' selected' : ''}" data-emp="${emp._id}">
          <td><button type="button" class="tr-roster-name" data-go-tab="train" data-go-emp="${emp._id}">${escapeHtml(emp.name)}</button>
            ${traits ? `<small>${escapeHtml(traits)}</small>` : ''}
            <small class="tr-roster-mob">Age ${emp.age} · Prod ${stat(emp, 'production')} · ${plural(left, 'training')} left</small></td>
          <td class="num tr-roster-wide">${emp.age}</td>
          <td class="tr-roster-wide">Prod ${stat(emp, 'production')} · Resp ${stat(emp, 'responsibility')} · Luck ${stat(emp, 'luck')}</td>
          <td class="tr-roster-wide">${pips(emp)} <span class="tr-muted">${left}</span></td>
          <td><span class="tr-badges">${flagsOf(emp, entry, verdicts, topTrain)}</span></td>
          <td class="num${profit != null && profit < 0 ? ' tr-neg' : ''}">${moneyFmt(profit)}/h</td></tr>`;
      }).join('');
      // Phones hide three columns, so the heading spans fewer there.
      const head = `${companyLink(company)} <span class="tr-muted">${productIcon(company.itemCode)}${p ? ` (${p.ratio.toFixed(2)}×)` : ''} · ${employees.length} of ${headcountCap(company)}</span>`;
      return `<tbody style="--co:var(--tr-co-${i % 8 + 1})"><tr class="tr-roster-co"><th colspan="5" scope="colgroup" class="tr-roster-wide">${head}</th>
          <th colspan="2" scope="colgroup" class="tr-roster-narrow">${head}</th>
          <td class="num${cProfit != null && cProfit < 0 ? ' tr-neg' : ''}">${moneyFmt(cProfit)}/h</td></tr>${rows}</tbody>`;
    }).join('');
    return `<table class="tr-roster"><thead><tr><th scope="col">Employee</th><th scope="col" class="num tr-roster-wide">Age</th><th scope="col" class="tr-roster-wide">Stats</th>
      <th scope="col" class="tr-roster-wide">Trainings</th><th scope="col">Flags</th><th scope="col" class="num">Profit</th></tr></thead>${body}</table>`;
  }

  /* ── Candidates ──────────────────────────────────────────── */
  // The recruiting slots can't be read with an API key (getCandidates is
  // session-only), so candidates are typed in from their cards. Each is
  // priced like a hire (EmployeeCore.candidateValue) in the chosen company,
  // plus what their nationality, gender, Production and wage do to the
  // traits of the coworkers they'd join. The verdict weighs the best one
  // against a fresh set (a reroll, or tomorrow's free one).
  const RECRUIT_KEY = 'tr-recruit-v1';
  const MAX_SLOTS = 6;   // 3, plus 1 per Recruiter up to 3
  const LETTERS = 'ABCDEF';
  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const CAND_FIELDS = ['age', 'gender', 'nat', 'wage', 'production', 'responsibility', 'luck'];
  const blankCand = () => ({ age: '', gender: 'male', nat: '', wage: '', production: '', responsibility: '', luck: '' });
  // Candidates saved before cards showed every stat carry traits, a hidden
  // count and potential; those are left behind.
  const savedCand = c => ({ ...blankCand(), ...Object.fromEntries(CAND_FIELDS.filter(k => c?.[k] != null).map(k => [k, c[k]])) });
  function loadRecruit() {
    const fresh = { company: '', headcount: null, unit: 'day', day: todayUtc(), rerolls: 0, cands: [blankCand(), blankCand(), blankCand()] };
    try {
      const saved = JSON.parse(localStorage.getItem(RECRUIT_KEY) || 'null');
      if (!saved) return fresh;
      // Rerolls restart at 00:00 UTC; the typed candidates stay.
      const { replace, ...kept } = saved;
      if (Array.isArray(kept.cands)) kept.cands = kept.cands.slice(0, MAX_SLOTS).map(savedCand);
      else delete kept.cands;
      return { ...fresh, ...kept, rerolls: saved.day === fresh.day ? saved.rerolls || 0 : 0, day: fresh.day };
    } catch { return fresh; }
  }
  let recruit = loadRecruit();
  const saveRecruit = () => { try { localStorage.setItem(RECRUIT_KEY, JSON.stringify(recruit)); } catch { /* private mode */ } };
  let countries = null;   // [{ _id, name }] by name, once loaded
  const $recruit = document.getElementById('tr-recruit-body');
  const numOrNull = v => v === '' || v == null || !Number.isFinite(+v) ? null : +v;
  const countryName = id => countries?.find(c => c._id === id)?.name || 'Unknown';

  // The team's feed, worked out once per loaded team and price set.
  let feedMemo = { revision: null, batch: null, rows: [] };
  function feedRows() {
    const pricer = prepareCardPricing();
    const revision = JSON.stringify([cardRevision, plan && !plan.running ? plan.tools : null]);
    if (feedMemo.revision !== revision) {
      const rows = energyFeed();
      const trains = rows.filter(r => r.kind === 'train');
      const jobs = trains.map(r => {
        const job = pricingJob(r.emp, r.entry, [], true);
        job.cards = Object.values(EC.cardPool(job.options.employee, job.options.context, { price: c =>
          c.card === 'negotiation' ? EC.cardValue(job.options.employee, c, job.options.context) : 0 })).flat()
          .map(({ value, ...c }) => c);
        return job;
      });
      const batch = jobs.length ? pricer.request(JSON.stringify(['feed', jobs]), jobs, 2) : { status: 'fallback', reason: 'No trainings available.' };
      feedMemo = { revision, batch, rows, jobs, published: false };
    }
    const { batch, jobs } = feedMemo;
    if (batch.status === 'done' && !feedMemo.published) {
      const results = new Map(jobs.map((job, i) => {
        const group = batch.result.groups[i];
        const quotes = new Map(job.cards.map((c, j) => [cardKey(c), group.quotes[j]]));
        const outlook = EC.trainingOutlook(job.options.employee, job.options.context, { price: c => quotes.get(cardKey(c))?.value ?? null });
        return [job.subjectId, { outlook }];
      }));
      feedMemo.rows = feedMemo.rows.map(r => {
        const result = r.kind === 'train' && results.get(r.emp._id);
        return result ? { ...r, value: result.outlook.value, outlook: result.outlook,
          basis: 'avg next hand, incl. moves; restricted pairs; unpriced effects count zero' } : { ...r, basis: 'current-company hire estimate' };
      });
      feedMemo.published = true;
    }
    if (batch.status !== 'done') return feedMemo.rows.map(r => ({ ...r,
      pricing: batch.status, basis: batch.status === 'pending' ? 'recalculating; current-company estimate' : `current-company fallback: ${batch.reason}` }));
    return feedMemo.rows;
  }

  // What 10 energy earns elsewhere, in PP. With more trainings than a full
  // energy bar covers, energy is the limit, so it's the last training the
  // bar would fund; otherwise the least valuable training; with no team
  // loaded, a typical employee's. Self-work sets it instead when it pays more.
  const energyValue = () => altFrom(feedRows());
  function altFrom(rows) {
    const trains = rows.filter(r => r.kind === 'train' && r.ready);
    const self = selfWorkValue();
    let best;
    if (!trains.length) best = { value: EC.trainingOutlook({}, { management: team?.management ?? 0 }).value, from: 'a typical employee\'s next training' };
    else {
      const bar = team.energy ? Math.floor(team.energy / 10) : trains.length;
      const r = trains[Math.min(bar, trains.length) - 1];
      best = { value: r.value, from: `training ${r.emp.name}, ${bar < trains.length ? 'the last training a full energy bar pays for' : 'your least valuable training'}` };
    }
    return self && self.value > best.value ? self : best;
  }

  // What 10 energy of your own work earns at your best-margin company, in
  // PP at today's prices (ProductPickerTool.selfWorkProjection).
  function selfWorkValue() {
    const s = team?.totalProfit?.projectedSelfWork;
    if (!(s?.actions > 0) || !(s.cost > 0) || !(market?.ppValue > 0)) return null;
    return { value: s.profit / s.actions * 10 / s.cost / market.ppValue, from: `self-work in ${s.company.name || productName(s.company.itemCode)}` };
  }

  const recruitEntry = () => team?.companies.find(x => x.company._id === recruit.company)
    || team?.companies.find(x => x.employees.length < headcountCap(x.company)) || team?.companies[0] || null;

  // The company seen by someone joining, or a typical one with no team loaded.
  function setupFor(entry, newcomer) {
    if (entry) return joinSetup(entry, teamMgmt(), newcomer);
    return {
      ctx: { ...EC.DEFAULT_CONTEXT, management: team?.management ?? 0, situation: { ...EC.DEFAULT_SITUATION, gender: newcomer.gender || 'male', place: 'home' } },
      opts: { bonus: 0.25 },
    };
  }

  // What a newcomer does to the traits the company's employees hold: a
  // foreign hire costs a Nationalist and Xenophobe and helps a
  // Cosmopolitan; gender moves Girl Power and the like; Production moves
  // Rival and Mentor; a higher wage makes an Envious coworker unhappier.
  function coworkerImpact(entry, { nationality, gender, production, wage }) {
    let value = 0;
    const notes = [];
    for (const emp of entry?.employees || []) {
      const inp = inputsFor(emp, entry, { models: false });
      const e = employeeOf(inp), ctx = contextOf(inp), s = ctx.situation;
      const nats = new Set([...entry.employees.filter(x => x._id !== emp._id).map(x => x.nationality), nationality]
        .filter(n => n && n !== emp.nationality));
      const own = paidProd(emp);
      const after = { ...ctx, situation: {
        ...s, coworkers: s.coworkers + 1, femaleCoworkers: s.femaleCoworkers + (gender === 'female' ? 1 : 0),
        otherNationalities: nats.size,
        strongerCoworker: s.strongerCoworker || production > own, weakerCoworker: s.weakerCoworker || production < own,
        peers: s.peers && market?.ppValue ? [...s.peers, { production, wagePP: wage / market.ppValue }] : null,
        betterPaid: s.betterPaid + (wage > emp.wage ? 1 : 0),
      } };
      for (const t of inp.traits) {
        const was = EC.traitValue(t.code, e, ctx, { held: true, arg: t.arg }).value;
        const now = EC.traitValue(t.code, e, after, { held: true, arg: t.arg }).value;
        if (was == null || now == null || Math.abs(now - was) < 0.5) continue;
        value += now - was;
        notes.push(`${emp.name}'s ${traitName(t.code)}`);
      }
    }
    return { value, notes };
  }

  // What a newcomer's gender, nationality and Production do to this
  // company's coworker traits, where the difference is worth noticing:
  // [{ want, why, value }], biggest first. A Man Hater wants a woman, a
  // Nationalist a local, a Cosmopolitan a nationality the company lacks.
  const PREF_MIN = 10;   // PP
  function hirePrefs(entry) {
    if (!entry?.employees.length || !market?.ppValue) return [];
    const local = entry.region?.country;
    const at = ({ gender = 'male', nationality = local, production = 2.5 }) =>
      coworkerImpact(entry, { gender, nationality, production, wage: production / EC.CFG.outputDivisor * market.ppValue });
    const pref = (want, other, a, b) => {
      const value = a.value - b.value;
      return value >= PREF_MIN ? { want, value, why: `${signedPP(value)} PP over ${other} for coworkers' traits: ${[...new Set([...a.notes, ...b.notes])].join(', ')}` } : null;
    };
    const f = at({ gender: 'female' }), m = at({ gender: 'male' });
    const out = [pref('a woman', 'a man', f, m), pref('a man', 'a woman', m, f)];
    // Nationalities: a local, each one already in the company, and one new to it.
    const here = new Set(entry.employees.map(x => x.nationality).filter(Boolean));
    const nats = [...new Set([local, ...here].filter(Boolean))].map(n => ({ n, label: n === local ? `a local (${countryName(n)})` : `a ${countryName(n)} hire` }));
    nats.push({ n: '\0new', label: 'a nationality new to the company' });
    for (const x of nats) x.v = at({ nationality: x.n });
    const best = nats.reduce((a, x) => x.v.value > a.v.value ? x : a), worst = nats.reduce((a, x) => x.v.value < a.v.value ? x : a);
    // Everyone foreign scores alike: say "a foreigner" rather than one country.
    const foreign = best.n !== local && local && nats.filter(x => x.n !== local).every(x => best.v.value - x.v.value < PREF_MIN);
    out.push(pref(foreign ? 'a foreigner' : best.label, worst.label, best.v, worst.v));
    const hi = at({ production: 4 }), lo = at({ production: 1 });
    out.push(pref('high Production', 'low Production', hi, lo), pref('low Production', 'high Production', lo, hi));
    return out.filter(Boolean).sort((a, b) => b.value - a.value);
  }
  const prefsHtml = (prefs, head) => prefs.length ? `<div class="tr-hire-prefs"><span>${head}</span><ul>${prefs.map(x => `<li><strong>${escapeHtml(x.want[0].toUpperCase() + x.want.slice(1))}</strong> <small>${escapeHtml(x.why)}</small></li>`).join('')}</ul></div>` : '';

  // The wage as typed, per hour (the card may show it per day).
  const hourlyWage = c => { const w = numOrNull(c.wage); return w == null ? null : recruit.unit === 'day' ? w / 24 : w; };
  const STATS = ['production', 'responsibility', 'luck'];
  function priceCandidate(c, entry, alt) {
    const age = numOrNull(c.age), wage = hourlyWage(c);
    const [production, responsibility, luck] = STATS.map(k => numOrNull(c[k]));
    if (age == null || wage == null || !c.nat || production == null || responsibility == null || luck == null || !market?.ppValue) return null;
    const newcomer = { nationality: c.nat, gender: c.gender, production, wage };
    const { ctx, opts } = setupFor(entry, newcomer);
    const v = EC.candidateValue({ age, gender: c.gender, wagePP: wage / market.ppValue, production, responsibility, luck }, ctx, { ...opts, alt });
    const cw = coworkerImpact(entry, newcomer);
    // How often they turn out above bar, over the trait and potential.
    const beat = bar => v.spread.reduce((a, w) => w.value + cw.value > bar ? a + w.p : a, 0);
    return { ...v, coworkers: cw, total: v.value + cw.value, beat, place: ctx.situation.place };
  }

  const PLACE_TEXT = { homeCore: 'in a home core region', home: 'in their home country', abroad: 'abroad' };
  // One candidate as the game's card shows them: age, gender, nationality,
  // wage and the three stats. The trait and potential show after hire.
  function candCard(c, i) {
    const id = k => `tr-c${i}-${k}`;
    const num = (k, label, attrs, cls = '') => `<label class="tr-field${cls}" for="${id(k)}"><span>${label}</span><input id="${id(k)}" type="number" data-c="${i}" data-k="${k}" value="${escapeHtml(String(c[k]))}" ${attrs} /></label>`;
    const natOpts = countries
      ? `<option value="">Choose…</option>${countries.map(n => `<option value="${n._id}"${n._id === c.nat ? ' selected' : ''}>${escapeHtml(n.name)}</option>`).join('')}`
      : '<option value="">Loading countries…</option>';
    return `<article class="tr-cand" id="tr-cand-${i}" aria-labelledby="tr-cand-h-${i}">
      <div class="tr-cand-head"><strong id="tr-cand-h-${i}">Candidate ${LETTERS[i]}</strong>${recruit.cands.length > 1 ? `<button type="button" class="tr-cand-drop" data-r-drop="${i}" aria-label="Remove candidate ${LETTERS[i]}">×</button>` : ''}</div>
      <div class="tr-cand-always">
        ${num('age', 'Age', 'min="18" max="45" step="1" inputmode="numeric"')}
        <label class="tr-field" for="${id('gender')}"><span>Gender</span><select id="${id('gender')}" data-c="${i}" data-k="gender">${[['male', 'Male'], ['female', 'Female']].map(([v, t]) => `<option value="${v}"${v === c.gender ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        ${num('wage', `Wage /${recruit.unit === 'day' ? 'day' : 'h'}`, 'min="0" step="any" inputmode="decimal"')}
        <label class="tr-field tr-cand-nat" for="${id('nat')}"><span>Nationality</span><select id="${id('nat')}" data-c="${i}" data-k="nat">${natOpts}</select></label>
      </div>
      <div class="tr-cand-stats">
        ${num('production', 'Prod', 'min="1" max="4" step="1" inputmode="numeric" required')}
        ${num('responsibility', 'Resp', 'min="1" max="4" step="1" inputmode="numeric" required')}
        ${num('luck', 'Luck', 'min="1" max="4" step="1" inputmode="numeric" required')}
      </div>
      <div class="tr-cand-res" id="tr-cand-res-${i}"></div>
    </article>`;
  }

  // Hiring needs a free Break Room slot: a full company fires first
  // (Keep or replace), reloads, then hires into the slot.
  function renderRecruitForm() {
    if (!$recruit) return;
    const entry = recruitEntry();
    if (entry && recruit.company !== entry.company._id) {
      recruit.company = entry.company._id;
      saveRecruit();
    }
    const full = entry && entry.employees.length >= headcountCap(entry.company);
    const companyOpts = team
      ? team.companies.map(x => {
        const cap = headcountCap(x.company), n = x.employees.length;
        return `<option value="${x.company._id}"${x === entry ? ' selected' : ''}>${escapeHtml(`${companyLabel(x.company)} · ${n >= cap ? 'full' : `${cap - n} free`}`)}</option>`;
      }).join('')
      : '<option value="">Load your employees above to pick a company</option>';
    let body;
    if (full) {
      const rows = keepRows().filter(r => r.entry === entry);
      const weakest = rows.reduce((a, r) => !a || r.chance > a.chance ? r : a, null);
      body = `<div class="tr-verdict muted"><span class="tr-verdict-take">${escapeHtml(companyName(entry.company))} is full</span>
        <small>A full company can't hire. Fire someone first, <button type="button" class="tr-link" data-reload>reload</button>, then type the candidates in here.${weakest ? ` Most worth replacing here: <button type="button" class="tr-link" data-go-tab="keep" data-go-emp="${weakest.emp._id}">${escapeHtml(weakest.emp.name)}</button> (${keepVerdict(weakest) === 'fire' ? 'Fire' : `${odds(weakest.chance)} replacement chance`}).` : ''}</small></div>`;
    } else {
      body = `<div id="tr-recruit-verdict"></div>
      <div class="tr-cands">${recruit.cands.map(candCard).join('')}</div>
      <div class="tr-recruit-actions">
        ${recruit.cands.length < MAX_SLOTS ? '<button type="button" data-r-add>Add a candidate</button>' : ''}
        <button type="button" data-r-rerolled title="Clears the candidates and counts the reroll">I rerolled</button>
        <button type="button" data-r-clear>Clear</button>
        <span class="tr-muted">A Recruiter in the company adds a slot, up to 6.</span>
      </div>`;
    }
    const prefs = entry ? prefsHtml(hirePrefs(entry), `What to look for in ${escapeHtml(companyName(entry.company))}`) : '';
    $recruit.innerHTML = `
      ${help('How candidates are valued', `<p>Each candidate is worth their output after wages until retirement, plus their trait, their trainings and what they change for the coworkers' traits. Each point of Responsibility adds 3 happiness, and each point of happiness above 50 adds 1% to output.</p><p>The trait and potential show only after hire. The trait is the average roll, weighted by how likely each trait is. A wage expectation above 130% means Greedy, and one below 70% means Modest. Potential is averaged from 3 to 10. Each training counts only what it earns beyond the same 10 energy spent elsewhere.</p><p>The verdict compares the best candidate with a fresh set's likely pick, after what a new hire earns in the slot each working day. Reroll or wait when a fresh set is likely to do better.</p>`)}
      ${prefs}
      <div class="tr-recruit-top">
        <label class="tr-field" for="tr-r-company"><span>Hiring into</span><select id="tr-r-company" data-r="company"${team ? '' : ' disabled'}>${companyOpts}</select></label>
        ${full ? '' : `<label class="tr-field" for="tr-r-unit"><span>The card shows the wage</span><select id="tr-r-unit" data-r="unit"><option value="day"${recruit.unit === 'day' ? ' selected' : ''}>per day</option><option value="hour"${recruit.unit === 'hour' ? ' selected' : ''}>per hour</option></select></label>
        <label class="tr-field" for="tr-r-rerolls"><span>Rerolls today <em>next: ${10 * 2 ** recruit.rerolls} energy</em></span><input id="tr-r-rerolls" type="number" data-r="rerolls" min="0" max="10" step="1" value="${recruit.rerolls}" inputmode="numeric" /></label>`}
      </div>
      ${body}`;
    if (!full) renderRecruitResult();
  }

  // A fresh set in a company: each slot a candidate of a nationality drawn
  // from nationalityMix, either gender, priced where they'd work and with
  // what they'd do to the coworkers' traits (EmployeeCore.freshSetValue).
  // Nationalities only change the newcomer's own value through where
  // they'd work and how many other nationalities they'd meet, so those
  // share a key.
  function freshSet(entry, alt, slots = recruit.cands.length) {
    const groups = nationalityMix(entry).map(({ nationality, count }) => {
      const { ctx, opts } = setupFor(entry, { nationality, gender: 'male' });
      return {
        weight: count, ctx, ...opts, key: `${ctx.situation.place}|${ctx.situation.otherNationalities}`,
        coworkers: entry?.employees.length ? (production, wagePP, gender) =>
          coworkerImpact(entry, { nationality, gender, production, wage: wagePP * market.ppValue }).value : null,
      };
    });
    return EC.freshSetValue(groups, { alt, slots, rate: 'slot' });
  }

  /* ── Keep or replace ─────────────────────────────────────── */
  // Firing frees a Break Room slot for a better hire. Keeping an employee
  // is worth what they add over the working life left (EmployeeCore.
  // employeeValue), plus what their leaving would cost the traits their
  // coworkers hold (a Rival losing his stronger coworker, a Cosmopolitan
  // a nationality). Their slot is worth the best of a fresh candidate set
  // in the company without them. A candidate must beat the bar: keeping
  // them, plus the hire's 10 energy. Firing costs coworkers nothing. So
  // look at the candidates before firing.
  const HIRE_LOCK_MS = 12 * 36e5;   // a new hire can't be fired for 12h
  const without = (entry, emp) => ({ ...entry, employees: entry.employees.filter(x => x._id !== emp._id) });
  const fireFrom = emp => {
    const t = Date.parse(emp.createdAt);
    return Number.isFinite(t) && Date.now() - t < HIRE_LOCK_MS ? new Date(t + HIRE_LOCK_MS) : null;
  };
  const modelOf = (emp, entry) => {
    const inp = inputsFor(emp, entry, { models: false });
    return { inp, e: employeeOf(inp), ctx: contextOf(inp) };
  };
  // 3 candidate slots, plus 1 per Recruiter in the company, up to 3 extra.
  const slotsIn = entry => 3 + Math.min(3, entry.employees.filter(x => (x.traits || []).some(t => t.code === 'recruiter')).length);

  // What an employee's leaving does to the traits their coworkers hold.
  function departureImpact(entry, emp) {
    const rest = without(entry, emp);
    let value = 0;
    const notes = [];
    for (const x of rest.employees) {
      const was = modelOf(x, entry), now = modelOf(x, rest);
      for (const t of was.inp.traits) {
        const a = EC.traitValue(t.code, was.e, was.ctx, { held: true, arg: t.arg }).value;
        const b = EC.traitValue(t.code, now.e, now.ctx, { held: true, arg: t.arg }).value;
        if (a == null || b == null || Math.abs(b - a) < 0.5) continue;
        value += b - a;
        notes.push(`${x.name}'s ${traitName(t.code)}`);
      }
    }
    return { value, notes };
  }

  // stay: what keeping them is worth, coworkers' traits included. The slot
  // outlives them, so keeping them is charged the slot's rate (what a new
  // hire earns there a day) for each working day they hold it: surplus.
  // A fresh set's pick is charged the same way (fresh.best), so a young
  // hire doesn't win on working life alone. bar: what a candidate's
  // surplus must beat to replace them. gain: what a fresh set's pick is
  // worth over the bar, on average; chance: how often it beats it.
  function keepRow(emp, entry, alt) {
    const { e, ctx } = modelOf(emp, entry);
    const left = Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0));
    const keep = EC.employeeValue({ ...e, potentialMax: emp.potentialMax }, ctx, { alt, trainingsLeft: left });
    const rest = without(entry, emp);
    const leaving = departureImpact(entry, emp);
    const slots = slotsIn(rest);
    const fresh = freshSet(rest, alt, slots);
    const stay = keep.value - leaving.value;
    const days = EC.workingDays(e), held = fresh.rate * days, surplus = stay - held;
    const bar = surplus + alt;
    return { emp, entry, keep, leaving, fresh, slots, stay, days, held, surplus, bar, left, alt, gain: fresh.best - bar, chance: fresh.beat(bar), from: fireFrom(emp) };
  }

  // Every employee, most worth replacing first, once per team and price set.
  let keepMemo = { team: null, market: null, rows: [] };
  function keepRows() {
    if (!team || !market?.ppValue) return [];
    if (keepMemo.team !== team || keepMemo.market !== market) {
      const alt = energyValue().value;
      const rows = team.companies.flatMap(entry => entry.employees.map(emp => keepRow(emp, entry, alt)));
      keepMemo = { team, market, rows: rows.sort((a, b) => (keepVerdict(b) === 'fire') - (keepVerdict(a) === 'fire') || b.chance - a.chance) };
    }
    return keepMemo.rows;
  }

  const utcTime = d => `${d.toISOString().slice(11, 16)} UTC`;
  const VERDICT = { fire: 'Fire', replace: 'Replace', close: 'Close', keep: 'Keep' };
  // Fire whoever costs more than they earn, whatever a new set holds.
  // Otherwise it's how often a fresh set's pick turns out better.
  const keepVerdict = r => r.stay < 0 ? 'fire' : r.chance >= 2 / 3 ? 'replace' : r.chance >= 1 / 3 ? 'close' : 'keep';
  const odds = p => `${Math.round(p * 100)}%`;
  // The planner's move for an employee, once it has finished searching.
  const plannedMove = id => plan && !plan.running ? (plan.moves || []).find(m => m.employee === id) || null : null;

  const $fire = document.getElementById('tr-fire-body');
  // Keep or replace for the selected employee: keeping them against what
  // replacing them is worth (use case 3), then a line on the whole team.
  function renderFire() {
    if (!$fire) return;
    if (!team) { $fire.innerHTML = '<p class="tr-muted">Load your employees above to see who is worth keeping.</p>'; return; }
    if (!market?.ppValue) { $fire.innerHTML = '<p class="tr-muted">Loading prices…</p>'; return; }
    const rows = keepRows();
    const act = rows.filter(r => ['fire', 'replace'].includes(keepVerdict(r)));
    const r = rows.find(x => x.emp._id === input.pick);
    if (!r) { $fire.innerHTML = '<p class="tr-muted">Choose an employee.</p>'; return; }
    const { emp, entry } = r;
    const v = keepVerdict(r);
    const name = escapeHtml(emp.name);
    const net = r.fresh.best - r.alt;
    const rate = `${r.fresh.rate.toFixed(1)} PP a day, what a new hire earns there`;
    const part = (label, x, note = '') => Math.abs(x) < 0.5 && !note ? '' : `<li><span>${label}${note ? ` <em>${escapeHtml(note)}</em>` : ''}</span><strong>${signedPP(x)}</strong></li>`;
    const why = v === 'fire' ? `${name} costs more than they earn: firing gains ${signedPP(-r.stay)} PP even if nobody is hired.`
      : v === 'replace' ? `A new hire, picked from a fresh set of ${r.slots} candidates, beats keeping ${name} ${odds(r.chance)} of the time.`
      : v === 'close' ? `A new hire beats keeping ${name} ${odds(r.chance)} of the time: about a coin flip. Replace only if you'd rather gamble.`
      : `A new hire beats keeping ${name} only ${odds(r.chance)} of the time.`;
    const notes = [
      ...(emp.happinessBreakdown?.quitChance > 0 ? ['<span class="tr-warn">Unhappy enough to quit.</span>'] : []),
      ...(r.keep.unpriced.length ? [`${escapeHtml(r.keep.unpriced.map(traitName).join(', '))} not priced.`] : []),
    ];
    const steps = v === 'keep' ? '' : `<ol class="tr-keep-steps">
        <li>Fire ${name} in the game${r.from ? ` <span class="tr-warn">(from ${utcTime(r.from)}: hired under 12 hours ago)</span>` : ''}. A full company can't hire, so the slot has to be free first.</li>
        <li><button type="button" class="tr-link" data-reload>Reload</button>. ${companyLabelHtml(entry.company)} then shows a free slot.</li>
        <li>Open its recruiting slots and type the candidates into <button type="button" class="tr-link" data-go-tab="hire" data-go-company="${entry.company._id}">Hire</button>.</li>
      </ol>`;
    const m = plannedMove(emp._id), to = m && team.companies.find(x => x.company._id === m.to);
    const compare = `<button type="button" class="tr-link" data-go-tab="assignments" data-go-emp="${emp._id}">`;
    const move = v === 'keep' ? ''
      : plan?.running ? `<p class="tr-calc-sub">The planner is still checking whether moving ${name} beats replacing them.</p>`
      : m ? `<p class="tr-keep-move"><strong>Move them first.</strong> The planner would move ${name}${to ? ` to ${companyLabelHtml(to.company)}` : ''}. Moving is free and changes this verdict, so check again after the move. ${compare}See the move</button></p>`
      : plan ? `<p class="tr-calc-sub">The planner found no better company for ${name}.</p>`
      : `<p class="tr-calc-sub">${compare}Compare assignments</button> to see whether moving ${name} beats replacing them.</p>`;
    const prefs = v === 'keep' ? '' : prefsHtml(hirePrefs(without(entry, emp)), 'When you hire their replacement, look for');
    const top = act[0];
    const team_ = act.length
      ? `${plural(act.length, 'employee')} marked Fire or Replace.${top && top !== r ? ` Most worth replacing: <button type="button" class="tr-link" data-go-tab="keep" data-go-emp="${top.emp._id}">${escapeHtml(top.emp.name)}</button> (${keepVerdict(top) === 'fire' ? 'Fire' : odds(top.chance)}).` : ''}`
      : `Nobody is marked Fire or Replace. The highest replacement chance is ${odds(rows[0].chance)}, for ${rows[0] === r ? 'this employee' : `<button type="button" class="tr-link" data-go-tab="keep" data-go-emp="${rows[0].emp._id}">${escapeHtml(rows[0].emp.name)}</button>`}.`;
    $fire.innerHTML = `
      ${help('How this is worked out', `<p><strong>Worth keeping</strong> includes the employee's output, traits and remaining trainings, plus the value their traits add to coworkers.</p><p><strong>Worth replacing</strong> uses the best candidate from a fresh set, minus the hire's 10 energy. Firing costs coworkers nothing.</p><p>Both values subtract what a new hire would earn in that slot over the same working days. This accounts for the work you give up by keeping either employee in the slot.</p><p><strong>Replace</strong> means a fresh hire wins at least two times in three. <strong>Close</strong> means at least one time in three. <strong>Fire</strong> means the employee costs more than they earn.</p>`)}
      <div class="tr-verdict tr-keep-${v}"><span class="tr-verdict-take">${VERDICT[v]}${v === 'close' ? ' call' : ''}</span><small>${why}</small>
        ${r.from ? `<small class="tr-warn">Just hired: can be fired from ${utcTime(r.from)}.</small>` : ''}</div>
      <div class="tr-keep-cols">
        <section><h4>Keeping ${name}</h4><ul class="tr-cand-parts">
          ${part('Output after wages', r.keep.output)}
          ${part('Their traits', r.keep.traits)}
          ${part('Trainings left', r.keep.potential, r.left ? `${r.left}, above what their energy earns elsewhere` : 'none left')}
          ${part('Coworkers\' traits', -r.leaving.value, r.leaving.notes.length ? `lost if they go: ${r.leaving.notes.join(', ')}` : '')}
          ${part('Their days in the slot', -r.held, `${plural(r.days, 'working day')} at ${rate}`)}
          <li class="tr-keep-sum"><span>Worth keeping</span><strong>${signedPP(r.surplus)} PP</strong></li></ul></section>
        <section><h4>Replacing ${name}</h4><ul class="tr-cand-parts">
          <li><span>A new hire <em>the best of ${r.slots} fresh candidates, on average</em></span><strong>${signedPP(r.fresh.gross)}</strong></li>
          ${part('Their days in the slot', r.fresh.best - r.fresh.gross, `${Math.round(r.fresh.days)} working days at ${rate}`)}
          ${part('The hire\'s 10 energy', -r.alt, 'what it earns elsewhere')}
          <li class="tr-keep-sum"><span>Worth replacing</span><strong>${signedPP(net)} PP</strong></li></ul></section>
      </div>
      <p class="tr-keep-odds">A new hire must be worth over <strong>${signedPP(r.bar)} PP</strong> after their days in the slot; ${odds(r.chance)} of fresh sets hold one.${notes.length ? ` ${notes.join(' ')}` : ''}</p>
      ${move}
      ${steps}
      ${prefs}
      <p class="tr-calc-sub">${team_}</p>
      `;
  }

  function renderRecruitResult() {
    const $verdict = document.getElementById('tr-recruit-verdict');
    if (!$verdict) return;
    if (!market?.ppValue) { $verdict.innerHTML = '<div class="tr-verdict muted">Loading prices…</div>'; return; }
    const entry = recruitEntry();
    const alt = energyValue();
    const priced = recruit.cands.map(c => priceCandidate(c, entry, alt.value));
    const part = (label, x, note = '') => Math.abs(x) < 0.5 && !note ? '' : `<li><span>${label}${note ? ` <em>${escapeHtml(note)}</em>` : ''}</span><strong>${signedPP(x)}</strong></li>`;
    priced.forEach((v, i) => {
      const $card = document.getElementById(`tr-cand-${i}`);
      const $res = document.getElementById(`tr-cand-res-${i}`);
      $card.classList.remove('best');
      if (!v) { $res.innerHTML = '<small class="tr-muted">Enter age, wage, nationality and stats to price.</small>'; return; }
      const c = recruit.cands[i];
      const wageText = `wage expectation ${Math.round(v.wageExpectation * 100)}%${v.odds.greedy > 0.995 ? ', so Greedy' : v.odds.modest > 0.995 ? ', so Modest'
        : v.odds.greedy < 0.005 ? ', so not Greedy' : ''}`;
      const money = moneyOf(v.total);
      const sure = v.beat(alt.value);
      $res.innerHTML = `
        <div class="tr-cand-total"><strong class="${v.total < 0 ? 'tr-neg' : ''}">${signedPP(v.total)} PP</strong>${money ? ` <span class="tr-muted">≈ ${money}</span>` : ''}
          <small class="${sure < 0.6 ? 'tr-warn' : 'tr-muted'}">${sure >= 0.95 ? 'worth hiring whatever the card hides' : `worth the energy ${odds(sure)} of the time`}</small></div>
        <details class="tr-cand-why"><summary>Breakdown</summary><ul class="tr-cand-parts">
          ${part('Output after wages', v.output)}
          ${part('Trait', v.trait, 'average roll')}
          ${part('Trainings', v.potential, 'potential 3 to 10')}
          ${part('Coworkers\' traits', v.coworkers.value, v.coworkers.notes.join(', '))}
        </ul>
        <small class="tr-muted">${escapeHtml(wageText[0].toUpperCase() + wageText.slice(1))} · happiness ${Math.round(v.happiness)} · works ${PLACE_TEXT[v.place] || 'here'} · ${Math.max(0, EC.CFG.retireAge - numOrNull(c.age))} working days</small></details>`;
    });

    const ready = priced.map((v, i) => v && { v, i }).filter(Boolean);
    if (!ready.length) { $verdict.innerHTML = '<div class="tr-verdict muted">Enter each candidate\'s age, wage, nationality and stats to compare them.</div>'; return; }
    // Candidates compare by surplus: their value less the slot's rate for
    // each working day they'd hold it, as a fresh set's pick does.
    const fresh = freshSet(entry, alt.value);
    const daysOf = i => Math.max(0, EC.CFG.retireAge - numOrNull(recruit.cands[i].age));
    for (const x of ready) x.s = x.v.total - fresh.rate * daysOf(x.i);
    const best = ready.reduce((a, x) => x.s > a.s ? x : a);
    if (best.v.total >= alt.value) document.getElementById(`tr-cand-${best.i}`).classList.add('best');
    const rerollCost = 2 ** recruit.rerolls * alt.value;
    const energy = 10 * 2 ** recruit.rerolls;
    const name = `Candidate ${LETTERS[best.i]}`;
    const rate = `${fresh.rate.toFixed(1)} PP a day`;
    // Waiting a day leaves the slot empty for a day.
    const rerollNet = fresh.best - rerollCost, waitNet = fresh.best - fresh.rate;
    let take, why;
    if (best.v.total < alt.value) {
      take = 'Hire nobody';
      why = `The best, ${name}, is worth ${signedPP(best.v.total)} PP, less than the 10 energy it costs earns elsewhere (${signedPP(alt.value)} PP, ${escapeHtml(alt.from)}).`;
    } else if (rerollNet >= waitNet && rerollNet > best.s) {
      take = `Reroll (${energy} energy)`;
      why = `After the slot's ${rate} for each working day, a fresh set's pick averages ${signedPP(fresh.best)} PP, against ${signedPP(best.s)} for ${name}; the reroll's energy is worth ${signedPP(rerollCost)} PP elsewhere.`;
    } else if (waitNet > best.s) {
      take = 'Wait for tomorrow\'s free set';
      why = `After the slot's ${rate} for each working day, a fresh set's pick averages ${signedPP(fresh.best)} PP, more than ${name}'s ${signedPP(best.s)}. Waiting costs a day of the empty slot (${signedPP(fresh.rate)} PP), less than the reroll's ${energy} energy (${signedPP(rerollCost)} PP elsewhere).`;
    } else {
      const second = ready.filter(x => x !== best).reduce((a, x) => !a || x.s > a.s ? x : a, null);
      take = `Hire ${name}`;
      why = `${signedPP(best.v.total)} PP over ${plural(daysOf(best.i), 'working day')}, ${signedPP(best.s)} after the slot's ${rate}${second ? `, ${signedPP(best.s - second.s)} PP ahead of Candidate ${LETTERS[second.i]}` : ''}. A fresh set's pick averages ${signedPP(fresh.best)} PP on the same scale, not worth a reroll at ${energy} energy.`;
    }
    const gender = hirePrefs(entry).find(x => x.want === 'a woman' || x.want === 'a man');
    const missing = gender && !ready.some(x => recruit.cands[x.i].gender === (gender.want === 'a woman' ? 'female' : 'male'));
    if (missing) why += ` None of these candidates is ${gender.want}, worth ${escapeHtml(gender.why.replace(/^\+/, ''))}. A fresh set's average already counts this.`;
    $verdict.innerHTML = `<div class="tr-verdict${best.v.total < alt.value ? ' muted' : ''}"><span class="tr-verdict-take">${take}</span><small>${why}</small></div>`;
  }

  /* ── Employees: every employee in one table ──────────────── */
  const EMP_VIEW_STORE = 'tr-employees-view';
  const EMP_SORTS = {
    company: ['By company', () => 0, 1],
    name: ['Name', r => r.emp.name.toLowerCase(), 1],
    profit: ['Profit', r => r.profit, -1],
    next: ['Next training value', r => r.next?.value, -1],
    left: ['Trainings left', r => r.left, -1],
    production: ['Production', r => r.prod, -1],
    responsibility: ['Responsibility', r => r.emp.breakdown?.responsibility?.total ?? r.emp.base?.responsibility ?? 0, -1],
    luck: ['Luck', r => r.emp.breakdown?.luck?.total ?? r.emp.base?.luck ?? 0, -1],
    traits: ['Number of traits', r => (r.emp.traits || []).length, -1],
    age: ['Age, youngest first', r => r.emp.age, 1],
    happiness: ['Happiness, lowest first', r => r.happy, 1],
  };
  // dir 0 uses the sort's first direction; a second click on its column flips it.
  // Unknown values stay last either way.
  const empSorter = (key, flip) => {
    const [, value, first] = EMP_SORTS[key], dir = flip ? -first : first;
    return (a, b) => {
      const x = value(a), y = value(b);
      if (x == null || y == null) return (x == null) - (y == null);
      return dir * (typeof x === 'string' ? x.localeCompare(y) : x - y);
    };
  };
  let empView = { company: '', trait: '', sort: 'company', flip: false };
  try { empView = { ...empView, ...JSON.parse(localStorage.getItem(EMP_VIEW_STORE) || '{}') }; } catch { /* storage blocked */ }
  const saveEmpView = () => { try { localStorage.setItem(EMP_VIEW_STORE, JSON.stringify(empView)); } catch { /* private mode */ } };

  const sentence = code => { const w = words(code); return w[0] + w.slice(1).toLowerCase(); };
  // A happiness contribution's cause, as the game's breakdown names it.
  function happinessCause(c) {
    if (c.revealed === false) return 'Hidden trait';
    if (c.reason === 'trait' && c.code) return traitName(c.code);
    return { responsibility: 'Responsibility', incomeTax: 'Income tax', managerCare: 'Manager care', recentlyMoved: 'Recently moved', event: 'Employee event' }[c.reason]
      || sentence(c.reason || 'other');
  }

  // Happiness from the employee record: the value, what moves it, and
  // what it does to output (1% a point away from 50). Below 30 they may quit.
  function happinessCell(emp) {
    const hb = emp.happinessBreakdown;
    if (!hb || typeof hb.value !== 'number') return '<span class="tr-muted">—</span>';
    const out = Math.round(hb.value - 50);
    const parts = (hb.contributions || []).map(c => `<li><span>${escapeHtml(happinessCause(c))}${c.until ? ` <em>until ${escapeHtml(utcDay(c.until))}</em>` : ''}</span><strong class="${c.delta < 0 ? 'tr-neg' : 'tr-pos'}">${c.delta > 0 ? '+' : '−'}${fmtNum(Math.abs(c.delta))}</strong></li>`);
    // Loyal halves losses; the game reports what it saved as `mitigated`.
    if (hb.mitigated > 0) parts.push(`<li><span>Loyal <em>half of losses</em></span><strong class="tr-pos">+${fmtNum(hb.mitigated)}</strong></li>`);
    return `<div class="tr-happy${hb.value < 30 ? ' low' : ''}"><strong>${fmtNum(hb.value)}</strong> <span class="tr-muted">${out >= 0 ? '+' : '−'}${Math.abs(out)}% output</span>
      ${hb.value < 30 ? '<span class="tr-warn">Below 30: may quit</span>' : ''}
      ${parts.length ? `<ul class="tr-happy-parts">${parts.join('')}</ul>` : ''}</div>`;
  }
  const fmtNum = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
  const utcDay = iso => { const d = new Date(iso); return `${d.toISOString().slice(5, 10).replace('-', '/')} ${utcTime(d)}`; };

  // Each trait with its effect written out, not only in a tooltip.
  function traitList(emp) {
    const list = (emp.traits || []).map(t => t.revealed === false
      ? '<li class="tr-pol-hidden"><strong>Hidden trait</strong><span>Training reveals it.</span></li>'
      : `<li class="tr-pol-${EC.TRAIT[t.code]?.polarity || 'mixed'}"><strong>${escapeHtml(traitName(t.code) + argText(t))}</strong><span>${escapeHtml(traitDescription(t.code))}</span></li>`);
    return list.length ? `<ul class="tr-trait-list">${list.join('')}</ul>` : '<span class="tr-muted">None</span>';
  }

  function renderEmployees() {
    if (!team) return;
    const verdicts = new Map(keepRows().map(r => [r.emp._id, keepVerdict(r)]));
    const topTrain = new Set(feedRows().filter(r => r.kind === 'train' && r.ready).slice(0, 5).map(r => r.emp._id));
    const nextOf = new Map(feedRows().filter(r => r.kind === 'train').map(r => [r.emp._id, r]));
    const rows = team.companies.flatMap(entry => entry.employees.map(emp => {
      const p = productFor(entry.company.itemCode);
      return {
        emp, entry, next: nextOf.get(emp._id),
        profit: p && emp.estimate ? emp.estimate.production * p.perPP - emp.wage : null,
        left: Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0)),
        prod: emp.breakdown?.production?.total ?? emp.base?.production ?? 0,
        happy: emp.happinessBreakdown?.value ?? null,
      };
    }));
    const codes = [...new Set(rows.flatMap(r => (r.emp.traits || []).map(t => t.revealed === false ? 'hidden' : t.code)))]
      .sort((a, b) => (a === 'hidden' ? '~' : traitName(a)).localeCompare(b === 'hidden' ? '~' : traitName(b)));
    if (empView.company && !team.companies.some(x => x.company._id === empView.company)) empView.company = '';
    if (empView.trait && !codes.includes(empView.trait)) empView.trait = '';
    if (!EMP_SORTS[empView.sort]) empView.sort = 'company';
    const has = (emp, code) => (emp.traits || []).some(t => code === 'hidden' ? t.revealed === false : t.code === code && t.revealed !== false);
    const shown = rows.filter(r => (!empView.company || r.entry.company._id === empView.company) && (!empView.trait || has(r.emp, empView.trait)))
      .sort(empSorter(empView.sort, empView.flip));
    const colour = new Map(team.companies.map((x, i) => [x, `var(--tr-co-${i % 8 + 1})`]));
    const select = (key, label, options) => `<label class="tr-field"><span>${label}</span><select data-emp-view="${key}">${options.map(([v, t]) =>
      `<option value="${escapeHtml(v)}"${v === empView[key] ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></label>`;
    const stat = (emp, k) => {
      const base = emp.base?.[k] ?? 0, total = emp.breakdown?.[k]?.total ?? base, diff = total - base;
      return `${base}${diff ? `<span class="${diff < 0 ? 'tr-neg' : 'tr-pos'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</span>` : ''}`;
    };
    const body = shown.map(({ emp, entry, next, profit, left }) => {
      const toRetire = EC.CFG.retireAge - emp.age;
      const status = pendingHand(emp) ? 'hand waiting' : doneToday(emp) ? 'trained today' : '';
      return `<tr style="--co:${colour.get(entry)}">
        <td data-label="Employee"><strong>${gameLink(entry.company, emp.name)}</strong><small>${companyLabelHtml(entry.company)}</small>
          <span class="tr-badges">${flagsOf(emp, entry, verdicts, topTrain)}</span></td>
        <td data-label="Age" class="num">${emp.age}<small>${toRetire > 0 ? `${plural(toRetire, 'day')} left` : 'retiring'}</small></td>
        <td data-label="Prod" class="num">${stat(emp, 'production')}</td>
        <td data-label="Resp" class="num">${stat(emp, 'responsibility')}</td>
        <td data-label="Luck" class="num">${stat(emp, 'luck')}</td>
        <td data-label="Trainings"><span class="tr-emp-pips" title="${emp.potential || 0} used of ${emp.potentialMax || 0}">${Array.from({ length: emp.potentialMax || 0 }, (_, k) => `<i${k < (emp.potential || 0) ? ' class="used"' : ''}></i>`).join('')}</span>
          <small>${emp.potential || 0} used, ${left} left${status ? ` · ${status}` : ''}</small></td>
        <td data-label="Next training" class="num">${next ? `≈ ${signedPP(next.value)} PP` : '<span class="tr-muted">—</span>'}</td>
        <td data-label="Traits" class="tr-emps-traits">${traitList(emp)}</td>
        <td data-label="Happiness" class="tr-emps-happy">${happinessCell(emp)}</td>
        <td data-label="Profit" class="num${profit != null && profit < 0 ? ' tr-neg' : ''}">${moneyFmt(profit)}/h</td>
        <td data-label="Open" class="tr-emps-open">${[['train', 'Train'], ['keep', 'Keep or replace']].map(([tab, text]) =>
          `<button type="button" class="tr-use" data-go-tab="${tab}" data-go-emp="${emp._id}" aria-label="${escapeHtml(`${text}: ${emp.name}`)}">${text}</button>`).join('')}</td>
      </tr>`;
    }).join('');
    $roster.innerHTML = `<div class="tr-emps-filters">
        ${select('company', 'Company', [['', `All ${team.companies.length} companies`], ...team.companies.map(x => [x.company._id, companyLabel(x.company)])])}
        ${select('trait', 'Trait', [['', 'Any trait'], ...codes.map(c => [c, c === 'hidden' ? 'Hidden trait' : traitName(c)])])}
        ${select('sort', 'Sort', Object.entries(EMP_SORTS).map(([k, [t]]) => [k, t]))}
        <span class="tr-muted" role="status">${plural(shown.length, 'employee')} shown</span>
      </div>
      <div class="tr-emps-wrap"><table class="tr-emps">
        <thead><tr>${[['name', 'Employee'], ['age', 'Age', 1], ['production', 'Prod', 1], ['responsibility', 'Resp', 1], ['luck', 'Luck', 1], ['left', 'Trainings'],
          ['next', 'Next training', 1], ['traits', 'Traits'], ['happiness', 'Happiness'], ['profit', 'Profit', 1]].map(([key, label, num]) => {
            const on = empView.sort === key, dir = EMP_SORTS[key][2] * (empView.flip ? -1 : 1);
            return `<th scope="col"${num ? ' class="num"' : ''} aria-sort="${on ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="tr-emps-sort" data-emp-sort="${key}">${label}${on ? `<span aria-hidden="true">${dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`;
          }).join('')}<th scope="col"><span class="tr-muted">Open</span></th></tr></thead>
        <tbody>${body || '<tr><td colspan="11" class="tr-muted">No employees match.</td></tr>'}</tbody></table></div>`;
  }

  const moneyFmt = v => v == null ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(3);

  // Overview: the team's totals, Next actions and the roster; then the
  // Employees tab.
  function renderTeam() {
    if (!team) return;
    const all = team.companies.flatMap(x => x.employees);
    let prod = 0, wage = 0, mgr = 0, boxes = 0, profit = 0, priced = true;
    for (const { company, estimate } of team.companies) {
      if (!estimate) continue;
      prod += estimate.production || 0; wage += estimate.wageCost || 0; mgr += estimate.managerCost || 0; boxes += estimate.toolboxes || 0;
      const p = productFor(company.itemCode);
      if (p) profit += (estimate.production || 0) * p.perPP - (estimate.wageCost || 0) - (estimate.managerCost || 0);
      else if (estimate.production) priced = false;
    }
    const tile = (label, value, sub = '', id = '', tone = '') => `<div class="tr-tile"${id ? ` id="${id}"` : ''}><span>${label}</span><strong${tone ? ` class="${tone}"` : ''}>${value}</strong>${sub ? `<em>${sub}</em>` : ''}</div>`;
    // Money a day in the game's currency, signed and coloured: green coming in, red going out.
    const perDay = v => `${v < 0 ? '−' : '+'}₿${Math.abs(v).toFixed(3)}/day`;
    const tone = v => v < 0 ? 'tr-neg' : 'tr-pos';
    // The planner's steps, as in Next actions; blank while it searches.
    tabCount('assignments', plan?.gain > 1e-7 ? plan.changes : 0);
    const energy = energyNow(), bar = team.energyBar;
    const total = team.totalProfit;
    const totalAvailable = total && !total.statsMissing && !total.unpriced;
    const totalNote = !total ? 'could not load total profit'
      : total.statsMissing ? 'work history unavailable; requires a Premium API key'
      : total.unpriced ? 'some products unpriced'
      : !total.projectedSelfWork ? 'self-work estimate unavailable'
      : `${perDay(total.total - total.self + total.projectedSelfWork.profit)} with ${total.projectedSelfWork.energy} energy spent on self-work in ${escapeHtml(total.projectedSelfWork.company.name || productName(total.projectedSelfWork.company.itemCode))}`;
    $team.innerHTML = `
      <div class="tr-section-heading"><h3 class="tr-pane-title">Summary</h3>${help('How summary totals are calculated', `<p><strong>Employee profit</strong> uses current employee estimates at today's prices, after wages and manager pay. It excludes engines and self-work.</p><p><strong>Total profit</strong> combines current engine output with employee output from the last full UTC day. It uses today's prices and subtracts wages and manager pay. It excludes self-work.</p><p>The estimate below Total profit adds self-work using one full energy bar and your Production stat. It uses today's prices at your company with the highest margin per production point. It assumes space in production storage and does not include energy regenerated while working.</p>`)}</div>
      <div class="tr-tiles">
        ${tile('Employees', all.length, `${team.companies.length} companies`)}
        ${tile('Production', `${(prod * 24).toFixed(2)} PP/day`, 'from employees')}
        ${tile('Wages', perDay(-wage * 24), mgr ? `${perDay(-mgr * 24)} managers` : '', '', 'tr-neg')}
        ${tile('Employee profit', market ? perDay(profit * 24) : '…', priced ? 'after wages and manager pay' : 'some products unpriced', '', market ? tone(profit) : '')}
        ${tile('Total profit', totalAvailable ? perDay(total.total - total.self) : 'Unavailable', totalNote, '', totalAvailable ? tone(total.total - total.self) : '')}
        ${tile('Toolboxes', `${(boxes * 24).toFixed(2)}/day`)}
        ${energy == null ? '' : tile('Energy', `${energy}${bar.max ? ` / ${bar.max}` : ''}`, escapeHtml(energyFullText()), 'tr-energy')}
      </div>
      <div class="tr-overview">
        <section class="tr-overview-acts" aria-labelledby="tr-acts-h">
          ${market ? nextActions() : '<h3 class="tr-pane-title" id="tr-acts-h">Next actions</h3><p class="tr-muted">Loading prices…</p>'}</section>
        <section class="tr-overview-roster" aria-label="Employees by company">${rosterTable()}</section>
      </div>`;
    renderEmployees();
    if (market) for (const fn of watchers) fn(snapshot());
  }

  // One load at a time: a call during a load gets that load's promise.
  let loading = Promise.resolve();
  let loadError = null;
  function runLoad(username) {
    if (!busy) loading = loadAccount(username);
    return loading;
  }

  async function loadAccount(username) {
    username = (username || '').trim();
    if (!username || busy) return;
    busy = true;
    $load.disabled = true;
    setStatus('');
    steps.reset();
    loadError = null;
    try {
      const loaded = await loadTeam(username);
      steps.setStep(5, 'active', { sub: 'Finishing prices and preparing recommendations' });
      await marketLoad;
      team = loaded;
      nextActionsExpanded = false;
      taken.clear();
      // Refresh the selected employee from the game (trainings, traits and
      // wage change between visits), or select the next one to train.
      const want = [view.emp, input.pick].find(id => findEmployee(id));
      view.emp = null;
      useEmployee(want || defaultPick());
      // A hire since the last load: the typed candidates were for the old set.
      const hiredInto = team.companies.find(x => x.company._id === recruit.company);
      if (hiredInto && hiredInto.employees.length > (recruit.seen?.[recruit.company] ?? Infinity)) {
        recruit.cands = recruit.cands.map(blankCand);
        recruit.rerolls = 0;
      }
      recruit.seen = Object.fromEntries(team.companies.map(x => [x.company._id, x.employees.length]));
      saveRecruit();
      setStatus('');
      $username.value = team.username;
      rememberUsername(team.username);
      rememberLoadedAccount(team.username);
      renderTeam();
      renderRecruitForm();
      renderFire();
      assignments?.refresh();
      assignments?.run({ auto: true });
      $hint.classList.add('hidden');
      $shell.classList.remove('hidden');
      showTab(view.tab);
      steps.setStep(5, 'done', { sub: 'Overview and recommendations ready' });
      steps.fadeOut(400);
    } catch (err) {
      console.warn('[training] load failed', err);
      loadError = err;
      steps.hide();
      setStatus(err.message || String(err), true);
    } finally {
      busy = false;
      $load.disabled = false;
    }
  }

  function findEmployee(id) {
    for (const entry of team?.companies || []) {
      const emp = entry.employees.find(x => x._id === id);
      if (emp) return { emp, entry };
    }
    return null;
  }

  // The best employee to train next, or the first one.
  const defaultPick = () => feedRows().find(r => r.kind === 'train' && r.ready)?.emp._id || allEmployees()[0]?._id || '';

  function useEmployee(id) {
    const found = findEmployee(id);
    if (!found) return;
    input = { ...inputsFor(found.emp, found.entry), pick: id, hand: pendingHand(found.emp) };
    renderResult(); renderFire(); renderTeam();
  }

  /* ── The employee tabs: side roster, header, I took this ─── */
  // Desktop: every employee down the side, by company, to switch between
  // them while staying on the tab. Phones use the picker instead.
  function renderSide() {
    const verdicts = new Map(keepRows().map(r => [r.emp._id, keepVerdict(r)]));
    const topTrain = new Set(feedRows().filter(r => r.kind === 'train' && r.ready).slice(0, 5).map(r => r.emp._id));
    $side.innerHTML = team.companies.map((entry, i) => {
      const { company, employees } = entry;
      if (!employees.length) return '';
      const co = `--co:var(--tr-co-${i % 8 + 1})`;
      return `<div class="tr-side-co" style="${co}">${companyLabelHtml(company)} <span class="tr-muted">${employees.length} of ${headcountCap(company)}</span></div>
        <ul>${employees.map(emp => {
          const left = Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0));
          const on = emp._id === input.pick;
          return `<li><button type="button" class="tr-side-emp" data-side-emp="${emp._id}"${on ? ' aria-current="true"' : ''} style="${co}">
            <span class="tr-side-name">${escapeHtml(emp.name)}<small>Age ${emp.age} · Prod ${paidProd(emp)} · ${plural(left, 'training')} left</small></span>
            <span class="tr-badges">${flagsOf(emp, entry, verdicts, topTrain)}</span></button></li>`;
        }).join('')}</ul>`;
    }).join('');
    const $on = $side.querySelector('[aria-current]');
    if ($on && ($on.offsetTop < $side.scrollTop || $on.offsetTop + $on.offsetHeight > $side.scrollTop + $side.clientHeight)) {
      $side.scrollTop = $on.offsetTop - $side.clientHeight / 3;
    }
  }

  // The selected employee at a glance, over Train and Keep or replace.
  function renderEmpHead() {
    const found = findEmployee(input.pick);
    if (!found) { $empHead.innerHTML = ''; return; }
    const { emp, entry } = found;
    const p = productFor(entry.company.itemCode);
    const profit = p && emp.estimate ? emp.estimate.production * p.perPP - emp.wage : null;
    const left = Math.max(0, (emp.potentialMax || 0) - (emp.potential || 0));
    const stat = k => {
      const base = emp.base?.[k] ?? 0, total = emp.breakdown?.[k]?.total ?? base, diff = total - base;
      return `${STAT_SHORT[k]} <b>${base}</b>${diff ? `<span class="${diff < 0 ? 'tr-neg' : 'tr-pos'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</span>` : ''}`;
    };
    const hb = emp.happinessBreakdown;
    const hand = pendingHand(emp);
    const status = hand ? `<p class="tr-emp-status"><span class="tr-badge tr-badge-hand">Hand</span> ${RARITY_NAME[hand.rarity]} hand waiting${hand.drawnAt ? `, dealt ${utcTime(new Date(hand.drawnAt))}` : ''}.${view.tab === 'train' ? '' : ` <button type="button" class="tr-link" data-go-tab="train" data-go-emp="${emp._id}">Rank it</button>`}</p>`
        : doneToday(emp) ? `<p class="tr-emp-status">Trained today. Next training at 00:00 UTC, in ${escapeHtml(formatDuration(untilReset()))}.</p>` : '';
    $empHead.innerHTML = `<div class="tr-emp-name"><strong>${gameLink(entry.company, emp.name)}</strong> <span class="tr-muted">${companyLabelHtml(entry.company)}${p ? ` (${p.ratio.toFixed(2)}×)` : ''}</span></div>
      <div class="tr-emp-facts"><span>Age <b>${emp.age}</b> · ${plural(Math.max(0, EC.CFG.retireAge - emp.age), 'working day')}</span>
        <span>${stat('production')} · ${stat('responsibility')} · ${stat('luck')}</span>
        <span><b>${left}</b> of ${emp.potentialMax || 0} trainings left</span>
        ${hb && typeof hb.value === 'number' ? `<span class="${hb.value < 30 ? 'tr-warn' : ''}">Happiness <b>${fmtNum(hb.value)}</b></span>` : ''}
        <span>Profit <b class="${profit != null && profit < 0 ? 'tr-neg' : ''}">${moneyFmt(profit)}/h</b></span></div>
      ${status}`;
  }

  // "I took this": the card picked in the game, applied to the employee's
  // record until the next reload, so every tab and Next actions follow.
  function takeSlot(slot) {
    const found = findEmployee(input.pick);
    if (!found || !input.hand) return;
    const c = slotCard(input.hand.slots[slot]);
    if (!c) return;
    const { emp, rolled } = EC.takeCard(found.emp, c, { wageExpectation: 1 + input.wagePct / 100 });
    taken.set(emp._id, { text: c.card === 'wildCard' ? 'Wild card' : `${cardTitle(c)}: ${effectText(c)}`, rolled });
    team = { ...team, companies: team.companies.map(entry => entry !== found.entry ? entry
      : { ...entry, employees: entry.employees.map(x => x === found.emp ? emp : x) }) };
    input = { ...inputsFor(emp, findEmployee(emp._id).entry), pick: emp._id, hand: null };
    renderResult();
    renderEmpHead();
    $calc.querySelector('.tr-emp-took')?.focus({ preventScroll: true });
    // Let the confirmation paint before recalculating recommendations.
    requestAnimationFrame(() => setTimeout(() => {
      renderFire();
      renderTeam();
      renderRecruitForm();
      renderPicker();
      assignments?.refresh();
      assignments?.run({ auto: true });
    }, 0));
  }

  /* ── Tabs and the selected employee ──────────────────────── */
  // The tab and employee are written to the hash with replaceState, so a
  // link reopens the same view; the router hands them back to activate().
  function writeState() {
    if (!team || location.hash.replace(/^#/, '').split('?')[0] !== 'training') return;
    const params = new URLSearchParams({ u: team.username });
    if (view.tab !== 'overview') params.set('tab', view.tab);
    if (input.pick) params.set('emp', input.pick);
    writeHash('training', params);
  }

  function showTab(tab, { focus = false, reveal = false } = {}) {
    view.tab = TABS.includes(tab) ? tab : 'overview';
    for (const b of $tabs.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === view.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of $shell.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== view.tab;
    renderPicker();
    writeState();
    // Opened from further down the page: bring the tabs back into view.
    if (reveal && $tabs.getBoundingClientRect().top < 0) $tabs.scrollIntoView({ block: 'start' });
  }

  // A count on a tab: Assignments flags work waiting.
  function tabCount(tab, n) {
    const $n = $tabs.querySelector(`[data-tab="${tab}"] [data-count]`);
    if ($n) $n.textContent = n > 0 ? String(n) : '';
  }

  // Point at the planner's step for an employee on the Assignments tab.
  function focusPlanStep(id) {
    for (const x of document.querySelectorAll('.tr-asg-step.is-focus')) x.classList.remove('is-focus');
    const step = [...document.querySelectorAll('.tr-asg-step[data-emps]')].find(x => x.dataset.emps.split(' ').includes(id));
    if (!step) return;
    step.classList.add('is-focus');
    step.scrollIntoView({ block: 'center' });
  }

  // Select an employee, from the picker or a button elsewhere on the page.
  function selectEmployee(id, tab = view.tab) {
    if (!findEmployee(id)) return;
    if (id !== input.pick) useEmployee(id);
    showTab(tab, { reveal: true });
  }

  /* ── Wiring ──────────────────────────────────────────────── */
  /* ── Dashboard summary ───────────────────────────────────── */
  // The loaded account in brief, for the dashboard's card: today's
  // training progress, what's waiting, and the top three Spend energy
  // actions with their profit a day (money, or PP for a hire).
  function snapshot() {
    const all = team.companies.flatMap(entry => entry.employees.map(emp => ({ emp, entry })));
    const hand = all.filter(x => pendingHand(x.emp));
    const trainable = all.filter(x => pendingHand(x.emp) || doneToday(x.emp) || (x.emp.potentialMax || 0) - (x.emp.potential || 0) > 0);
    const energy = energyNow();
    const { moved, ready } = energyActions();
    const self = selfWorkValue();
    const pp = market?.ppValue > 0 ? market.ppValue : null;
    const perDay = r => {
      if (!pp || !Number.isFinite(r.value)) return null;
      const days = r.kind === 'train' ? EC.workingDays(r.emp) : r.kind === 'replace' ? r.keep.fresh.days : null;
      return days > 0 ? r.value * pp / days : null;
    };
    const detail = r => r.kind === 'train' ? `${plural(r.left, 'training')} left`
      : r.kind === 'replace' ? (keepVerdict(r.keep) === 'fire' ? 'costs more than they earn' : `a new hire wins ${odds(r.keep.chance)} of the time`)
      : `${r.entry.employees.length} of ${r.cap} slots used`;
    return {
      username: team.username,
      employees: all.length,
      companies: team.companies.length,
      energy,
      energyMax: team.energyBar?.max ?? null,
      energyFull: energyFullText(),
      actions: energy == null ? null : Math.floor(energy / 10),
      tenIn: energy != null && energy < 10 && minutesTo10(energy) != null ? minutesTo10(energy) * 6e4 : null,
      trainable: trainable.length,
      trained: trainable.filter(x => doneToday(x.emp) && !pendingHand(x.emp)).length,
      hands: hand.length,
      untilReset: untilReset(),
      // Marked Replace, less those the planner moves instead (moves).
      replace: keepRows().filter(r => ['fire', 'replace'].includes(keepVerdict(r)) && !moved.has(r.emp._id)).length,
      moves: moved.size,
      mismatches: all.filter(x => mismatchOf(x.emp, x.entry.company)).length,
      pricing: ready.some(r => r.pricing),
      top: ready.slice(0, 3).map(r => ({
        kind: r.kind, emp: r.emp?._id || null, name: r.emp?.name || null,
        companyId: r.entry.company._id, company: companyName(r.entry.company), itemCode: r.entry.company.itemCode,
        detail: detail(r), perDay: perDay(r), pp: r.value, belowSelf: !!self && r.value < self.value,
      })),
    };
  }

  // Loads the account through this page, so opening it afterwards shows
  // it at once, then resolves to its snapshot().
  async function summary(username) {
    if (!mounted) mount();
    const want = (username || '').trim().toLowerCase();
    // A load already running may be for another account; one more runs ours.
    for (let i = 0; i < 2 && team?.username?.toLowerCase() !== want; i++) await runLoad(username);
    if (team?.username?.toLowerCase() !== want) throw loadError || new Error(`Couldn't load employees for ${username}`);
    await marketLoad;
    return snapshot();
  }

  function mount() {
    wireHelp();
    renderRecent();
    assignments = EmployeeAssignments.mount(document.getElementById('tr-assignments-body'), {
      getTeam: () => team, getMarket: () => market, productName, productIcon,
      companyName: id => { const x = team?.companies.find(c => c.company._id === id); return x ? companyName(x.company) : null; },
      onResult: result => { plan = result; renderResult(); renderTeam(); renderFire(); },
      onSettings: () => { renderResult(); renderTeam(); },
    });
    $load.addEventListener('click', () => runLoad($username.value));
    $username.addEventListener('keydown', ev => { if (ev.key === 'Enter') runLoad($username.value); });
    $recent.addEventListener('click', ev => {
      const del = ev.target.closest('[data-tr-recent-del]');
      if (del) {
        writeRecent(readRecent().filter(x => x.toLowerCase() !== del.dataset.trRecentDel.toLowerCase()));
        renderRecent();
        return;
      }
      const pick = ev.target.closest('[data-tr-recent]');
      if (pick && !busy) { $username.value = pick.dataset.trRecent; runLoad(pick.dataset.trRecent); }
    });
    // Buttons anywhere in the tabs: Train opens an employee's Train tab,
    // a side roster row switches employee, and I took this applies a card.
    $shell.addEventListener('click', ev => {
      // A roster row opens that employee, wherever in the row it's clicked.
      const row = !ev.target.closest('a, button') && ev.target.closest('tr[data-emp]');
      if (row) { selectEmployee(row.dataset.emp, 'train'); return; }
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.empSort) {
        const key = b.dataset.empSort;
        empView.flip = empView.sort === key && !empView.flip; empView.sort = key;
        saveEmpView(); renderEmployees();
        document.querySelector(`[data-emp-sort="${key}"]`)?.focus();
        return;
      }
      if (b.dataset.nextActionsToggle !== undefined) {
        nextActionsExpanded = !nextActionsExpanded;
        renderTeam();
        $team.querySelector('[data-next-actions-toggle]')?.focus({ preventScroll: true });
      }
      else if (b.dataset.goTab) {
        if (b.dataset.goCompany) { recruit.company = b.dataset.goCompany; saveRecruit(); renderRecruitForm(); }
        if (b.dataset.goEmp) selectEmployee(b.dataset.goEmp, b.dataset.goTab);
        else showTab(b.dataset.goTab, { reveal: true });
        if (b.dataset.goTab === 'assignments' && b.dataset.goEmp) focusPlanStep(b.dataset.goEmp);
        if (b.dataset.goTools !== undefined) document.querySelector('#tr-assignments-body [data-tool-add]')?.focus();
      }
      else if (b.dataset.addTool) { showTab('assignments', { reveal: true }); assignments.addTool(b.dataset.addTool); }
      else if (b.dataset.planOpen !== undefined) { showTab('assignments', { reveal: true }); assignments.reveal(); }
      else if (b.dataset.sideEmp) selectEmployee(b.dataset.sideEmp);
      else if (b.dataset.took !== undefined) takeSlot(+b.dataset.took);
      else if (b.dataset.reload !== undefined && team) runLoad(team.username);
      else if (b.classList.contains('tr-use') && b.dataset.id) selectEmployee(b.dataset.id, 'train');
      else if (b.dataset.step) {
        const list = allEmployees();
        const at = list.findIndex(x => x._id === input.pick);
        selectEmployee(list[(at + +b.dataset.step + list.length) % list.length]._id);
      }
    });
    $roster.addEventListener('change', ev => {
      const k = ev.target.dataset.empView; if (!k) return;
      empView[k] = ev.target.value; if (k === 'sort') empView.flip = false;
      saveEmpView(); renderEmployees();
      document.querySelector(`[data-emp-view="${k}"]`)?.focus();
    });
    $pick.addEventListener('change', ev => { if (ev.target.dataset.pick !== undefined) selectEmployee(ev.target.value); });
    $tabs.addEventListener('click', ev => { const b = ev.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
    // Arrow keys move between tabs, as in any tab list.
    $tabs.addEventListener('keydown', ev => {
      const at = TABS.indexOf(ev.target.closest('[data-tab]')?.dataset.tab ?? view.tab);
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      showTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
    });
    renderFire();

    if ($recruit) {
      renderRecruitForm();
      $recruit.addEventListener('input', ev => {
        const t = ev.target;
        if (t.dataset.c !== undefined) {
          const entry = recruitEntry();
          if (entry) recruit.company = entry.company._id;
        }
        if (t.dataset.r === 'unit' && t.value !== recruit.unit) {
          const f = t.value === 'day' ? 24 : 1 / 24;
          for (const c of recruit.cands) if (numOrNull(c.wage) != null) c.wage = String(Math.round(+c.wage * f * 1e6) / 1e6);
        }
        if (t.dataset.r === 'company' || t.dataset.r === 'unit') { recruit[t.dataset.r] = t.value; saveRecruit(); renderRecruitForm(); document.querySelector(`[data-r="${t.dataset.r}"]`)?.focus(); return; }
        else if (t.dataset.r === 'rerolls') recruit.rerolls = Math.max(0, Math.min(10, parseInt(t.value, 10) || 0));
        else if (t.dataset.k) recruit.cands[+t.dataset.c][t.dataset.k] = t.value;
        else return;
        saveRecruit(); renderRecruitResult();
      });
      $recruit.addEventListener('click', ev => {
        const t = ev.target.closest('button'); if (!t) return;
        if (t.dataset.rAdd !== undefined && recruit.cands.length < MAX_SLOTS) recruit.cands.push(blankCand());
        else if (t.dataset.rDrop !== undefined) recruit.cands.splice(+t.dataset.rDrop, 1);
        else if (t.dataset.rRerolled !== undefined) { recruit.rerolls++; recruit.cands = recruit.cands.map(blankCand); }
        else if (t.dataset.rClear !== undefined) recruit.cands = recruit.cands.map(blankCand);
        else return;
        saveRecruit(); renderRecruitForm();
      });
      trpc('country.getAllCountries', {}, { retry: true })
        .then(list => { countries = (list || []).map(c => ({ _id: c._id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)); })
        .catch(err => { console.warn('[training] countries failed', err); countries = []; })
        .finally(renderRecruitForm);
    }

    marketLoad = loadMarket()
      .then(m => { market = m; })
      .catch(err => { console.warn('[training] product prices failed', err); market = { ppValue: null, list: [], types: {} }; })
      .finally(() => { renderResult(); renderTeam(); renderRecruitForm(); renderFire(); renderPicker(); assignments.refresh(); assignments.run({ auto: true }); });
    setInterval(updateEnergyTile, 1000);
    mounted = true;
  }

  return {
    summary,
    // fn(snapshot) on every Overview redraw (prices, planner); returns an unsubscribe.
    watch(fn) { watchers.add(fn); return () => watchers.delete(fn); },
    activate(params) {
      if (!mounted) mount();
      const u = params?.get('u') || '';
      view.tab = TABS.includes(params?.get('tab')) ? params.get('tab') : 'overview';
      const emp = params?.get('emp') || null;
      // Load the account from the link, or the last one loaded on this site.
      const who = u || readLoadedAccount();
      if (!$username.value) $username.value = who;
      if (who && who.toLowerCase() !== team?.username?.toLowerCase()) { view.emp = emp; runLoad(who); return; }
      if (!team) return;
      if (emp && emp !== input.pick && findEmployee(emp)) useEmployee(emp);
      showTab(view.tab);
    },
  };
})();
