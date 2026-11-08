//! The planner's input checks (`validate`), the effects it can't reproduce
//! (`uncertainty`) and who may quit (`riskWarnings`). The facade turns the
//! results into text: each check is a kind plus the place of the company,
//! employee or tool it names (`EmployeePlanner`'s `VALIDATE_TEXT`).
//!
//! The checks read the values as they came, not as the projection reads
//! them: `Number.isFinite`/`Number.isInteger` don't convert, so the decode
//! keeps those facts (`snapshot::Company::valid_numbers`, `EmployeeCheck`)
//! beside the numbers.

use crate::planner::{Env, Placement, Plan, PlanCompany};
use crate::pricing::TOOL_TYPES;
use crate::project::{EmployeeRecord, intern_optional, string, truthy_string};
use crate::snapshot::{self, Snapshot};
use crate::traits::{ArgumentKind, Trait};
use serde::{Deserialize, Serialize};

/// What the input checks read besides the records.
#[derive(Default, Clone)]
pub struct Checks {
    /// `Number.isInteger(s.days)`.
    pub days_integer: bool,
    pub companies: Vec<CompanyCheck>,
    pub tools: Vec<ToolCheck>,
    pub employees: Vec<EmployeeCheck>,
}

#[derive(Default, Clone)]
pub struct CompanyCheck {
    /// `!!c.id`.
    pub id: bool,
    /// `Number.isFinite` of margin, bonus and tax and
    /// `Number.isInteger(c.capacity)`, as the `COMPANY_*` bits.
    pub valid_numbers: u8,
}

#[derive(Default, Clone)]
pub struct ToolCheck {
    pub id: bool,
    /// `t.holder` interned (0 when falsy), and the first employee with that id.
    pub holder: u32,
    pub holder_at: Option<usize>,
}

#[derive(Default, Clone)]
pub struct EmployeeCheck {
    pub id: bool,
    /// `Number.isFinite` of age, production, responsibility, wage, tenure,
    /// employedDays and climberRaise, as bits 0-6.
    pub finite: u8,
    /// `e.equipped?.id || null`, interned (0 for none).
    pub equipped: u32,
    pub traits: Vec<TraitCheck>,
}

#[derive(Default, Clone, Copy)]
pub struct TraitCheck {
    /// `t.revealed === false`.
    pub hidden: bool,
    /// `!!t.arg`.
    pub has_arg: bool,
}

pub(crate) const COMPANY_MARGIN: u8 = 1;
pub(crate) const COMPANY_BONUS: u8 = 2;
pub(crate) const COMPANY_TAX: u8 = 4;
pub(crate) const COMPANY_CAPACITY: u8 = 8;
const EMPLOYEE_STATS: u8 = 0b11_1111;
const EMPLOYEE_CLIMBER_RAISE: u8 = 1 << 6;

impl Checks {
    pub fn of(s: &Snapshot) -> Checks {
        Checks {
            days_integer: s.days_integer,
            companies: s
                .companies
                .iter()
                .map(|c| CompanyCheck { id: c.has_id, valid_numbers: c.valid_numbers })
                .collect(),
            tools: s
                .tools
                .iter()
                .map(|t| ToolCheck {
                    id: truthy_string(t.id),
                    holder: t.holder,
                    holder_at: if t.holder != 0 { s.first_employee(t.holder) } else { None },
                })
                .collect(),
            employees: s.employees.iter().map(|e| e.check.clone()).collect(),
        }
    }
}

/// An arrangement entry as the facade hands it over: `{ employee, company,
/// tool }` by id.
#[derive(Deserialize)]
pub struct Assignment {
    employee: Option<String>,
    company: Option<String>,
    tool: Option<String>,
}

/// An arrangement entry as `validate` looks it up: the first employee with
/// its id, the ids (interned; tool 0 when falsy) and the first tool with
/// its id.
pub struct ArrangementEntry {
    pub employee: Option<usize>,
    pub employee_id: u32,
    pub company: u32,
    pub tool: u32,
    pub tool_at: Option<usize>,
}

