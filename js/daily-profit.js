/* ═══════════════════════════════════════════════════════════════════
 *  DAILY PROFIT  (powers the #profit view inside the shell)
 *  Extracted from the standalone daily-profit.html on merge. Self-
 *  contained IIFE; the shell drives it via DailyProfitTool.activate({u}).
 *
 *  The product table is sortable: click any header. It defaults to Total
 *  max descending. Net/PP is no longer a column (Sale and Raw cost feed
 *  it, and Max/Actual already embed it) but is still computed, and the
 *  footer note reports price coverage and missing prices.
 * ═══════════════════════════════════════════════════════════════════ */
const DailyProfitTool = (() => {
  const { WAGE_RANK_FROM_TOP, META, ICON_FILE, resolveUsername } = ProfitCore;
  const RECENT_KEY = 'dp:recent-usernames';
  const RECENT_MAX = 8;
  const netWageRate = () => ProfitCore.netWageRate(model);

  // Production-bonus model lives in shared.js (computeProductionBonus).

  // ── DOM ─────────────────────────────────────────────────────────
  const $username = document.getElementById('dp-username');
  const $submit   = document.getElementById('dp-submit');
  const $recent   = document.getElementById('dp-recent');
  const $status   = document.getElementById('dp-status');
  const $statsCard= document.getElementById('dp-stats-card');
  const $tableCard= document.getElementById('dp-table-card');
  const $statsHead= document.getElementById('dp-stats-head');
  const $assump   = document.getElementById('dp-assump');
  const $income   = document.getElementById('dp-income');
  const $table    = document.getElementById('dp-table');
  const $tableNote= document.getElementById('dp-table-note');
  const $compCard = document.getElementById('dp-comp-card');
  const $companies= document.getElementById('dp-companies');
  const $empCard  = document.getElementById('dp-emp-card');
  const $empSub   = document.getElementById('dp-emp-sub');
  const $employees= document.getElementById('dp-employees');
  const steps     = makeSteps(document.getElementById('dp-steps'));

  // ── State ───────────────────────────────────────────────────────
  let model = null;

  // ── Helpers ─────────────────────────────────────────────────────
  const fmt2 = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt3 = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const fmtK = (v) => (v == null || !isFinite(v)) ? '–' : (Math.abs(v) >= 1000 ? (v/1000).toFixed(2) + 'K' : v.toFixed(2));
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return '?'; } };
  const fmtPP = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 1 });

  function showStatus(level, html) { $status.className = `bf-inline-status ${level}`; $status.innerHTML = html; $status.classList.remove('hidden'); }
  function hideStatus() { $status.classList.add('hidden'); $status.innerHTML = ''; }

  // ── Recent chips (mirrors the shell) ────────────────────────────
  const readRecent = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const writeRecent = (l) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(l.slice(0, RECENT_MAX))); } catch {} };
  function rememberUsername(u) { const l = readRecent().filter(x => x.toLowerCase() !== u.toLowerCase()); l.unshift(u); writeRecent(l); renderRecent(); }
  function forgetUsername(n) { writeRecent(readRecent().filter(x => x.toLowerCase() !== n.toLowerCase())); renderRecent(); }
  function renderRecent() {
    const l = readRecent();
    if (!l.length) { $recent.innerHTML = ''; $recent.classList.add('hidden'); return; }
    $recent.classList.remove('hidden');
    $recent.innerHTML = `<span class="stg-recent-label">Recent:</span>` + l.map(u => {
      const s = escapeHtml(u);
      return `<span class="stg-recent-chip"><button class="stg-recent-pick" data-dp-recent="${s}">${s}</button><button class="stg-recent-del" data-dp-recent-del="${s}" title="Remove">×</button></span>`;
    }).join('');
  }

  // ── Load + compute ──────────────────────────────────────────────
  async function handleSubmit() {
    const raw = $username.value.trim();
    if (!raw) { showStatus('warn', 'Please enter an in-game username.'); $username.focus(); return; }

    $submit.disabled = true;
    $statsCard.classList.add('hidden');
    $tableCard.classList.add('hidden');
    hideStatus();
    steps.reset();

    try {
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      let user;
      try { user = await resolveUsername(raw); }
      catch (e) {
        steps.markActiveAsError('Lookup failed');
        throw new Error(isTransientError(e) ? `The data server is having a moment (${e.message}). Try again shortly.` : `Username lookup failed: ${e.message}`);
      }
      if (!user) { steps.markActiveAsError('No user found'); throw new Error(`No War Era user found with username "${raw}".`); }
      enforceIrishOnly(user.country ?? user.countryId, user.username);
      steps.setStep(1, 'done', { count: `→ ${user.username}` });
      try { window.history.replaceState(null, '', `#profit?u=${encodeURIComponent(user.username)}`); } catch {}
      rememberUsername(user.username);

      // Steps 2–3: companies, workers, market and bonuses
      model = await ProfitCore.loadModel(user, { step: (n, state, info) => steps.setStep(n, state, info) });
      steps.fadeOut(300);
      renderAll();
      rememberLoadedAccount(user.username);
    } catch (e) {
      steps.markActiveAsError(e.message);
      showStatus('error', escapeHtml(e.message));
    } finally {
      $submit.disabled = false;
    }
  }

  // Re-assign the owner's self-work to a chosen company (picker). Self-work PP
  // = selfPPbase × (1 + that company's bonus); it lands in that company's staff
  // output, shifting which product's Actual/throughput it feeds.
  function assignSelfWork(companyId) {
    model.selfWorkCompanyId = companyId;
    let selfContribution = 0, target = null;
    model.companies.forEach(c => { c._workersManual = c._workersHired; c._selfWork = false; });
    target = model.companies.find(c => c._id === companyId);
    if (target && model.selfPPbase > 0) {
      const b = target._bonus ? target._bonus.total : 0;
      selfContribution = model.selfPPbase * (1 + b / 100);
      target._workersManual += selfContribution;
      target._selfWork = true;
    }
    model.companies.forEach(c => { c._dailyPP = c._aeBonus + c._workersManual; });
    model.selfPP = Math.round(selfContribution);
    model.selfWorkItem = target ? (META[target.itemCode]?.name || target.itemCode) : null;
    // Self-work is part of staff; moving it changes the staff baseline → reset
    // the what-if staff field to the new real total.
    const staffPP = Math.round(model.companies.reduce((s, c) => s + c._workersManual, 0));
    model.realStaffPP = staffPP;
    model.assumptions.staffPP = staffPP;
  }

  // ── Economics ───────────────────────────────────────────────────
  // Model maths lives in profit-core.js; these bind it to the loaded model.
  const price     = (code) => ProfitCore.price(model, code);
  const rawCostOf = (code) => ProfitCore.rawCostOf(model, code);
  const netPerPP  = (code, bonusPct) => ProfitCore.netPerPP(model, code, bonusPct);

  // ── Render ──────────────────────────────────────────────────────
  function renderAll() {
    renderAssumptions();
    renderTableAndIncome();
    renderCompanies();
    renderEmployees();
    $statsCard.classList.remove('hidden');
    $tableCard.classList.remove('hidden');
  }

  // Companies panel: automated-engine output per company, and AE with its region
  // production bonus applied — AE with bonus = AE × (1 + bonus%).
  function renderCompanies() {
    const cs = model.companies || [];
    if (!cs.length) { $compCard.classList.add('hidden'); return; }
    $compCard.classList.remove('hidden');
    const rows = cs.map(c => {
      const bonus = c._bonus ? c._bonus.total : 0;
      const ae = c._dailyAE || 0;
      return { name: c.name || '—', item: c.itemCode, bonus, ae, aeBonus: ae * (1 + bonus / 100) };
    }).sort((a, b) => b.aeBonus - a.aeBonus);
    const totAE  = rows.reduce((s, r) => s + r.ae, 0);
    const totAEB = rows.reduce((s, r) => s + r.aeBonus, 0);
    $companies.innerHTML = `
      <thead><tr>
        <th class="dp-l">Company</th>
        <th class="dp-l">Product</th>
        <th>Bonus</th>
        <th>AE / day</th>
        <th title="Automated-engine output with the region production bonus applied">AE with bonus</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="dp-l">${escapeHtml(r.name)}</td>
        <td class="dp-l"><span class="dp-prod">${iconHtml(r.item)}<span>${escapeHtml(META[r.item]?.name || r.item)}</span></span></td>
        <td class="dp-bonus">${r.bonus ? '+' + fmt2(r.bonus) + '%' : '<span class="dp-muted">0%</span>'}</td>
        <td>${fmtPP(r.ae)}</td>
        <td><strong>${fmtPP(r.aeBonus)}</strong></td>
      </tr>`).join('')}
      <tr class="dp-comp-total">
        <td class="dp-l" colspan="3">Total</td>
        <td>${fmtPP(totAE)}</td>
        <td><strong>${fmtPP(totAEB)}</strong></td>
      </tr></tbody>`;
  }

  // An employee's daily profit to you, at a given fidelity:
  //   value − wage = basePP × (netPP × (1 + fid/100) − wage).
  // (Wage is paid on the pre-fidelity base, so only the output side scales.)
  function empNet(e, fid) {
    if (e.netPP == null) return null;
    return e.basePP * (e.netPP * (1 + fid / 100) - e.wage);
  }
  function empNetHtml(net) {
    if (net == null) return '<span class="dp-na">—</span>';
    return `<span class="${net < 0 ? 'dp-emp-loss' : 'dp-emp-gain'}">${net >= 0 ? '+' : ''}${fmtK(net)}/day</span>`;
  }
  // Adjusted PP = production PP lifted by fidelity + region bonus, ADDITIVELY:
  //   EmpPP × (1 + (fidelity% + bonus%)).  Matches the sheet's "Adj PP".
  function empAdjPP(e, fid) { return e.prod * (1 + (fid + (e.bonus || 0)) / 100); }
  function empSubHtml(emps) {
    const bad = emps.filter(e => { const n = empNet(e, e.fidelity); return n != null && n < 0; }).length;
    return bad
      ? `<strong class="dp-emp-badcount">${bad} of ${emps.length}</strong> employee${bad > 1 ? 's' : ''} not making you a profit at current fidelity — bump the fidelity field (max 10) to see if they'd turn a profit.`
      : `All ${emps.length} employees are profitable at their current fidelity.`;
  }
  // Employees panel: name, company, editable fidelity (0–10), and live net/day.
  // Unprofitable ones are flagged; raising fidelity shows if they'd turn around.
  function renderEmployees() {
    const emps = model.employees || [];
    if (!emps.length) { $empCard.classList.add('hidden'); return; }
    $empCard.classList.remove('hidden');
    $empSub.innerHTML = empSubHtml(emps);
    // Unprofitable first, then most-negative first.
    const order = emps.map((e, i) => ({ e, i })).sort((a, b) => {
      const na = empNet(a.e, a.e.fidelity), nb = empNet(b.e, b.e.fidelity);
      const ba = na != null && na < 0, bb = nb != null && nb < 0;
      return ba === bb ? ((na ?? 0) - (nb ?? 0)) : (ba ? -1 : 1);
    });
    $employees.innerHTML = order.map(({ e, i }) => empRowHtml(e, i)).join('');
    // Wage and fidelity are both editable per row; either recomputes the row.
    $employees.querySelectorAll('.dp-fid-in').forEach(inp => inp.addEventListener('input', ev => {
      const i = +ev.target.dataset.idx;
      let v = parseInt(ev.target.value, 10);
      if (!isFinite(v)) v = 0;
      model.employees[i].fidelity = Math.max(0, Math.min(10, v));
      updateEmpRow(i);
    }));
    $employees.querySelectorAll('.dp-wage-in').forEach(inp => inp.addEventListener('input', ev => {
      const i = +ev.target.dataset.idx;
      let v = parseFloat(ev.target.value);
      if (!isFinite(v) || v < 0) v = 0;
      model.employees[i].wage = v;
      updateEmpRow(i);
    }));
  }

  // Break-even wage at full fidelity (10): wage where net = 0 → netPP × 1.10.
  // Pay more than this and they can't be profitable at ANY fidelity.
  function empBreakeven(e) { return e.netPP == null ? null : e.netPP * 1.10; }
  function empRowHtml(e, i) {
    const net = empNet(e, e.fidelity);
    const be  = empBreakeven(e);
    const beHtml = be == null ? '' :
      `<span class="dp-emp-be">break-even wage @ full fidelity: <strong>${fmt3(be)}</strong> · you pay `
      + `<span id="dp-emp-pay-${i}" class="${e.wage > be ? 'dp-emp-loss' : 'dp-emp-gain'}">${fmt3(e.wage)}</span>`
      + `<span id="dp-emp-warn-${i}">${e.wage > be ? ' — unprofitable at any fidelity' : ''}</span></span>`;
    return `<div class="dp-emp${net != null && net < 0 ? ' dp-emp-bad' : ''}" id="dp-emp-row-${i}">
      <div class="dp-emp-main">
        <span class="dp-emp-name">${escapeHtml(e.name)}${e.buddy ? ' <span class="dp-emp-buddy" title="Buddy — reciprocal hire; charged at 0.106 in Max employee">🤝 buddy</span>' : ''}</span>
        <span class="dp-emp-co">${escapeHtml(e.company)} · ${escapeHtml(META[e.item]?.name || e.item)}</span>
        ${beHtml}
      </div>
      <label class="dp-emp-fld">wage <input type="number" class="dp-wage-in" data-idx="${i}" value="${e.wage}" min="0" step="0.001"></label>
      <label class="dp-emp-fld">fidelity <input type="number" class="dp-fid-in" data-idx="${i}" value="${e.fidelity}" min="0" max="10" step="1"></label>
      <div class="dp-emp-adj" title="Adjusted PP = ${fmtPP(e.prod)} PP × (1 + fidelity% + ${fmt2(e.bonus || 0)}% bonus)">Adj PP <strong id="dp-emp-adj-${i}">${fmtPP(empAdjPP(e, e.fidelity))}</strong></div>
      <div class="dp-emp-net" id="dp-emp-net-${i}">${empNetHtml(net)}</div>
    </div>`;
  }
  // Recompute a single row in place (keeps input focus while typing).
  function updateEmpRow(i) {
    const e = model.employees[i];
    const net = empNet(e, e.fidelity);
    const cell = $employees.querySelector(`#dp-emp-net-${i}`);
    if (cell) cell.innerHTML = empNetHtml(net);
    const adj = $employees.querySelector(`#dp-emp-adj-${i}`);
    if (adj) adj.textContent = fmtPP(empAdjPP(e, e.fidelity));
    const row = $employees.querySelector(`#dp-emp-row-${i}`);
    if (row) row.classList.toggle('dp-emp-bad', net != null && net < 0);
    const be = empBreakeven(e), pay = $employees.querySelector(`#dp-emp-pay-${i}`);
    if (pay && be != null) {
      pay.textContent = fmt3(e.wage);
      pay.className = e.wage > be ? 'dp-emp-loss' : 'dp-emp-gain';
      const warn = $employees.querySelector(`#dp-emp-warn-${i}`);
      if (warn) warn.textContent = e.wage > be ? ' — unprofitable at any fidelity' : '';
    }
    $empSub.innerHTML = empSubHtml(model.employees);
  }

  function renderAssumptions() {
    const a = model.assumptions;
    $statsHead.textContent = `Projected income · ${model.user.username}`;
    // Items with no market price (untraded, e.g. wood/paper) get a manual
    // price field — typing a raw's price (wood) also feeds recipes (paper).
    const unpriced = Object.keys(META).filter(c => model.gameItems[c] && model.prices[c] == null);
    const priceFields = unpriced.map(c => `
      <div class="dp-field">
        <label>${escapeHtml(META[c].name)} price</label>
        <input type="number" class="dp-price-in" data-code="${c}" value="${model.priceOverrides[c] ?? ''}" min="0" step="0.001" placeholder="—">
        <span class="dp-suffix">untraded · set it</span>
      </div>`).join('');
    $assump.innerHTML = `
      <div class="dp-field">
        <label title="Automated-engine output per day, summed across your companies">Engine PP / day</label>
        <input type="number" id="dp-engines" value="${a.enginesPP}" min="0" step="1">
        <span class="dp-suffix">automated engines</span>
      </div>
      <div class="dp-field">
        <label title="You + your employees working in your companies">Staff PP / day</label>
        <input type="number" id="dp-staff" value="${a.staffPP}" min="0" step="1">
        <span class="dp-suffix">employees${model.selfPP ? ` + your ${model.selfPP} self-work${model.selfWorkItem ? ` → ${escapeHtml(model.selfWorkItem)}` : ''}` : ''}</span>
      </div>
      <div class="dp-field">
        <label title="Engine + staff total">Total throughput</label>
        <input type="number" id="dp-tp-total" value="${Math.round((a.enginesPP || 0) + (a.staffPP || 0))}" disabled>
        <span class="dp-suffix">engines + staff</span>
      </div>
      ${(model.selfPPbase > 0 && model.companies.length) ? `
      <div class="dp-field">
        <label title="Which of your own companies you self-work in (entrepreneurship)">Self-work in</label>
        <select id="dp-selfwork" class="dp-select">
          ${model.companies.map(c => `<option value="${c._id}" ${c._id === model.selfWorkCompanyId ? 'selected' : ''}>${escapeHtml(META[c.itemCode]?.name || c.itemCode)}${c.name ? ' · ' + escapeHtml(c.name) : ''}</option>`).join('')}
        </select>
        <span class="dp-suffix">${Math.round(model.selfPPbase)} base PP</span>
      </div>` : ''}
      <div class="dp-field">
        <label title="Net wage a worker could earn elsewhere. Every Target gross wage figure is this grossed up for the country's income tax.">Worker net wage</label>
        <input type="number" id="dp-netwage" value="${netWageRate() ?? ''}" min="0" step="0.001"
               placeholder="${model.marketNetWage ?? 'unavailable'}">
        <span class="dp-suffix">${model.marketNetWage == null
          ? 'market lookup failed'
          : `market rank ${WAGE_RANK_FROM_TOP}: ${fmt3(model.marketNetWage)}`}<button type="button" id="dp-netwage-reset"
             class="dp-linkbtn${model.wageOverride == null ? ' dp-hide' : ''}">reset</button></span>
      </div>
      ${priceFields}
    `;
    const $eng = $assump.querySelector('#dp-engines');
    const $stf = $assump.querySelector('#dp-staff');
    const $tot = $assump.querySelector('#dp-tp-total');
    const onThroughput = () => {
      const e = parseFloat($eng.value); model.assumptions.enginesPP = isFinite(e) ? e : 0;
      const s = parseFloat($stf.value); model.assumptions.staffPP   = isFinite(s) ? s : 0;
      if ($tot) $tot.value = Math.round(model.assumptions.enginesPP + model.assumptions.staffPP);
      renderTableAndIncome();   // re-renders the table only — these inputs keep focus
    };
    $eng.addEventListener('input', onThroughput);
    $stf.addEventListener('input', onThroughput);
    const $wage = $assump.querySelector('#dp-netwage');
    const $wageReset = $assump.querySelector('#dp-netwage-reset');
    if ($wage) $wage.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      // Blank or nonsense reverts to the market rate rather than zeroing it.
      model.wageOverride = (isFinite(v) && v > 0) ? v : null;
      if ($wageReset) $wageReset.classList.toggle('dp-hide', model.wageOverride == null);
      renderTableAndIncome();   // table only — keeps focus while typing
    });
    if ($wageReset) $wageReset.addEventListener('click', () => {
      model.wageOverride = null;
      if ($wage) $wage.value = model.marketNetWage ?? '';
      $wageReset.classList.add('dp-hide');
      renderTableAndIncome();
    });
    const $self = $assump.querySelector('#dp-selfwork');
    if ($self) $self.addEventListener('change', e => { assignSelfWork(e.target.value); renderAll(); });
    $assump.querySelectorAll('.dp-price-in').forEach(inp => {
      inp.addEventListener('input', e => {
        const code = e.target.dataset.code, v = e.target.value;
        if (v === '' || !isFinite(+v)) delete model.priceOverrides[code];
        else model.priceOverrides[code] = +v;
        renderTableAndIncome();   // re-renders the table only — these inputs keep focus
      });
    });
  }

  // Live what-if scales: editing Engine PP / Staff PP scales each company's
  // engine and staff output (and staff wages) by edited ÷ real baseline.
  const throughputScales = () => ProfitCore.throughputScales(model);

  // ── Table sort state ────────────────────────────────────────────
  // Default: Total max, highest first. This layout doesn't render Net/PP, so
  // defaulting to it would order the table by a number the user can't see;
  // starting on Total max also means the ▼ arrow is visible from first paint.
  // dir: 1 = asc, -1 = desc.
  let sortState = { key: 'totalMax', dir: -1 };
  const SORT_ACCESSORS = {
    name: r => r.name.toLowerCase(),
    bonus: r => r.bonus ?? -Infinity,
    maxCompany: r => r.maxCompany ?? -Infinity,
    maxEmployee: r => r.maxEmployee ?? -Infinity,
    totalMax: r => r.totalMax ?? -Infinity,
    empAssigned: r => r.empAssigned ?? -Infinity,
    actual: r => r.actual ?? -Infinity,
    lowWage: r => (r.lowWage != null && isFinite(r.lowWage)) ? r.lowWage : -Infinity,
    profitable: r => r.employeeProfitDay5 ?? -Infinity,
    country: r => r.country ? r.country.name.toLowerCase() : '',
    deposit: r => r.deposit ? new Date(r.deposit.endsAt).getTime() : -Infinity,
  };
  function sortRows(rows) {
    const acc = SORT_ACCESSORS[sortState.key] || SORT_ACCESSORS.totalMax;
    rows.sort((a, b) => {
      const av = acc(a), bv = acc(b);
      if (typeof av === 'string' || typeof bv === 'string') return sortState.dir * String(av).localeCompare(String(bv));
      return sortState.dir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return rows;
  }

  function buildRows() { return sortRows(ProfitCore.buildRows(model)); }

  function iconHtml(code) {
    const f = ICON_FILE[code];
    if (!f) return `<span>📦</span>`;
    return `<div class="icon-box"><img src="images/${f}" alt="" onerror="this.parentElement.innerHTML='📦'"></div>`;
  }

  // Column definitions for the sortable header row. `key` matches SORT_ACCESSORS;
  // `l` marks left-aligned columns. `firstDir` is the direction the FIRST click
  // applies (1 = ascending): text columns and "target gross wage" read naturally
  // ascending, value columns default to biggest-first.
  const TABLE_COLS = [
    { key: 'name',        label: 'Product',        l: true, firstDir: 1 },
    { key: 'bonus',       label: 'Bonus' },
    { key: 'maxCompany',  label: 'Max company',    title: 'If 100% of your company AE went to this product, at its bonus' },
    { key: 'maxEmployee', label: 'Max employee',   title: 'If 100% of your employees (incl. you) went to this product, minus wages' },
    { key: 'totalMax',    label: 'Total max',      title: 'Max company + max employee' },
    { key: 'empAssigned', label: 'Emp.',           title: 'Your employees currently producing this product' },
    { key: 'actual',      label: 'Actual / day' },
    { key: 'lowWage',     label: 'Target gross wage',    firstDir: 1, title: () => {
      const rate = netWageRate();
      if (rate == null) return 'Market wage data unavailable, so no benchmark could be computed';
      const basis = model.wageOverride != null
        ? 'your manual override'
        : `the ${WAGE_RANK_FROM_TOP}th-best net wage on offer, ignoring unattainable postings and companies at capacity`;
      return `Suggested wage before tax so the worker nets ${fmt3(rate)} after this country's income tax — ${basis}. This is not your break-even wage.`;
    } },
    { key: 'profitable',  label: 'Profitable worker', title: () =>
      `Would hiring a reference worker (${Math.round(model.genericWorker.energy)} energy / ${Math.round(model.genericWorker.production)} production = ${fmtPP(model.genericWorker.basePP)} base PP) at the target gross wage pay for itself on this product? Green = yes on day 1 at 1% fidelity. Yellow = not yet, but yes by day 5 at 5% fidelity (extra output, same wage). Red = no, even at day 5. Assumes the product’s best-bonus country and its tax — the same basis as the Bonus, Target gross wage and Country columns — not your company’s current location.` },
    { key: 'country',     label: 'Country · tax',  l: true, firstDir: 1, title: 'Country giving the best production bonus, and its income tax (Country › Account)' },
    { key: 'deposit',     label: 'Deposit',        title: 'Temporary regional deposit driving the bonus, and when it expires' },
  ];

  function renderTableAndIncome() {
    const rows = buildRows();

    $table.innerHTML = `
      <thead><tr>${TABLE_COLS.map(c => {
        const active = sortState.key === c.key;
        const arrow = active ? `<span class="dp-sort-arrow">${sortState.dir === 1 ? '▲' : '▼'}</span>` : '';
        const aria = active ? (sortState.dir === 1 ? 'ascending' : 'descending') : 'none';
        const title = typeof c.title === 'function' ? c.title() : c.title;
        return `<th class="dp-sortable${c.l ? ' dp-l' : ''}" data-sort-key="${c.key}" aria-sort="${aria}"${title ? ` title="${escapeHtml(title)}"` : ''}>${c.label}${arrow}</th>`;
      }).join('')}</tr></thead>
      <tbody>${rows.map(r => {
        const regionTip = r.region ? `${escapeHtml(r.region.name)}${r.country ? ' · ' + escapeHtml(r.country.name) : ''}` : 'no bonus region';
        const money = (v) => v == null ? '<span class="dp-na">–</span>' : fmtK(v);
        // Green from day 1, yellow if day-1 fails but the free fidelity bonus by
        // day 5 tips it into profit, red if not even by day 5.
        const profitState = r.employeeProfitDay1 == null ? null
          : (r.employeeProfitDay1 > 0 ? 'good' : (r.employeeProfitDay5 > 0 ? 'warn' : 'bad'));
        const wageClass = profitState == null ? '' : { good: 'dp-lowwage-good', warn: 'dp-lowwage-warn', bad: 'dp-lowwage-bad' }[profitState];
        const profitCell = profitState == null ? '<span class="dp-na">–</span>'
          : { good: '<span class="dp-profit-yes">✅</span>', warn: '<span class="dp-profit-warn" title="Not profitable on day 1 at 1% fidelity, but profitable by day 5 at 5% fidelity">🟡</span>', bad: '<span class="dp-profit-no">❌</span>' }[profitState];
        return `<tr class="${r.makesIt ? 'dp-owned' : ''}">
          <td class="dp-l"><span class="dp-prod">${iconHtml(r.code)}<span>${escapeHtml(r.name)}</span><span class="dp-pill ${r.type}">${r.type === 'product' ? 'Finished' : 'Raw'}</span><span class="dp-cat">· ${r.cat}</span></span></td>
          <td class="dp-bonus" title="${regionTip}">${r.bonus ? '+' + fmt2(r.bonus) + '%' : '<span class="dp-muted">0%</span>'}</td>
          <td>${money(r.maxCompany)}</td>
          <td>${money(r.maxEmployee)}</td>
          <td><strong>${money(r.totalMax)}</strong></td>
          <td>${r.empAssigned ? r.empAssigned : '<span class="dp-muted">0</span>'}</td>
          <td>${r.actual == null ? '<span class="dp-na">—</span>' : `<span class="dp-actual">${fmtK(r.actual)}</span>`}</td>
          <td class="${wageClass}">${r.lowWage != null && isFinite(r.lowWage) ? fmt3(r.lowWage) : '<span class="dp-na">–</span>'}</td>
          <td>${profitCell}</td>
          <td class="dp-l">${r.country ? `${escapeHtml(r.country.name)} <span class="dp-tax">· ${r.tax != null ? r.tax + '%' : '–'}</span>` : '<span class="dp-na">—</span>'}</td>
          <td>${r.deposit ? `<span class="dp-dep" title="Temporary deposit (+${r.deposit.bonus}% ${escapeHtml(META[r.deposit.type]?.name || r.deposit.type)}) — expires ${fmtDate(r.deposit.endsAt)}">⏳ ${fmtDate(r.deposit.endsAt)}</span>` : '<span class="dp-muted">—</span>'}</td>
        </tr>`;
      }).join('')}</tbody>
    `;
    $table.querySelectorAll('th[data-sort-key]').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      const col = TABLE_COLS.find(c => c.key === key);
      sortState.dir = (sortState.key === key) ? -sortState.dir : (col?.firstDir ?? -1);
      sortState.key = key;
      renderTableAndIncome();
    }));

    const priced = rows.filter(r => r.netPP != null).length;
    const missing = rows.filter(r => r.netPP == null).map(r => r.name);
    $tableNote.innerHTML = `${priced}/${rows.length} products priced.` + (missing.length ? ` No market price for: <code>${missing.join('</code>, <code>')}</code>.` : '');

    model._companiesIncome = rows.reduce((s, r) => s + (r.actual || 0), 0);
    renderIncome();
  }

  // Income summary. Mission cadences each have a "done?" checkbox; Case sales and
  // Deductions each have a manual input. The fixed income lines are summed once,
  // and the two manual fields recompute Case sales / Deductions / Total in place
  // (no full re-render, so typing keeps focus). Checkbox toggles do re-render.
  function renderIncome() {
    const done = model.missionsDone;
    const modeledCases = (done.daily  ? model.missionCasesDaily  : 0)
                       + (done.weekly ? model.missionCasesWeekly : 0);
    const casePriced     = model.casePrice != null;
    const concretePriced = model.concretePrice != null;

    // Income that doesn't change with the two manual fields.
    const fixedIncome =
        (model._companiesIncome || 0)
      + (model.salaryDaily || 0)
      + (done.daily  ? model.missionMoney       : 0)
      + (done.weekly ? model.missionMoneyWeekly : 0);

    const caseVal   = () => casePriced ? ((model.casesManual != null ? model.casesManual : modeledCases) * model.casePrice) : 0;
    // Each move / production change costs `moveCost` concrete (5), valued live.
    const deductVal = () => concretePriced ? ((model.movesManual || 0) * model.moveCost * model.concretePrice) : 0;
    const grandTotal = () => fixedIncome + caseVal() - deductVal();

    const items = [
      { label: 'Companies',  val: model._companiesIncome, sub: `${model.companies.length} active${model.disabledCount ? ` · ${model.disabledCount} disabled excluded` : ''}, current output` },
      { label: 'Salary',     val: model.salaryDaily, sub: model.salaryCount
          ? `~${model.salaryWorksPerDay.toFixed(1)} works/day × ${fmt2(model.salaryAvgPerWork)} net · modeled (24h actual: ${fmtK(model.salaryActual)})`
          : 'no recent wages to model from' },
      { label: 'Daily missions',  val: model.missionMoney,       sub: 'daily reward',          toggle: 'daily',  done: done.daily },
      { label: 'Weekly missions', val: model.missionMoneyWeekly, sub: 'full weekly reward · counted ×1 per week', toggle: 'weekly', done: done.weekly },
    ];

    // Weekly-cadence items (weekly mission money + its cases) bank once a week,
    // so the weekly projection counts them ×1, everything else ×7.
    const weeklyOnce = () => {
      let o = done.weekly ? (model.missionMoneyWeekly || 0) : 0;
      if (done.weekly && casePriced && model.casesManual == null) o += (model.missionCasesWeekly || 0) * model.casePrice;
      return o;
    };
    const weeklyTotal = () => { const once = weeklyOnce(); return (grandTotal() - once) * 7 + once; };

    // Case sales: manual "cases sold today" (empty → modeled count via placeholder).
    const caseSub = casePriced
      ? `<input type="number" class="dp-cases-in" value="${model.casesManual ?? ''}" placeholder="${fmt2(modeledCases)}" min="0" step="0.01"> cases × ${fmt2(model.casePrice)}`
      : 'no case price';
    const caseCard = `<div class="dp-inc"><div class="dp-inc-label">Case sales</div>`
      + `<div class="dp-inc-val" id="dp-case-val">${fmtK(caseVal())}</div><div class="dp-inc-sub">${caseSub}</div></div>`;

    // Deductions: company moves / production changes today × moveCost concrete × price.
    const deductSub = concretePriced
      ? `<input type="number" class="dp-moves-in" value="${model.movesManual ?? ''}" placeholder="0" min="0" step="1"> moves/changes × ${model.moveCost} concrete × ${fmt2(model.concretePrice)}`
      : 'no concrete price';
    const deductCard = `<div class="dp-inc dp-inc-deduct"><div class="dp-inc-label">Deductions</div>`
      + `<div class="dp-inc-val" id="dp-deduct-val">−${fmtK(deductVal())}</div><div class="dp-inc-sub">${deductSub}</div></div>`;

    $income.innerHTML = items.map(x => {
      const off = x.toggle && !x.done;
      const label = x.toggle
        ? `<label class="dp-inc-chk"><input type="checkbox" data-mission="${x.toggle}" ${x.done ? 'checked' : ''}>${x.label}</label>`
        : x.label;
      return `<div class="dp-inc${off ? ' dp-inc-off' : ''}"><div class="dp-inc-label">${label}</div>`
        + `<div class="dp-inc-val">${off ? '0.00' : fmtK(x.val)}</div><div class="dp-inc-sub">${x.sub}</div></div>`;
    }).join('') + caseCard + deductCard
      + `<div class="dp-inc total"><div class="dp-inc-label">Total / day</div><div class="dp-inc-val" id="dp-total-val">${fmtK(grandTotal())}</div><div class="dp-inc-sub" id="dp-total-sub">≈ ${fmtK(weeklyTotal())} / week</div></div>`;

    const recalc = () => {
      $income.querySelector('#dp-case-val').textContent = fmtK(caseVal());
      $income.querySelector('#dp-deduct-val').textContent = '−' + fmtK(deductVal());
      $income.querySelector('#dp-total-val').textContent = fmtK(grandTotal());
      $income.querySelector('#dp-total-sub').textContent = `≈ ${fmtK(weeklyTotal())} / week`;
    };

    $income.querySelectorAll('input[data-mission]').forEach(cb =>
      cb.addEventListener('change', () => { model.missionsDone[cb.dataset.mission] = cb.checked; renderIncome(); }));

    const casesIn = $income.querySelector('.dp-cases-in');
    if (casesIn) casesIn.addEventListener('input', e => {
      const raw = e.target.value.trim();
      model.casesManual = (raw === '' || !isFinite(+raw)) ? null : +raw;
      recalc();
    });
    const movesIn = $income.querySelector('.dp-moves-in');
    if (movesIn) movesIn.addEventListener('input', e => {
      const raw = e.target.value.trim();
      model.movesManual = (raw === '' || !isFinite(+raw)) ? null : +raw;
      recalc();
    });
  }

  // ── Wiring ──────────────────────────────────────────────────────
  $submit.addEventListener('click', handleSubmit);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-dp-recent-del]');
    if (del) { forgetUsername(del.dataset.dpRecentDel); return; }
    const pick = e.target.closest('[data-dp-recent]');
    if (pick) { $username.value = pick.dataset.dpRecent; handleSubmit(); }
  });

  return {
    activate(params) {
      renderRecent();
      const u = (params && params.get && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; handleSubmit(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
