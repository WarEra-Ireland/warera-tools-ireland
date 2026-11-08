//! Tool handoffs: who holds which tool when, across a set of companies'
//! members. A member keeps the tool they start with until it runs out or
//! they retire; a tool left over at a retirement, and every spare, goes to
//! whoever it is worth most to among those waiting for one of its type.
//! The planner (`Env::handoffs`) and card pricing and retention
//! (`Roster::handoffs`) both hand tools out this way.

use crate::project::Tool;

/// The handoffs' margin for equal hours.
const EPS: f64 = 1e-9;

/// A tool (by its index among the caller's tools) held from hour `from`
/// until `to`.
#[derive(Clone, Copy, PartialEq)]
pub struct ToolSpan {
    pub tool: usize,
    pub from: f64,
    pub to: f64,
}

/// A company's member as the handoffs read them.
pub trait Seated {
    /// The employee, by place: ties between equal offers go to the earlier.
    fn employee(&self) -> usize;
    /// The tool they hold from hour 0.
    fn tool(&self) -> Option<usize>;
}

/// What a tool is worth to a member of a working company.
#[derive(Clone, Copy)]
pub struct Need {
    /// The tool type the company's good takes.
    pub tool_type: u32,
    /// Hours to retirement.
    pub retire: f64,
    /// Profit per point of tool bonus: output per point of margin, times
    /// the margin.
    pub worth: f64,
    /// The bonus points their traits add to any tool.
    pub extra: f64,
    /// Whether `Timelines::contended` watches this member.
    pub watched: bool,
}

/// The tool timelines, by group and member, and whether a watched member
/// was weighed for a free tool.
pub struct Timelines {
    pub lines: Vec<Vec<Vec<ToolSpan>>>,
    pub contended: bool,
}