impl ArrangementEntry {
    /// The facade's arrangement on `s`.
    pub fn read(s: &Snapshot, arrangement: &[Assignment]) -> Vec<ArrangementEntry> {
        arrangement
            .iter()
            .map(|a| {
                let employee_id = intern_optional(a.employee.as_deref());
                let tool = intern_optional(a.tool.as_deref());
                let tool = if truthy_string(tool) { tool } else { 0 };
                ArrangementEntry {
                    employee: s.first_employee(employee_id),
                    employee_id,
                    company: intern_optional(a.company.as_deref()),
                    tool,
                    tool_at: if tool != 0 { s.first_tool(tool) } else { None },
                }
            })
            .collect()
    }
    /// An assignment (per employee: company place, tool place) as its entries.
    pub fn of(plan: &Plan, assignment: &[Placement]) -> Vec<ArrangementEntry> {
        assignment
            .iter()
            .enumerate()
            .map(|(e, placement)| ArrangementEntry {
                employee: Some(e),
                employee_id: plan.people[e].id,
                company: placement.company.map_or(0, |c| plan.companies[c].record.id),
                tool: placement.tool.map_or(0, |t| plan.tools[t].key_word as u32),
                tool_at: placement.tool,
            })
            .collect()
    }
}

/// `evaluate`'s assignment from the facade's arrangement: per employee, the
/// last entry with their id, its company (the first with the id) and tool
/// (the last with the id).
pub fn placements(s: &Snapshot, arrangement: &[Assignment]) -> Vec<Placement> {
    let entries: Vec<(u32, u32, u32)> = arrangement
        .iter()
        .map(|a| {
            let tool = intern_optional(a.tool.as_deref());
            (
                intern_optional(a.employee.as_deref()),
                intern_optional(a.company.as_deref()),
                if truthy_string(tool) { tool } else { 0 },
            )
        })
        .collect();
    s.employees
        .iter()
        .map(|e| {
            let entry = entries.iter().rev().find(|x| x.0 == e.record.id);
            Placement {
                company: entry.and_then(|x| s.first_company(x.1)),
                tool: entry.and_then(|x| if x.2 != 0 { s.last_tool(x.2) } else { None }),
            }
        })
        .collect()
}

/// What `validate` found: the message kind and, where it names one, the
/// place (`{ kind, place? }`, the kind by name; the facade has the text).
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", content = "place", rename_all = "camelCase")]
pub enum Problem {
    CompanyIds,
    EmployeeIds,
    ToolIds,
    Days,
    CompanyData(usize),
    EmployeeMissing(usize),
    EmployeeData(usize),
    ClimberRaise(usize),
    ToolData(usize),
    AssignOnce,
    Unknown,
    NotPlanned(usize),
    Locked(usize),
    Tool,
    Capacity(usize),
    Disabled(usize),
}

fn distinct(ids: impl Iterator<Item = u32>) -> usize {
    let mut v: Vec<u32> = ids.collect();
    v.sort_unstable();
    v.dedup();
    v.len()
}

/// The company at place `s` now (re-tooled or not).
fn current(env: &Env, s: usize) -> &PlanCompany {
    &env.plan.companies[env.company_at[s]]
}
/// A company id's place: the last company with it (`validate` reports
/// repeated ids).
fn slot_of(plan: &Plan, id: u32) -> Option<usize> {
    (0..plan.company_count).rev().find(|&s| plan.companies[s].record.id == id)
}
/// Whether employee `e` is in a company that isn't planned.
fn frozen(env: &Env, e: usize) -> bool {
    slot_of(&env.plan, env.plan.people[e].company).is_some_and(|s| current(env, s).excluded)
}

