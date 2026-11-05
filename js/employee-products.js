/* Products tab of Employee Training (product-switch ticket 04): per
 * company, whether to re-tool it onto another good, read from the
 * planner's joint search (EmployeePlanner.recommend with `switches`).
 * DOM-free: rows() turns the plan into verdicts, render() into HTML with
 * the page's helpers, so the tab can move to a page of its own later.
 *
 * Verdicts:
 *   switch  the plan re-tools the company; it gains at the worse of today's
 *           margin and the game's average, after the minimum gain
 *   spike   it would pay at today's prices only, and today's margin is far
 *           above the game's average (ProductSwitchCore.SPIKE_RATIO)
 *   hold    it would pay at today's prices only, without a spike
 *   stay    no other good clears both prices
 *   off     the planner left the company out (plan.excluded) */
const EmployeeProducts = (() => {
  const PS = typeof module !== 'undefined' ? require('./product-switch-core.js') : ProductSwitchCore;
  const TOP = 3;

  /* companies: [{ id, product, disabled }] in getCompanies order.
   * plan: the page's planner result (EmployeeAssignments onResult): its
   * `products` ({ switches, holds }) and `excluded`.
   * market: { list, gameMargin }, for each good's margin at both prices.
   * Each row: { id, product, verdict, report, hold, now and target (the
   * current and the switched-to or held good's margins), alternatives: the TOP other goods by worse-of-two margin, each
   * { code, live, game, worse, ratio, spike } }. */
  function rows(companies, plan, market) {
    const sets = PS.priceSets(market || {}), products = plan?.products || { switches: [], holds: [] };
    const margin = code => ({ code, live: sets.live[code] ?? null, game: sets.game[code] ?? null, worse: sets.worse(code), ratio: sets.ratio(code), spike: sets.spike(code) });
    const codes = Object.keys(sets.worseSet).filter(code => sets.worse(code) != null);
    return companies.map(c => {
      const report = products.switches.find(w => w.company === c.id) || null;
      const hold = report ? null : products.holds.filter(h => h.company === c.id).sort((a, b) => b.live - a.live)[0] || null;
      const excluded = (plan?.excluded || []).find(x => x.company === c.id) || null;
      const verdict = report ? 'switch' : excluded ? 'off' : hold ? (hold.spike ? 'spike' : 'hold') : 'stay';
      const alternatives = codes.filter(code => code !== c.product).map(margin).sort((a, b) => b.worse - a.worse || (a.code < b.code ? -1 : 1)).slice(0, TOP);
      const to = report?.to || hold?.to;
      return { id: c.id, product: c.product, disabled: !!c.disabled, verdict, report, hold, excluded, now: margin(c.product), target: to ? margin(to) : null, alternatives };
    });
  }

  const VERDICT = {
    switch: ['Switch', 'tr-badge-switch'],
    spike: ['Spike: hold', 'tr-badge-spike'],
    hold: ['Hold', 'tr-badge-spike'],
    stay: ['Stay', 'tr-badge-stay'],
    off: ['Not planned', 'tr-badge-stay'],
  };
  const pct = v => `${Math.round(v * 100)}%`;
  const days = v => !Number.isFinite(v) ? 'never' : v <= 0 ? 'none' : v < 1 ? 'under a day' : `${Math.ceil(v)} day${Math.ceil(v) === 1 ? '' : 's'}`;

  /* h: the page's helpers.
   *   esc, company(id) (link HTML), colour(id), productIcon(code), productName(code)
   *   employee(id) → { name, company } (their company before the plan)
   *   companyName(id), today(id) (profit a day now, or null), tool(id) → { type, bonus }
   *   perDay(v), money(v), margin(v) (money per PP), tile(label, value, sub, id, tone) */
  function render(list, plan, h) {
    const dash = '<span class="tr-muted">—</span>';
    const name = code => h.esc(h.productName(code));
    const good = code => `${h.productIcon(code)} ${name(code)}`;
    const both = (live, game) => `${live == null ? dash : h.perDay(live)}${game == null ? '' : `<small>Game: ${h.perDay(game)}</small>`}`;
    const costs = r => {
      const w = r.report, out = [];
      if (w.cost) out.push(`${w.concrete} concrete, ${h.money(w.cost)} once`);
      for (const x of w.costs.ramp) {
        if (Math.abs(x.from - x.to) < 1e-9 && !x.movedIn) continue;
        const who = h.esc(h.employee(x.employee)?.name || 'An employee');
        out.push(x.movedIn ? `${who} moves in with ${+x.to.toFixed(1)}% saved on ${name(w.to)}`
          : `${who}: specialisation ${+x.from.toFixed(1)}% → ${+x.to.toFixed(1)}%${x.days ? `, ${days(x.days)} to regain` : ''}`);
      }
      for (const id of w.costs.toolsOff) {
        const t = h.tool(id);
        out.push(`${t ? `${h.esc(t.type[0].toUpperCase() + t.type.slice(1))} +${t.bonus}%` : 'A tool'} stops fitting and goes back to inventory`);
      }
      for (const x of w.costs.traits) {
        const traits = x.codes.map(c => ({ specialist: 'Specialist', craftsman: 'Craftsman', laborer: 'Laborer' })[c] || c).join(', ');
        out.push(`${h.esc(h.employee(x.employee)?.name || 'An employee')}${traits ? ` (${traits})` : ''}: trait Production ${x.from > 0 ? '+' : ''}${+x.from.toFixed(1)} → ${x.to > 0 ? '+' : ''}${+x.to.toFixed(1)}`);
      }
      return out;
    };
    const alternatives = r => r.alternatives.length ? `<ul class="tr-prod-alts">${r.alternatives.map(a =>
      `<li><span class="tr-prod-to">${good(a.code)}</span> <span>${a.live == null ? '—' : h.margin(a.live)}${a.game == null ? '' : ` · game ${h.margin(a.game)}`}${a.spike ? ' · <b class="tr-warn">spike</b>' : ''}</span></li>`).join('')}</ul>` : '';
    const body = list.map(r => {
      const [label, cls] = VERDICT[r.verdict], w = r.report, hd = r.hold;
      const to = w?.to || hd?.to;
      const now = r.now.live == null ? '' : `<small>Margin ${h.margin(r.now.live)}${r.now.game == null ? '' : ` · game ${h.margin(r.now.game)}`} per PP</small>`;
      let detail = '';
      if (w) {
        const items = costs(r);
        const moved = w.moves.map(id => { const e = h.employee(id); return `${h.esc(e?.name || 'An employee')}${e ? ` from ${h.esc(h.companyName(e.company))}` : ''}`; });
        detail = `${moved.length ? `<small>With ${moved.join(', ')} moved in</small>` : ''}
          <details class="tr-more"><summary>What it costs</summary>${items.length ? `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>` : '<p class="tr-muted">Nothing beyond the concrete.</p>'}
          <p class="tr-muted">Steps are on the Assignments tab.</p></details>`;
      } else if (hd) {
        const ratio = r.target.ratio;
        detail = `<small>${r.verdict === 'spike' ? `Today's margin is ${ratio != null ? `${ratio.toFixed(2)}×` : 'far above'} the game's average.` : 'Pays at today\'s prices only.'} At the game's prices it doesn't clear the minimum gain.</small>`;
      } else if (r.verdict === 'off') {
        detail = `<small>${h.esc(r.excluded.reason.replace(/^Not planned: /, ''))}</small>`;
      } else {
        detail = `<details class="tr-more"><summary>Best other goods</summary>${alternatives(r)}<p class="tr-muted">Per PP, before specialisation, traits and tools. None pays here at both prices.</p></details>`;
      }
      const gain = w ? both(w.gain.live, w.gain.game) : hd ? both(hd.gain.live, hd.gain.game) : dash;
      const be = w?.breakEven?.ratio != null
        ? `${pct(w.breakEven.ratio)}<small>of ${name(w.from)}'s margin per PP; now ${r.target.live != null && r.now.live > 0 ? pct(r.target.live / r.now.live) : '—'}</small>` : dash;
      return `<tr style="--co:${h.colour(r.id)}">
        <td data-label="Company"><strong>${h.company(r.id)}</strong><small>${good(r.product)}${r.disabled ? ' · disabled' : ''}</small>
          <small>Today ${h.today(r.id) == null ? '—' : h.perDay(h.today(r.id))}</small>${now}</td>
        <td data-label="Verdict" class="tr-prod-verdict"><span class="tr-badge ${cls}">${label}</span>${to ? ` <span class="tr-prod-to">→ ${good(to)}</span>` : ''}${detail}</td>
        <td data-label="Gain / day" class="num">${gain}</td>
        <td data-label="Payback" class="num">${w ? days(w.payback) : dash}</td>
        <td data-label="Break-even" class="num">${be}</td>
      </tr>`;
    }).join('');
    const switches = list.filter(r => r.verdict === 'switch'), held = list.filter(r => r.verdict === 'spike' || r.verdict === 'hold');
    const sum = k => switches.reduce((a, r) => a + r.report.gain[k], 0);
    return { switches: switches.length, html: `
      <div class="tr-tiles">
        ${h.tile('Switches', `${switches.length} recommended`, `of ${list.length} companies`)}
        ${h.tile('Gain', switches.length ? h.perDay(sum('live')) : '—', switches.length ? `Game: ${h.perDay(sum('game'))} · net of concrete over ${plan.days} days` : 'no switch pays at both prices', '', switches.length ? 'tr-pos' : '')}
        ${h.tile('Held', `${held.length}`, held.length ? 'pay at today\'s prices only' : 'no price spikes')}
      </div>
      <div class="tr-emps-wrap"><table class="tr-emps tr-prods">
        <thead><tr><th scope="col">Company</th><th scope="col">Verdict</th><th scope="col" class="num">Gain / day</th><th scope="col" class="num">Payback</th><th scope="col" class="num">Break-even</th></tr></thead>
        <tbody>${body}</tbody></table></div>` };
  }

  return { rows, render, TOP, VERDICT };
})();
if (typeof module !== 'undefined') module.exports = EmployeeProducts;