/// The tool timelines of `groups` (each a company's members) over `end`
/// hours, with `spares` (indices into `tool`) as the pool. `need` says what
/// a tool is worth to a group's member, or None where the company isn't
/// working: its members keep what they start with and are handed nothing.
///
/// Each round hands one tool to one member: the pair worth the most, then
/// between equal offers the earlier start, the longer tool, the earlier
/// tool and the earlier employee (by place).
pub fn handoffs<M: Seated>(
    end: f64,
    groups: &[&[M]],
    tool: impl Fn(usize) -> Tool,
    spares: impl Iterator<Item = usize>,
    mut need: impl FnMut(usize, &M) -> Option<Need>,
) -> Timelines {
    struct Spare {
        tool: usize,
        at: f64,
        left: f64,
        freed: bool,
        /// The tool's bonus, and the place in `by_type` of its type (past
        /// the end where nobody waits for that type).
        bonus: f64,
        of_type: usize,
    }
    struct Waiting {
        group: usize,
        member: usize,
        employee: usize,
        need: Need,
        /// When they need a tool from.
        from: f64,
        /// Past this hour a tool is no use to them: retirement or the end.
        until: f64,
        ran_out: bool,
        /// The place in `by_type` of the type they need.
        of_type: usize,
    }
    /// The waiting for one tool type, as runs of `ids` in waiting order:
    /// `all` of them, then the `ran_out`, each run with room for `size`.
    struct ByType {
        tool_type: u32,
        start: usize,
        size: usize,
        all: usize,
        ran_out: usize,
    }
    // After a segment: wait for the next tool, or hand this one back.
    fn settle(p: &mut Waiting, line: &mut [ToolSpan], pool: &mut Vec<Spare>, end: f64) -> bool {
        let Some(seg) = line.last_mut() else {
            return false;
        };
        let retire = p.need.retire;
        if seg.to < retire - EPS {
            if seg.to < end - EPS {
                p.from = seg.to;
                p.ran_out = true;
                return true;
            }
        } else if seg.to > retire + EPS && retire < end - EPS {
            pool.push(Spare {
                tool: seg.tool,
                at: retire,
                left: seg.to - retire,
                freed: true,
                bonus: 0.0,
                of_type: usize::MAX,
            });
            seg.to = retire;
        }
        false
    }
    let mut pool: Vec<Spare> = spares
        .filter_map(|t| {
            let hours = tool(t).hours;
            (hours > 0.0).then_some(Spare {
                tool: t,
                at: 0.0,
                left: hours,
                freed: false,
                bonus: 0.0,
                of_type: usize::MAX,
            })
        })
        .collect();
    let mut lines: Vec<Vec<Vec<ToolSpan>>> = groups
        .iter()
        .map(|members| {
            members
                .iter()
                .map(|m| {
                    m.tool().map_or_else(Vec::new, |t| {
                        vec![ToolSpan { tool: t, from: 0.0, to: tool(t).hours }]
                    })
                })
                .collect()
        })
        .collect();
    let mut waiting: Vec<Waiting> = Vec::new();
    for (g, members) in groups.iter().enumerate() {
        for (m, member) in members.iter().enumerate() {
            let Some(need) = need(g, member) else { continue };
            let mut p = Waiting {
                group: g,
                member: m,
                employee: member.employee(),
                need,
                from: 0.0,
                until: need.retire.min(end) - EPS,
                ran_out: false,
                of_type: usize::MAX,
            };
            if member.tool().is_none() || settle(&mut p, &mut lines[g][m], &mut pool, end) {
                waiting.push(p);
            }
        }
    }
    // A spare is weighed only against the waiting for its type, those whose
    // own tool ran out if it was free from the start, in the order a scan of
    // all the waiting would meet them. The waiting keep their places (ids);
    // one handed their last tool leaves the runs.
    let mut by_type: Vec<ByType> = Vec::new();
    for pi in 0..waiting.len() {
        let ty = waiting[pi].need.tool_type;
        let k = match by_type.iter().position(|x| x.tool_type == ty) {
            Some(k) => k,
            None => {
                by_type.push(ByType { tool_type: ty, start: 0, size: 0, all: 0, ran_out: 0 });
                by_type.len() - 1
            }
        };
        waiting[pi].of_type = k;
        by_type[k].size += 1;
    }
    let mut ids = vec![0; 2 * waiting.len()];
    let mut next = 0;
    for x in &mut by_type {
        x.start = next;
        next += 2 * x.size;
    }
    for (pi, p) in waiting.iter().enumerate() {
        let x = &mut by_type[p.of_type];
        ids[x.start + x.all] = pi;
        x.all += 1;
        if p.ran_out {
            ids[x.start + x.size + x.ran_out] = pi;
            x.ran_out += 1;
        }
    }
    let typed = |q: &mut Spare, by_type: &[ByType]| {
        let t = tool(q.tool);
        q.bonus = t.bonus;
        q.of_type = by_type.iter().position(|x| x.tool_type == t.tool_type).unwrap_or(usize::MAX);
    };
    for q in &mut pool {
        typed(q, &by_type);
    }
    let mut left = waiting.len();
    let mut contended = false;
    while !pool.is_empty() && left > 0 {
        // The best (pool, waiting) pair so far.
        let (mut best, mut best_gain, mut best_start): (Option<(usize, usize)>, f64, f64) =
            (None, EPS, 0.0);
        for (qi, q) in pool.iter().enumerate() {
            let Some(x) = by_type.get(q.of_type) else {
                continue;
            };
            let run = if q.freed {
                &ids[x.start..x.start + x.all]
            } else {
                &ids[x.start + x.size..x.start + x.size + x.ran_out]
            };
            for &pi in run {
                let p = &waiting[pi];
                let start = p.from.max(q.at);
                if start >= p.until {
                    continue;
                }
                if p.need.watched {
                    contended = true;
                }
                let gain = p.need.worth * (q.bonus + p.need.extra);
                let better = gain > best_gain + 1e-12
                    || best.is_some_and(|(bq, bp)| {
                        (gain - best_gain).abs() <= 1e-12
                            && (start < best_start - EPS
                                || (start - best_start).abs() <= EPS
                                    && (q.left > pool[bq].left + EPS
                                        || (q.left - pool[bq].left).abs() <= EPS
                                            && (q.tool, p.employee)
                                                < (pool[bq].tool, waiting[bp].employee)))
                    });
                if better {
                    best = Some((qi, pi));
                    best_gain = gain;
                    best_start = start;
                }
            }
        }
        let Some((qi, pi)) = best else { break };
        let q = pool.remove(qi);
        let (g, m) = (waiting[pi].group, waiting[pi].member);
        lines[g][m].push(ToolSpan { tool: q.tool, from: best_start, to: best_start + q.left });
        let (had_run_out, spares_before) = (waiting[pi].ran_out, pool.len());
        let x = &mut by_type[waiting[pi].of_type];
        if settle(&mut waiting[pi], &mut lines[g][m], &mut pool, end) {
            if !had_run_out {
                let run = &mut ids[x.start + x.size..x.start + x.size + x.ran_out + 1];
                let at = run[..run.len() - 1].iter().position(|&o| o > pi).unwrap_or(run.len() - 1);
                run.copy_within(at..run.len() - 1, at + 1);
                run[at] = pi;
                x.ran_out += 1;
            }
        } else {
            let run = &mut ids[x.start..x.start + x.all];
            if let Some(at) = run.iter().position(|&o| o == pi) {
                run.copy_within(at + 1.., at);
                x.all -= 1;
            }
            if had_run_out {
                let run = &mut ids[x.start + x.size..x.start + x.size + x.ran_out];
                if let Some(at) = run.iter().position(|&o| o == pi) {
                    run.copy_within(at + 1.., at);
                    x.ran_out -= 1;
                }
            }
            left -= 1;
        }
        for q in &mut pool[spares_before..] {
            typed(q, &by_type);
        }
    }
    Timelines { lines, contended }
}