/// `validate(s, arrangement)` on the snapshot as `env` sees it (re-tooled
/// companies in their places): ids, days, the data (`data_problems`), then
/// the arrangement, capacities and disabled companies.
pub fn validate(env: &Env, arrangement: &[ArrangementEntry]) -> Vec<Problem> {
    use Problem::*;
    let plan = &env.plan;
    let checks = &plan.checks;
    let (company_count, employee_count, tool_count) =
        (plan.company_count, plan.people.len(), plan.tool_count);
    let mut out = Vec::new();
    let current = |s: usize| current(env, s);
    let slot_of = |id: u32| slot_of(plan, id);
    let frozen = |e: usize| frozen(env, e);
    let unique = |ok: &dyn Fn(usize) -> bool, ids: &dyn Fn(usize) -> u32, n: usize| {
        (0..n).all(ok) && distinct((0..n).map(ids)) == n
    };
    if !unique(&|s| checks.companies[s].id, &|s| plan.companies[s].record.id, company_count) {
        out.push(CompanyIds);
    }
    if !unique(&|e| checks.employees[e].id, &|e| plan.people[e].id, employee_count) {
        out.push(EmployeeIds);
    }
    if !unique(&|t| checks.tools[t].id, &|t| plan.tools[t].key_word as u32, tool_count) {
        out.push(ToolIds);
    }
    if !(checks.days_integer && (1.0..=47.0).contains(&plan.days)) {
        out.push(Days);
    }
    out.extend(data_problems(env));
    if arrangement.len() != employee_count
        || distinct(arrangement.iter().map(|a| a.employee_id)) != arrangement.len()
    {
        out.push(AssignOnce);
    }
    let mut used: Vec<u32> = Vec::new();
    for a in arrangement {
        let (Some(e), Some(s)) = (a.employee, slot_of(a.company)) else {
            out.push(Unknown);
            continue;
        };
        let c = current(s);
        let home = plan.people[e].company;
        let equipped = checks.employees[e].equipped;
        if (frozen(e) || c.excluded) && (a.company != home || a.tool != equipped) {
            out.push(NotPlanned(s));
        }
        if plan.locked[e] && a.company != home {
            out.push(Locked(e));
        }
        if a.tool == 0 {
            continue;
        }
        let bad = match a.tool_at {
            None => true,
            Some(t) => {
                let h = &checks.tools[t];
                used.contains(&a.tool)
                    || (!env.compatible(t, env.company_at[s])
                        && (a.company != home || a.tool != equipped))
                    || (h.holder != 0
                        && h.holder_at.is_some_and(frozen)
                        && h.holder != plan.people[e].id)
            }
        };
        if bad {
            out.push(Tool);
        }
        used.push(a.tool);
    }
    for s in 0..company_count {
        let id = plan.companies[s].record.id;
        if arrangement.iter().filter(|a| a.company == id).count() as f64 > current(s).capacity {
            out.push(Capacity(s));
        }
    }
    for s in 0..company_count {
        let id = plan.companies[s].record.id;
        if current(s).record.disabled
            && arrangement.iter().filter(|a| a.company == id).count()
                > (0..employee_count).filter(|&e| plan.people[e].company == id).count()
        {
            out.push(Disabled(s));
        }
    }
    out
}

