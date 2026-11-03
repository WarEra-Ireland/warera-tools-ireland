/* Player identities and roles are mapped locally; GitHub stats refresh when credits open. */
(() => {
  const root = document.getElementById('footer-credits');
  if (!root) return;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function identity(person) {
    if (!person.name || !person.userId) return element('span', '', person.name || `@${person.github}`);
    const link = element('a', '', `${person.name} ↗`);
    link.href = `https://app.warera.io/user/${encodeURIComponent(person.userId)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', `${person.name}, in-game profile`);
    return link;
  }
  function lastCommit(person) {
    if (!person.lastCommitAt) return element('span', 'footer-last-commit', 'Last commit unavailable');
    const date = new Date(person.lastCommitAt);
    const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    const label = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` :
      date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const time = element('time', `footer-last-commit${days < 30 ? ' footer-commit-recent' : ''}`, `Last commit ${label}`);
    time.dateTime = person.lastCommitAt;
    time.title = `Latest authored commit on the default branch, committed ${date.toISOString()}`;
    return time;
  }
  function organisationMembers(people) {
    const membership = element('section', 'footer-org');
    membership.append(element('strong', '', 'Organisation members'));
    const members = element('div', 'footer-org-members');
    people.filter(p => p.orgMember).forEach(person => members.append(identity(person)));
    membership.append(members);
    return membership;
  }
  function renderUnavailable(config) {
    const message = element('p', '', 'Commit stats are unavailable right now.');
    const formerMembers = element('div', 'footer-contributor-list');
    config.people.filter(person => person.role).forEach(person => {
      const row = element('div');
      row.append(identity(person), element('div', 'footer-contributor-role', person.role));
      formerMembers.append(row);
    });
    root.replaceChildren(message, organisationMembers(config.people), formerMembers);
  }
  function render(data, period = 'all') {
    if (!Array.isArray(data.people) || data.people.some(p =>
      typeof p.github !== 'string' || !Number.isInteger(p.commits) || p.commits < 0 || typeof p.orgMember !== 'boolean' ||
      !Number.isInteger(p.recentCommits) || p.recentCommits < 0 || (p.lastCommitAt !== null && Number.isNaN(Date.parse(p.lastCommitAt)))
    ) || Number.isNaN(Date.parse(data.updatedAt))) throw new Error('Invalid contributor data');

    const people = [...data.people].sort((a, b) => Boolean(a.role) - Boolean(b.role) ||
      (a.name || a.github).localeCompare(b.name || b.github));
    const contributors = people.filter(p => p.commits > 0);
    const commitsFor = person => period === 'recent' ? person.recentCommits : person.commits;
    const total = contributors.reduce((sum, person) => sum + commitsFor(person), 0);
    const heading = element('div', 'footer-stats-heading');
    const periods = element('div', 'footer-stats-period');
    periods.setAttribute('role', 'group');
    periods.setAttribute('aria-label', 'Commit statistics period');
    for (const [key, label] of [['all', 'All-time'], ['recent', 'Last 30 days']]) {
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(period === key));
      button.addEventListener('click', () => {
        render(data, key);
        root.querySelector(`.footer-stats-period button[aria-pressed="true"]`).focus();
      });
      periods.append(button);
    }
    heading.append(element('strong', '', 'Contributions to the project'), periods);
    const count = element('div', 'footer-commit-total', total.toLocaleString('en-GB'));
    count.append(element('small', '', ' human commits'));
    const strip = element('div', 'footer-commit-strip');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', contributors.map(p => `${p.name || p.github}: ${commitsFor(p)} commits`).join('; '));
    const legend = element('div', 'footer-contributor-list');
    const formerBackgrounds = ['var(--footer-former-1)', 'var(--footer-former-2)'];
    let formerIndex = 0;
    contributors.forEach((person, index) => {
      const background = person.role ? formerBackgrounds[formerIndex++ % formerBackgrounds.length] :
        ['var(--accent)', 'var(--text)', 'var(--link)'][index % 3];
      const segment = element('span');
      segment.style.flexGrow = commitsFor(person);
      segment.style.background = background;
      segment.title = `${person.name || person.github}: ${commitsFor(person)} commits`;
      if (commitsFor(person) > 0) strip.append(segment);
      const row = element('div', `footer-contributor${person.role ? ' footer-contributor-former' : ''}`);
      const dot = element('span', 'footer-contributor-dot');
      dot.style.background = background;
      dot.setAttribute('aria-hidden', 'true');
      const name = element('div');
      name.append(identity(person));
      name.append(lastCommit(person));
      if (person.role) name.append(element('div', 'footer-contributor-role', person.role));
      const quantity = element('span', 'footer-contributor-count', `${commitsFor(person)} commits`);
      row.append(dot, name, quantity);
      legend.append(row);
    });
    if (!total) strip.append(element('span', 'footer-no-commits', 'No commits in this period'));
    const membership = organisationMembers(people);
    const source = element('div', 'footer-stats-source');
    source.textContent = `Updated ${new Date(data.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} · Bots excluded`;
    if (data.refreshFailed) source.append(document.createTextNode(' · Live update unavailable'));
    root.replaceChildren(heading, count, strip, legend, membership, source);
  }
  const API = 'https://api.github.com';
  const details = root.closest('details');
  let config;
  let cachedData;
  let loading = false;
  let lastAttempt = 0;

  async function github(path, signal, paginate = true) {
    let url = new URL(path, API).href;
    const records = [];
    while (url) {
      const response = await fetch(url, { signal, headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error('Invalid GitHub list response');
      records.push(...page);
      const next = response.headers.get('Link')?.match(/<([^>]+)>; rel="next"/);
      url = paginate && next ? next[1] : null;
      if (url && new URL(url).origin !== API) throw new Error('Invalid GitHub pagination URL');
    }
    return records;
  }

  async function liveData(config, signal) {
    const updatedAt = new Date().toISOString();
    const recentSince = new Date(Date.now() - 30 * 86400000).toISOString();
    const repository = config.repository;
    const org = repository.split('/')[0];
    const [contributors, members] = await Promise.all([
      github(`/repos/${repository}/contributors?per_page=100`, signal),
      github(`/orgs/${org}/members?per_page=100`, signal)
    ]);
    const mappings = new Map(config.people.map(person => [person.github.toLowerCase(), person]));
    const counts = new Map(contributors.filter(person => person.type === 'User')
      .map(person => [person.login.toLowerCase(), person]));
    const publicMembers = new Map(members.filter(person => person.type === 'User')
      .map(person => [person.login.toLowerCase(), person]));
    const logins = new Set([...mappings.keys(), ...counts.keys(), ...publicMembers.keys()]);
    const people = await Promise.all([...logins].map(async login => {
      const mapped = mappings.get(login);
      const contributor = counts.get(login);
      const person = {
        ...mapped,
        github: contributor?.login || publicMembers.get(login)?.login || mapped.github,
        name: mapped?.name || null,
        userId: mapped?.userId || null,
        role: mapped?.role || null,
        // A missing public membership does not mean a mapped member has left.
        orgMember: publicMembers.has(login) || mapped?.orgMember === true,
        commits: contributor?.contributions || 0,
        recentCommits: 0,
        lastCommitAt: null
      };
      if (person.commits) {
        const author = encodeURIComponent(person.github);
        const [latest, recent] = await Promise.all([
          github(`/repos/${repository}/commits?author=${author}&per_page=1`, signal, false),
          github(`/repos/${repository}/commits?author=${author}&since=${encodeURIComponent(recentSince)}&per_page=100`, signal)
        ]);
        person.lastCommitAt = latest[0]?.commit?.committer?.date || null;
        person.recentCommits = recent.length;
      }
      return person;
    }));
    return { repository, updatedAt, recentSince, people };
  }

  async function refresh() {
    if (!details.open || loading || Date.now() - lastAttempt < 10 * 60 * 1000) return;
    loading = true;
    lastAttempt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      if (!config) {
        const response = await fetch('data/contributors.json', { signal: controller.signal });
        if (!response.ok) throw new Error('Contributor mappings unavailable');
        const value = await response.json();
        if (!/^[\w.-]+\/[\w.-]+$/.test(value.repository) || !Array.isArray(value.people) ||
            value.people.some(person => typeof person.github !== 'string')) throw new Error('Invalid contributor mappings');
        config = value;
      }
      const data = await liveData(config, controller.signal);
      render(data);
      cachedData = data;
    } catch {
      if (cachedData) render({ ...cachedData, refreshFailed: true });
      else if (config) renderUnavailable(config);
      else root.replaceChildren(element('p', '', 'Contributor stats are unavailable right now.'));
    } finally {
      clearTimeout(timeout);
      loading = false;
    }
  }
  details.addEventListener('toggle', refresh);
  if (details.open) refresh();
})();
