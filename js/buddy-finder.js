/* The Irish buddy pool: every active Irish player's manager job and open slots. */
const BuddyFinderTool = (() => {
  // DOM
  const $mInput    = document.getElementById('bf-match-username');
  const $mBtn      = document.getElementById('bf-match-submit');
  const $mStatus   = document.getElementById('bf-match-status');
  const $mResults  = document.getElementById('bf-match-results');

  const steps      = makeSteps(document.getElementById('bf-match-steps'));

  document.getElementById('bf-roster-help').outerHTML = sectionHelp('About arranging buddies', '<p>Hire players with Management available onto your open companies. If you are free, manage a company for a player with jobs available. Message them in game first to confirm.</p>');
  document.getElementById('bf-manager-help').outerHTML = sectionHelp('About the buddy pool', '<p>Any Irish player can have a buddy managing each of their companies, while managing just one company themselves. A buddy is any Irish manager, whatever the wage. Every other company is an open slot, including one with a foreign manager.</p><p>The table lists every active Irish player. Management available is their Management if they can take a manager job: level 10 or above and not managing an Irish company yet. Manager jobs available is how many of their companies have no Irish manager. Click a heading to sort.</p>');

  let loadVersion = 0;
  let rosterStore = null;
  let sort = { key: 'jobs', dir: -1 };

  // tRPC wrapper using the shared client (retries on transient 5xx).
  const bf_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  const getCountry = u => u?.country ?? u?.countryId ?? null;

  /* ── Username resolution ────────────────────────────────── */
  // Same exact-match pattern as advisor/clockin: search returns fuzzy
  // matches, we verify by exact username (case-insensitive) against
  // the lite profile. Never silently fall back to the top result.
  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;

    const searchRes = await bf_trpc('search.searchAnything', { searchText: username });
    const candidateIds = (searchRes?.userIds || []).slice(0, 10);
    if (candidateIds.length === 0) return null;

    const candidates = await trpcManyValues('user.getUserLite',
      candidateIds.map(userId => ({ userId })));

    return candidates.find(u =>
      u && typeof u.username === 'string' && u.username.toLowerCase() === needle
    ) || null;
  }

  /* ── Bulk fetchers ──────────────────────────────────────── */
  async function fetchAllIrishCitizens() {
    const PAGE_LIMIT = 100;
    const items = [];
    let cursor;
    let safety = 0;
    const seen = new Set();
    while (safety++ < 200) {
      const input = { countryId: IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await bf_trpc('user.getUsersByCountry', input);
      const arr = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      items.push(...arr);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next) return items;
      if (!arr.length || seen.has(next)) throw new Error('Citizen pagination is incomplete. Try again.');
      seen.add(next);
      cursor = next;
    }
    throw new Error('Citizen list exceeded the page limit.');
  }
  // Batched lookups where a failed item must fail the scan, since a missing
  // profile, company list or contract would silently miscount the pool.
  async function fetchAll(endpoint, inputs, what) {
    const failed = {};
    const values = await trpcManyValues(endpoint, inputs, { fallback: failed });
    if (values.includes(failed)) throw new Error(`Some ${what} could not be loaded. Try again.`);
    return values;
  }

  /* ── Buddy pool ───────────────────────────────────────── */
  /*
   *  Every Irish citizen's profile, companies and their managers. Batched,
   *  this is under 20 requests for 130 citizens and 1,150 companies. The
   *  result is `me`'s place in the pool (buddies, open slots, manager job)
   *  and the roster of active Irish players. Shared with the dashboard card.
   */
  async function loadBuddyPool(me) {
    const ids = (await fetchAllIrishCitizens()).map(c => c._id);
    const [profiles, lists] = await Promise.all([
      fetchAll('user.getUserLite', ids.map(userId => ({ userId })), 'profiles'),
      fetchAll('company.getCompanies', ids.map(userId => ({ userId, perPage: 100 })), 'company lists'),
    ]);
    const owners = new Map(ids.map((id, i) => [id, lists[i]?.items || []]));
    const companyIds = [...owners.values()].flat();
    const contracts = await fetchAll('manager.getByCompanyId', companyIds.map(companyId => ({ companyId })), 'company managers');
    const players = ManagerCore.pool({ owners, managers: new Map(companyIds.map((id, i) => [id, contracts[i]])) });
    const users = new Map(profiles.filter(Boolean).map(u => [u._id, u]));
    const entry = p => ({ ...p, user: users.get(p.id), employer: users.get(p.job?.employer) || null });
    const mine = players.get(me._id) || { id: me._id, companies: 0, buddies: [], openSlots: 0, job: null };
    return {
      mine: { ...entry(mine), buddies: mine.buddies.map(id => users.get(id)).filter(Boolean) },
      roster: [...players.values()].map(entry).filter(p => p.user?.isActive && getCountry(p.user) === IRELAND_COUNTRY_ID),
      scanned: companyIds.length,
    };
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const profileLink = user => `<a href="${GAME_BASE}/user/${escapeHtml(user._id)}" target="_blank" rel="noopener">${escapeHtml(user.username)}</a>`;
  const muted = text => `<span class="bf-muted">${text}</span>`;

  /* ── Roster table ───────────────────────────────────────── */
  const COLUMNS = [
    { key: 'player', label: 'Player', l: true, dir: 1 },
    { key: 'management', label: 'Management', title: 'Management points, 1–11' },
    { key: 'available', label: 'Management available', title: 'Management of players who can take a manager job: level 10 or above and not managing an Irish company' },
    { key: 'jobs', label: 'Manager jobs available', title: 'Companies without an Irish manager' },
  ];
  function sortValue(p, key) {
    switch (key) {
      case 'player': return p.user.username;
      case 'management': return ManagerCore.points(p.user);
      case 'jobs': return p.companies ? p.openSlots : null;
    }
  }
  // Descending: free players by Management, highest first; then players
  // already managing, by the name of the player they manage; then players
  // below level 10. Ascending is the exact reverse.
  function compareAvailable(a, b) {
    const group = p => ManagerCore.canManage(p) ? 0 : p.job ? 1 : 2;
    const employer = p => p.employer?.username || '';
    return group(a) - group(b)
      || (group(a) === 0 ? ManagerCore.points(b.user) - ManagerCore.points(a.user) : 0)
      || (group(a) === 1 ? employer(a).localeCompare(employer(b)) : 0);
  }
  function compareValues(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (typeof a === 'string' ? a.localeCompare(b) : a - b) * dir;
  }
  function sortableHead() {
    return `<thead><tr>${COLUMNS.map(c => {
      const active = sort.key === c.key;
      const aria = active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none';
      const arrow = active ? (sort.dir === 1 ? '▲' : '▼') : '↕';
      return `<th class="dp-sortable${c.l ? ' dp-l' : ''}" aria-sort="${aria}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}><button type="button" class="bf-sort" data-sort-key="${c.key}">${c.label}<span class="dp-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
    }).join('')}</tr></thead>`;
  }

  function availableCell(p) {
    if (ManagerCore.canManage(p)) return `<strong>${ManagerCore.points(p.user)}</strong>${muted('/11')}`;
    if (p.job) return muted(`Managing ${p.employer ? profileLink(p.employer) : 'an Irish company'}`);
    return muted(`Level ${p.user.leveling?.level ?? '?'}`);
  }

  function summaryHtml(me, mine, roster) {
    const buddies = mine.buddies.length
      ? `${plural(mine.buddies.length, 'buddy', 'buddies')}: ${mine.buddies.map(profileLink).join(', ')}`
      : 'No buddies yet';
    const job = mine.job
      ? `You manage a company for ${mine.employer ? profileLink(mine.employer) : 'an Irish player'}.`
      : 'You are free to manage a company for someone.';
    const free = roster.filter(ManagerCore.canManage).length;
    return `<p class="bf-match-note"><strong>${escapeHtml(me.username)}</strong> · ${buddies} · ${mine.openSlots} of ${plural(mine.companies, 'company', 'companies')} open. ${job}</p>
      <p class="bf-match-note">${plural(roster.length, 'active Irish player')} · ${free} free to manage · ${roster.reduce((sum, p) => sum + p.openSlots, 0)} manager jobs available.</p>`;
  }

  function renderRoster() {
    const { roster, me, mine } = rosterStore;
    const compare = sort.key === 'available'
      ? (a, b) => compareAvailable(a, b) * -sort.dir
      : (a, b) => compareValues(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir);
    const rows = [...roster].sort((a, b) => compare(a, b) || ManagerCore.rankRoster(a, b));
    $mResults.innerHTML = summaryHtml(me, mine, roster)
      + `<div class="dp-table-wrap"><table class="dp-table bf-roster">${sortableHead()}<tbody>${rows.map(p => `<tr${p.id === me._id ? ' class="bf-you"' : ''}>
          <td class="dp-l">${profileLink(p.user)}${p.id === me._id ? ' <span class="bf-status free">You</span>' : ''}</td>
          <td>${ManagerCore.points(p.user)}</td>
          <td>${availableCell(p)}</td>
          <td>${p.companies ? `<strong>${p.openSlots}</strong>${muted(` of ${p.companies}`)}` : muted('No companies')}</td>
        </tr>`).join('')}</tbody></table></div>`;
    $mResults.querySelectorAll('button[data-sort-key]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      const focused = document.activeElement === button;
      sort = { key, dir: sort.key === key ? -sort.dir : COLUMNS.find(c => c.key === key).dir || -1 };
      renderRoster();
      if (focused) $mResults.querySelector(`button[data-sort-key="${key}"]`).focus({ preventScroll: true });
    }));
  }

  /* ── Inline status helper ───────────────────────────────── */
  function showStatus($el, level, html) {
    $el.className = `bf-inline-status ${level}`;
    $el.innerHTML = html;
    $el.classList.remove('hidden');
  }
  function hideStatus($el) {
    $el.classList.add('hidden');
    $el.innerHTML = '';
  }

  async function handleMatchSubmit() {
    const raw = $mInput.value.trim();
    if (!raw) { $mInput.focus(); return; }
    const version = ++loadVersion;
    $mBtn.disabled = true;
    $mResults.innerHTML = '';
    rosterStore = null;
    hideStatus($mStatus);
    steps.reset();
    try {
      steps.setStep(1, 'active');
      const me = await resolveUsername(raw);
      if (version !== loadVersion) return;
      if (!me) throw new Error(`No exact username match for "${raw}".`);
      enforceIrishOnly(getCountry(me), me.username);
      const params = hashParams(); params.set('u', me.username); writeHash('buddy-finder', params);
      steps.setStep(1, 'done');
      steps.setStep(2, 'active', { sub: 'Profiles, companies and managers of every Irish citizen' });
      const { mine, roster, scanned } = await loadBuddyPool(me);
      if (version !== loadVersion) return;
      steps.setStep(2, 'done', { count: `${plural(roster.length, 'player')} · ${plural(scanned, 'company', 'companies')}` });
      steps.fadeOut(400);
      rosterStore = { roster, me, mine };
      renderRoster();
      rememberLoadedAccount(me.username);
    } catch (e) {
      if (version !== loadVersion) return;
      steps.markActiveAsError(e.message);
      showStatus($mStatus, 'error', escapeHtml(e.message));
    } finally { if (version === loadVersion) $mBtn.disabled = false; }
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  $mBtn.addEventListener('click', handleMatchSubmit);
  $mInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleMatchSubmit(); });
  $mInput.addEventListener('input', () => {
    loadVersion++;
    steps.hide();
    rosterStore = null;
    $mBtn.disabled = false;
    $mResults.innerHTML = '';
    hideStatus($mStatus);
  });

  return {
    loadBuddyPool,
    /**
     * Called by the router whenever this view becomes active.
     * Re-runs the search when the linked account changes.
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $mInput.value !== u) {
        $mInput.value = u;
        handleMatchSubmit();
      } else if (!$mInput.value) {
        $mInput.focus();
      }
    }
  };
})();
