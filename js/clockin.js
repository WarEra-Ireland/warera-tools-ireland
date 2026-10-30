/* Manager monitor. Activity comes from manager.getByCompanyId;
 * last login and manager care come from user.getUserLite, not wage payments.
 * The #clockin route and DOM names are retained for existing bookmarks.
 */
const ClockInTool = (() => {
  const $username = document.getElementById('clockin-username');
  const $run = document.getElementById('clockin-go');
  const $hint = document.getElementById('clockin-hint');
  const $summary = document.getElementById('clockin-summary');
  const $sumWorkers = document.getElementById('clockin-sum-workers');
  const $projection = document.getElementById('clockin-projection');
  const $workers = document.getElementById('clockin-workers');
  const $filterIdle = document.getElementById('clockin-filter-idle');
  const $sortRecent = document.getElementById('clockin-sort-recent');
  const $sortIdle = document.getElementById('clockin-sort-idle');
  const steps = makeSteps(document.getElementById('clockin-steps'));
  const setStatus = makeStatus(document.getElementById('clockin-status'));
  let state = null;
  let running = false;

  const ci_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true, timeoutMs: 20000, fresh: true });
  const money = n => `₿${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}`;

  function timestamp(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  function dateHtml(value, now) {
    const ms = timestamp(value);
    if (ms == null) return 'Unknown';
    const minutes = Math.max(0, Math.floor((now - ms) / 60000));
    const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago`
      : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
      : `${Math.floor(minutes / 1440)}d ago`;
    return `<span title="${escapeHtml(new Date(ms).toLocaleString())}">${ago}</span>`;
  }

  async function resolveUserId(username) {
    const search = await ci_trpc('search.searchAnything', { searchText: username });
    const candidateIds = search?.userIds || [];
    if (!candidateIds.length) {
      throw new Error(
        `Couldn't find a user called "${username}". ` +
        `Double-check the spelling, or try again in a moment — the search API sometimes returns nothing on a hiccup.`
      );
    }
    steps.setStep(1, 'active', {
      sub: `Verifying among ${candidateIds.length} match${candidateIds.length === 1 ? '' : 'es'}`,
      count: `0/${Math.min(candidateIds.length, 10)}`,
    });

    const top = candidateIds.slice(0, 10);
    const profiles = await trpcManyValues('user.getUserLite',
      top.map(userId => ({ userId })),
      { timeoutMs: 20000, onProgress: (done, total) => {
        steps.setStep(1, 'active', { count: `${done}/${total}` });
      } });
    const known = profiles.filter(Boolean);
    const normalise = s => (s || '').toLowerCase().trim();
    const target = normalise(username);
    const exact = known.find(u => normalise(u.username) === target);
    if (exact) return { userId: exact._id, username: exact.username, country: exact.country, exact: true };

    // Search succeeded but every profile lookup failed — almost
    // certainly the user endpoint is having a moment. Don't fall
    // back to an unverified candidate (we used to, and it caused
    // misleading "wrong user" results during outages).
    if (!known.length) {
      throw new Error(
        `Found possible matches for "${username}" but couldn't load any of their profiles. ` +
        `The data server may be having issues — wait a few seconds and try again.`
      );
    }
    const found = known.map(u => u.username).filter(Boolean);
    throw new Error(
      `No exact match for "${username}". Search returned: ` +
      `${found.slice(0, 5).join(', ')}${found.length > 5 ? '…' : ''}`
    );
  }

  async function analyse(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const resolved = await resolveUserId(username);
    steps.setStep(1, 'done', { count: resolved.username });
    enforceIrishOnly(resolved.country, resolved.username);

    const rows = await loadRows(resolved.userId, (n, status, detail) => steps.setStep(n, status, detail));
    steps.setStep(4, 'active', { sub: 'Checking activity and hourly costs' });
    state = { ownerUsername: resolved.username, rows };
    render();
    steps.setStep(4, 'done', { count: `${rows.length} companies checked` });
    steps.fadeOut(800);
  }

  async function loadRows(userId, step = () => {}) {
    step(2, 'active', { sub: 'Fetching companies' });
    const companyIds = [];
    let cursor;
    do {
      const page = await ci_trpc('company.getCompanies', {
        userId, perPage: 100, ...(cursor ? { cursor } : {}),
      });
      companyIds.push(...(page?.items || []).map(c => typeof c === 'string' ? c : c._id));
      cursor = page?.nextCursor;
    } while (cursor);
    const ids = [...new Set(companyIds)];
    const byCompany = ids.map(companyId => ({ companyId }));
    const [companies, managers] = await Promise.all([
      trpcMany('company.getById', byCompany, { fresh: true }),
      trpcMany('manager.getByCompanyId', byCompany, { fresh: true }),
    ]);
    // A failed lookup is not an empty manager slot. Stop instead of reporting a false vacancy.
    for (const result of [...companies, ...managers]) {
      if (result.status === 'rejected') throw result.reason;
    }
    const rows = companies.flatMap((result, i) => {
      const company = result.value;
      if (!company || company.disabledAt) return [];
      return [{ company, manager: managers[i].value, profile: null }];
    });
    const managerIds = [...new Set(rows.map(r => r.manager?.user).filter(Boolean))];
    step(2, 'done', { count: `${rows.length} companies · ${managerIds.length} managers` });

    step(3, 'active', { sub: 'Loading manager names and activity', count: `0/${managerIds.length}` });
    const profiles = await trpcManyValues('user.getUserLite', managerIds.map(userId => ({ userId })), {
      fresh: true, timeoutMs: 20000,
      onProgress: (done, total) => step(3, 'active', { count: `${done}/${total}` }),
    });
    const profileById = new Map(managerIds.map((id, i) => [id, profiles[i]]));
    rows.forEach(row => { row.profile = profileById.get(row.manager?.user) || null; });
    step(3, 'done', { count: `${profiles.filter(Boolean).length}/${managerIds.length} profiles loaded` });
    return rows;
  }

  function managerStatus(manager) {
    if (!manager) return { label: 'No manager', cls: 'never' };
    if (manager.isInactive === true) return { label: 'Inactive', cls: 'danger' };
    if (manager.isInactive === false) return { label: 'Active', cls: '' };
    return { label: 'Activity unknown', cls: 'warn' };
  }

  function renderProjection(rows) {
    const contracts = rows.map(r => r.manager).filter(Boolean);
    $projection.style.display = contracts.length ? '' : 'none';
    if (!contracts.length) return;
    const known = contracts.filter(m => Number.isFinite(m.hourlyWage));
    const hourly = known.reduce((sum, m) => sum + m.hourlyWage, 0);
    const unknown = contracts.length - known.length;
    $projection.innerHTML = `
      <div class="clockin-proj-head">
        <div class="clockin-proj-title">Manager payroll at current rates</div>
        <div class="clockin-proj-hint">Hourly wages × hours for all listed contracts. Assumes rates and contracts stay the same. This is not a payment history.${unknown ? ` ${unknown} contract(s) have unknown wages and are excluded.` : ''}</div>
      </div>
      <div class="clockin-proj-grid">${[3, 6, 24].map(hours => `
        <div class="clockin-proj-card">
          <div class="clockin-proj-label">Next ${hours}h${unknown ? ' (known wages)' : ''}</div>
          <div class="clockin-proj-value">${money(hourly * hours)}</div>
        </div>`).join('')}</div>`;
  }

  function render() {
    if (!state) return;
    const now = Date.now();
    const rows = state.rows;
    const managers = rows.filter(r => r.manager);
    const active = managers.filter(r => r.manager.isInactive === false).length;
    const inactive = managers.filter(r => r.manager.isInactive === true).length;
    const unknown = managers.length - active - inactive;
    $sumWorkers.innerHTML = `${managers.length} <span class="sub">(${active} active · ${inactive} inactive${unknown ? ` · ${unknown} unknown` : ''} · ${rows.length - managers.length} vacancies)</span>`;
    $summary.style.display = '';
    $hint.classList.add('hidden');
    renderProjection(rows);

    let shown = rows.filter(r => !$filterIdle.checked || r.manager?.isInactive === true);
    shown = shown.slice().sort((a, b) => {
      const aTime = timestamp(a.profile?.dates?.lastConnectionAt);
      const bTime = timestamp(b.profile?.dates?.lastConnectionAt);
      if (aTime == null) return bTime == null ? 0 : 1;
      if (bTime == null) return -1;
      return $sortIdle.checked ? aTime - bTime : bTime - aTime;
    });
    if (!shown.length) {
      $workers.innerHTML = `<div class="status">${rows.length ? 'No managers match the current filter.' : 'No active companies found for this account.'}</div>`;
      return;
    }
    $workers.innerHTML = shown.map(({ company, manager, profile }) => {
      const status = managerStatus(manager);
      const name = manager ? `<a href="${GAME_BASE}/user/${encodeURIComponent(manager.user)}" target="_blank" rel="noopener">${escapeHtml(profile?.username || `User ${manager.user.slice(-6)}`)}</a>` : 'No manager';
      const wage = Number.isFinite(manager?.hourlyWage) ? `${money(manager.hourlyWage)}/h` : 'Wage unknown';
      return `<div class="clockin-worker-card">
        <div class="clockin-worker-head">
          <div class="clockin-worker-name">${name}</div>
          <a class="clockin-company" href="${GAME_BASE}/company/${encodeURIComponent(company._id)}" target="_blank" rel="noopener"><span class="clockin-company-name">${escapeHtml(company.name || 'Company')}</span></a>
          <div class="clockin-worker-meta">
            <span class="clockin-item"><span class="clockin-ago ${status.cls}">${status.label}</span></span>
            ${manager ? `<span class="clockin-item">${wage}</span>
              <span class="clockin-item">Bonus: <strong>${Number.isFinite(manager.productionBonusPercent) ? `+${manager.productionBonusPercent}%${manager.isInactive ? ' (inactive)' : ''}` : 'Unknown'}</strong></span>
              <span class="clockin-item">Last login: <strong>${dateHtml(profile?.dates?.lastConnectionAt, now)}</strong></span>
              <span class="clockin-item">Last manager care: <strong>${dateHtml(profile?.dates?.lastManagerCareAt, now)}</strong></span>
              ${manager.unpaidHours > 0 ? `<span class="clockin-item neg">${manager.unpaidHours} unpaid hours</span>` : ''}` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  async function run() {
    if (running) return;
    const u = $username.value.trim();
    if (!u) { $username.focus(); return; }

    // Update the hash so this view is shareable. Preserve any extra
    // params (like bypass=1) the user came in with so they survive the
    // re-write — otherwise the gate can't see them after the run starts.
    const params = hashParams();
    params.set('u', u);
    writeHash('clockin', params);

    running = true;
    $run.disabled = true;
    $hint.classList.add('hidden');
    setStatus('');
    $workers.innerHTML = '';
    $summary.style.display = 'none';
    if ($projection) $projection.style.display = 'none';
    steps.reset();
    state = null;
    try {
      await analyse(u);
      rememberLoadedAccount(state?.ownerUsername);
      // If the resolved name differs in case, rewrite the hash with the
      // canonical form so refresh-by-URL stays stable. Same param-preserving
      // pattern as above.
      if (state?.ownerUsername && state.ownerUsername !== u) {
        const q = hashParams();
        q.set('u', state.ownerUsername);
        writeHash('clockin', q);
      }
    } catch (e) {
      steps.markActiveAsError(e.message);
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      running = false;
      $run.disabled = false;
    }
  }

  $run.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $filterIdle.addEventListener('change', () => state && render());
  $sortRecent.addEventListener('change', () => state && render());
  $sortIdle.addEventListener('change',   () => state && render());

  return {
    loadRows,
    /**
     * Called by the router every time this view becomes active.
     * Idempotent: if ?u= differs from the current input, update the
     * field and re-run; otherwise just focus the empty field.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    },
  };
})();