/// What `validate` finds missing from the input's data, in its order:
/// companies (type, margin, bonus, tax, capacity), employees (a company,
/// their stats, a Climber's raise) and tools (type, bonus, hours), each
/// only where it is planned. A number the projection reads is known
/// wherever this finds nothing (`numbers_known`).
pub fn data_problems(env: &Env) -> Vec<Problem> {
    use Problem::*;
    let plan = &env.plan;
    let checks = &plan.checks;
    let (company_count, employee_count, tool_count) =
        (plan.company_count, plan.people.len(), plan.tool_count);
    let mut out = Vec::new();
    let current = |s: usize| current(env, s);
    let slot_of = |id: u32| slot_of(plan, id);
    let frozen = |e: usize| frozen(env, e);
    for s in 0..company_count {
        let c = current(s);
        let bits = checks.companies[s].valid_numbers;
        // A re-tooled company's margin is known: `retool` makes none without.
        let margin = env.company_at[s] != s || bits & COMPANY_MARGIN != 0;
        let typed =
            matches!(c.record.item_type_text.as_deref(), Some("raw" | "product" | "weapon"));
        if !c.excluded
            && (!typed
                || !margin
                || bits & COMPANY_BONUS == 0
                || bits & COMPANY_TAX == 0
                || bits & COMPANY_CAPACITY == 0
                || c.capacity < 1.0)
        {
            out.push(CompanyData(s));
        }
    }
    for e in 0..employee_count {
        if slot_of(plan.people[e].company).is_none() {
            out.push(EmployeeMissing(e));
            continue;
        }
        if frozen(e) {
            continue;
        }
        if checks.employees[e].finite & EMPLOYEE_STATS != EMPLOYEE_STATS {
            out.push(EmployeeData(e));
        }
        if plan.has(e, Trait::Climber) && checks.employees[e].finite & EMPLOYEE_CLIMBER_RAISE == 0 {
            out.push(ClimberRaise(e));
        }
    }
    for t in 0..tool_count {
        let x = &plan.tools[t];
        let holder = if checks.tools[t].holder != 0 { checks.tools[t].holder_at } else { None };
        if holder.is_some_and(frozen) {
            continue;
        }
        let known =
            string(x.tool_type).is_some_and(|ty| TOOL_TYPES.iter().any(|(t, _)| *t == &*ty));
        if !known || !(3.0..=65.0).contains(&x.bonus) || !(0.0..=10000.0).contains(&x.hours) {
            out.push(ToolData(t));
        }
    }
    out
}

/// What an export that projects says when `numbers_known` fails.
pub const UNKNOWN_NUMBERS: &str = "Numbers the planner needs are missing (validate reports them).";

/// Whether every number the projection reads is known where `env` plans:
/// the exports that project check this first, so the projection never
/// reads one `validate` reports missing.
pub fn numbers_known(env: &Env) -> bool {
    data_problems(env).is_empty()
}

/// Why the planner can't reproduce an employee's company.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UncertaintyKind {
    /// A hidden trait.
    Hidden,
    /// A trait the planner doesn't know.
    Unknown,
    /// A trait without its stat or partner.
    MissingArgument,
}

/// An employee the planner can't reproduce (by place in the snapshot), why,
/// and the trait (by place in their traits): `{ employee, kind, trait }`.
#[derive(Serialize)]
pub struct Uncertainty {
    pub employee: usize,
    pub kind: UncertaintyKind,
    #[serde(rename = "trait")]
    pub trait_index: usize,
}

/// `uncertainty(e)` of every employee, in snapshot order: the first trait
/// that keeps the planner from reproducing their company, for those with one.
pub fn uncertainties(snapshot: &Snapshot) -> Vec<Uncertainty> {
    snapshot.employees.iter().enumerate().filter_map(|(i, e)| uncertainty(i, e)).collect()
}

fn uncertainty(employee: usize, e: &snapshot::Employee) -> Option<Uncertainty> {
    for (i, (t, check)) in e.record.traits.iter().zip(&e.check.traits).enumerate() {
        let found = |kind| Some(Uncertainty { employee, kind, trait_index: i });
        if check.hidden {
            return found(UncertaintyKind::Hidden);
        }
        let Some(id) = t.id else { return found(UncertaintyKind::Unknown) };
        let r = id.rule();
        if (r.arg != ArgumentKind::None || r.partner) && !check.has_arg {
            return found(UncertaintyKind::MissingArgument);
        }
    }
    None
}

/// `riskWarnings`' rule: someone without Anchor whose happiness reaches
/// below 30 (50 with Flight Risk) may quit.
pub fn may_quit(e: &EmployeeRecord, min_happiness: f64) -> bool {
    let has = |t: Trait| e.traits.iter().any(|x| x.id == Some(t));
    !has(Trait::Anchor) && min_happiness < if has(Trait::FlightRisk) { 50.0 } else { 30.0 }
}
