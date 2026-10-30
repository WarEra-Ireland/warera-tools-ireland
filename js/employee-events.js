/* ═══════════════════════════════════════════════════════════════════
 *  EMPLOYEE EVENTS: what each choice does, and its expected value
 *
 *  The game API returns a pending event's choices with the server's
 *  chance, but not what they do; that is in the game's client config,
 *  kept as EMPLOYEE_EVENTS (js/employee-event-data.js). priceOption weighs
 *  a choice's outcomes by the chance, pricing each effect through a
 *  callback (the Training page prices them with EmployeeCore).
 * ═══════════════════════════════════════════════════════════════════ */
const EmployeeEvents = (() => {
  // A choice's expected value: its cost, plus each band's effects weighted
  // by the server's chance. Crits take a share of successes (critFails of
  // fails); with no crit outcome a crit counts as a success. valueOf(effect)
  // returns a value or null when it can't be priced.
  function priceOption(opt, chance, valueOf, { critShare = 0.1 } = {}) {
    const p = opt.check && chance != null ? (chance > 1 ? chance / 100 : chance) : 1;
    const pCrit = opt.hasCrit ? p * critShare : 0;
    const pCritFail = opt.hasCritFail && opt.check ? (1 - p) * critShare : 0;
    const weights = [[opt.cost, 1], [opt.always, 1], [opt.success, p - pCrit], [opt.crit, pCrit], [opt.fail, 1 - p - pCritFail], [opt.critFail, pCritFail]];
    const moneyCost = opt.cost.filter(e => e.kind === 'wageDays').reduce((a, e) => a - e.n, 0);
    let value = 0;
    const unpriced = [];
    for (const [effects, w] of weights) {
      if (!(w > 0)) continue;
      for (const e of effects) {
        const v = e.kind === 'costBack' ? valueOf({ kind: 'wageDays', n: moneyCost * e.mult, text: e.text }) : valueOf(e);
        if (v == null) { if (!unpriced.includes(e.text)) unpriced.push(e.text); } else value += w * v;
      }
    }
    return { value, unpriced, chance: opt.check ? p : null };
  }

  return { priceOption };
})();

if (typeof module !== 'undefined') module.exports = EmployeeEvents;
