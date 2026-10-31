/* Management points and the Irish buddy pool. */
const ManagerCore = (() => {
  const MAX_POINTS = 11;
  const points = user => Math.min(MAX_POINTS, Math.max(1, user.skills?.management?.total ?? 1));

  /*
   *  The Irish buddy pool. Any Irish player can have a buddy on each of
   *  their companies while managing just one company themselves. `owners`
   *  maps every Irish citizen to their company IDs and `managers` maps a
   *  company ID to its manager contract (or null). Any Irish manager is a
   *  buddy, whatever the wage; every other company is an open slot. `job` is
   *  the Irish company a player manages.
   */
  function pool({ owners, managers }) {
    const players = new Map([...owners].map(([id, companies]) =>
      [id, { id, companies: companies.length, buddies: [], openSlots: companies.length, job: null }]));
    for (const [owner, companies] of owners) {
      const player = players.get(owner);
      for (const companyId of companies) {
        const contract = managers.get(companyId);
        const manager = contract && players.get(contract.user);
        if (!manager) continue;
        manager.job = { company: companyId, employer: owner };
        player.buddies.push(manager.id);
      }
      player.openSlots = player.companies - player.buddies.length;
    }
    return players;
  }

  // Manager jobs unlock at level 10, and a player holds one at a time.
  const canManage = p => p.user.leveling?.level >= 10 && !p.job;

  // Most open slots first, so players who need buddies most are offered
  // first; then players free to manage, higher Management, username.
  const rankRoster = (a, b) => b.openSlots - a.openSlots
    || Number(canManage(b)) - Number(canManage(a))
    || points(b.user) - points(a.user)
    || a.user.username.localeCompare(b.user.username);

  return { points, pool, canManage, rankRoster };
})();
if (typeof module !== 'undefined') module.exports = ManagerCore;
