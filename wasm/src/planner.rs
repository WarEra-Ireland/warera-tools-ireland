//! The planner (`EmployeePlanner.evaluate`, `recommend`, the stat check of
//! `withExclusions`).
//!
//! `Plan` is the decoded snapshot (snapshot.rs) as the planner reads it:
//! each employee and company as the projection reads them, plus what the
//! planner looks up besides (ids, places, tools, saved days per good,
//! observed stats). `Env` is the snapshot as a search
//! sees it (each company's current good, tool holders) with the projector:
//! its cache, the class repricing of re-tooled companies and the counters
//! the search budget reads. `Search` is `recommend`'s best-improvement loop,
//! resumable a round at a time (`step`), so the facade keeps `onProgress`.
//!
//! Keys are typed values of what the cached value depends on. A projection
//! key is words: the company and its good, each member, the tool spans they
//! hold (a tool held from hour 0 and a timeline whose first span starts at 0
//! are the same: settling a span only shortens it past retirement), the
//! saved days of a re-tooled company's members, the margin and the switch
//! cost, numbers by their bits. A candidate's key (`CandidateKey`) is the
//! change by places and tool classes (tools of one class are
//! interchangeable). Employees, companies and tools go in snapshot order,
//! and ties break on it: the earlier candidate, tool or employee.
//!
//! `recommend`'s output-only comparison is here too (`output_only`, or a
//! `Comparison` searched alongside the main search in another worker). The
//! input checks are in check.rs; what stays JS is their text, the notes,
//! warnings and names.

use crate::check::{self, ArrangementEntry, Checks, Problem, validate};
use crate::handoffs::{self, Need, Seated, Timelines, ToolSpan};
use crate::hash::FastMap;
use crate::model::known;
use crate::project::{
    self, CallProjector, CompanyRecord, EmployeeRecord, IndexRange, Member, MemberTotals,
    RetoolMember, Retooling, Row, Segment, Tool, ToolSource, Who, good_production_of, intern,
    string, working_days,
};
use crate::snapshot::{Observed, SavedDays, Snapshot, Truthy};
use crate::sort::{sort_list, sort_places};
use crate::switch::{SwitchContext, SwitchInput, payback, saved_specialization};
use crate::traits::Trait;
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::cell::RefCell;
use std::rc::Rc;

/// `CHURN`: the minimum gain.
pub mod churn {
    pub const PRICE_UNCERTAINTY: f64 = 0.05;
    pub const FLOOR_SHARE: f64 = 0.002;
    pub const FLOOR_MIN: f64 = 1.0;
    pub const RECENT_HOURS: f64 = 72.0;
    pub const RECENT_FACTOR: f64 = 3.0;
}

/// `toolTypeOf` of a good with no tool type: null, which no tool's type is.
const NULL: u32 = u32::MAX;

fn id_text(x: u32) -> Rc<str> {
    string(x).unwrap_or_else(|| "undefined".into())
}

/// `TOOL_OF[product]`, interned; 0 when the good takes no tool.
pub fn tool_type_id(product: u32) -> u32 {
    string(product).and_then(|p| crate::pricing::tool_type_of(&p)).map_or(0, intern)
}

// --- The snapshot ---

#[derive(Clone, Copy, PartialEq)]
pub enum Holder {
    Free,
    Employee(usize),
    Missing,
}

/// A tool: id (text and key word), type (interned, 0 undefined), bonus,
/// hours, holder, and its class (`Plan::class_tools`).
#[derive(Clone)]
pub struct PlanTool {
    pub id: Rc<str>,
    pub key_word: u64,
    pub tool_type: u32,
    pub bonus: f64,
    pub hours: f64,
    pub holder: Holder,
    class: usize,
}

/// A company as a plan sees it: the snapshot's record, or one re-tooled
/// onto another good (`switch`), which keeps its place (`slot`).
#[derive(Clone)]
pub struct PlanCompany {
    pub slot: usize,
    pub id: Rc<str>,
    /// The company as the projection reads it.
    pub record: CompanyRecord,
    pub item_type: u32,
    pub excluded: bool,
    pub capacity: f64,
    pub switched_age: f64,
    /// `switch.from` / `switch.fromType` (0 without a switch).
    pub from: u32,
    pub from_type: u32,
    /// `switch.cost` (None: null) and `switch.concrete`.
    pub cost: Option<f64>,
    pub concrete: f64,
}
impl PlanCompany {
    /// `company.switch?.cost || 0`.
    fn switch_cost(&self) -> f64 {
        self.record.switch_cost
    }
    /// `toolTypeOf(company.product)`: NULL for none.
    fn tool_type_of(&self) -> u32 {
        if self.record.tool_type == 0 { NULL } else { self.record.tool_type }
    }
}

/// The snapshot as the planner reads it (`Plan::new`).
pub struct Plan {
    pub days: f64,
    pub hours: Option<f64>,
    pub quota: f64,
    pub management: f64,
    pub toolbox: f64,
    pub people: Vec<EmployeeRecord>,
    pub employee_ids: Vec<Rc<str>>,
    /// The employee's company (first with its id), if any.
    pub company_of: Vec<Option<usize>>,
    pub locked: Vec<bool>,
    pub equipped: Vec<Option<usize>>,
    /// `e.specializations`, per employee.
    saved_days: Vec<Vec<SavedDays>>,
    /// What the game reports, per employee.
    pub observed: Vec<Option<Observed>>,
    /// The companies: the snapshot's first (by place), then re-tooled ones.
    pub companies: Vec<PlanCompany>,
    pub company_count: usize,
    pub tools: Vec<PlanTool>,
    /// Real tools (synthetic ones for bounds come after).
    pub tool_count: usize,
    /// Per class (tools of one type, bonus and hours), its first tool.
    class_tools: Vec<usize>,
    /// How many employees each place has now.
    current_size: Vec<f64>,
    /// What the input checks read besides (check.rs).
    pub checks: Checks,
}

impl Plan {
    /// The snapshot as the planner reads it.
    pub fn new(s: &Snapshot) -> Plan {
        let company_count = s.companies.len();
        let companies = s
            .companies
            .iter()
            .enumerate()
            .map(|(slot, c)| PlanCompany {
                slot,
                id: id_text(c.record.id),
                record: c.record.clone(),
                item_type: c.item_type,
                excluded: c.excluded,
                capacity: c.capacity,
                switched_age: c.switched_age_hours,
                from: c.switch_from,
                from_type: c.switch_from_type,
                cost: c.record.switched.then_some(c.record.switch_cost),
                concrete: 0.0,
            })
            .collect();
        let mut class_tools: Vec<usize> = Vec::new();
        let tools: Vec<PlanTool> = s
            .tools
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let same = |u: &usize| {
                    let u = &s.tools[*u].tool;
                    (u.tool_type, u.bonus.to_bits(), u.hours.to_bits())
                        == (t.tool.tool_type, t.tool.bonus.to_bits(), t.tool.hours.to_bits())
                };
                let class = class_tools.iter().position(same).unwrap_or_else(|| {
                    class_tools.push(i);
                    class_tools.len() - 1
                });
                PlanTool {
                    id: id_text(t.id),
                    key_word: t.id as u64,
                    tool_type: t.tool.tool_type,
                    bonus: t.tool.bonus,
                    hours: t.tool.hours,
                    holder: if t.holder == 0 {
                        Holder::Free
                    } else {
                        s.last_employee(t.holder).map_or(Holder::Missing, Holder::Employee)
                    },
                    class,
                }
            })
            .collect();
        let employee_count = s.employees.len();
        let mut plan = Plan {
            days: s.days,
            hours: s.hours,
            quota: s.training_quota,
            management: s.management,
            toolbox: s.toolbox_value,
            people: Vec::with_capacity(employee_count),
            employee_ids: Vec::with_capacity(employee_count),
            company_of: Vec::with_capacity(employee_count),
            locked: Vec::with_capacity(employee_count),
            equipped: Vec::with_capacity(employee_count),
            saved_days: Vec::with_capacity(employee_count),
            observed: Vec::with_capacity(employee_count),
            companies,
            company_count,
            tool_count: tools.len(),
            tools,
            class_tools,
            current_size: vec![0.0; company_count],
            checks: Checks::of(s),
        };
        for e in &s.employees {
            plan.people.push(e.record.clone());
            plan.employee_ids.push(id_text(e.record.id));
            plan.company_of.push(s.first_company(e.record.company));
            plan.locked.push(e.locked);
            plan.equipped.push(s.last_tool(e.equipped));
            plan.saved_days.push(e.specializations.clone().unwrap_or_default());
            plan.observed.push(e.observed);
        }
        for company in plan.company_of.iter().flatten() {
            plan.current_size[*company] += 1.0;
        }
        plan
    }

    pub fn has(&self, e: usize, t: Trait) -> bool {
        self.people[e].traits.iter().any(|x| x.id == Some(t))
    }
}

/// Places in their own order.
fn by_place(a: usize, b: usize) -> std::cmp::Ordering {
    a.cmp(&b)
}

/// Where an employee works and the tool they hold, as places in the plan;
/// an assignment has one per employee.
#[derive(Clone, Copy)]
pub struct Placement {
    /// The company's place, if any.
    pub company: Option<usize>,
    pub tool: Option<usize>,
}

// --- Members, keys and projections ---

/// A company's member: employee, tool held from hour 0, and (once tools
/// are handed out) the timeline.
#[derive(Clone)]
pub struct PlanMember {
    pub employee: usize,
    pub tool: Option<usize>,
    pub line: Option<Rc<[ToolSpan]>>,
}

impl Seated for PlanMember {
    fn employee(&self) -> usize {
        self.employee
    }
    fn tool(&self) -> Option<usize> {
        self.tool
    }
}

/// A projection key (see the module notes): its words, the first
/// `class_len` of which are the class (`classOf`).
#[derive(Clone, PartialEq)]
pub struct Key {
    words: Rc<[u64]>,
    class_len: usize,
}

/// A projection, with the call that made it (for its rows).
pub struct Projection {
    pub value: f64,
    pub production_points: f64,
    daily: Vec<f64>,
    /// By member.
    totals: Vec<MemberTotals>,
    /// A re-tooled company's terms for repricing others of its class.
    retooling: Option<Retooling>,
    company: usize,
    members: Vec<PlanMember>,
}
impl Projection {
    fn valuation(&self) -> Valuation {
        Valuation { value: self.value, production_points: self.production_points }
    }
}

/// A planned company's members under an assignment.
pub struct CompanyGroup {
    pub company: usize,
    pub members: Vec<PlanMember>,
    /// Whether these are the company's current members (only their tool
    /// timelines can change).
    same_members: bool,
}

/// What a tool's worth to an employee in a company comes from (`needs_of`).
#[derive(Clone, Copy)]
struct Needs {
    /// Hours to retirement.
    retirement: f64,
    /// Output per point of margin.
    output_per_margin: f64,
    /// The trait points a tool adds.
    tool_trait_bonus: f64,
}

/// `e`'s hours to retirement, output per point of margin and the trait
/// points a tool adds in `company`, kept in `cache`. In a re-tooled
/// company the good's traits count as they would there.
fn needs_of(
    plan: &Plan,
    company_at: &[usize],
    cache: &mut FastMap<(usize, u32, u32, bool), Needs>,
    e: usize,
    company: usize,
) -> Needs {
    let c = &plan.companies[company];
    let key = (e, c.record.product, c.item_type, c.record.switched);
    if let Some(&n) = cache.get(&key) {
        return n;
    }
    let person = &plan.people[e];
    let mut trait_production = person.trait_production;
    if c.record.switched {
        let (from_product, from_type) =
            match plan.company_of[e].map(|s| &plan.companies[company_at[s]]) {
                Some(home) if home.record.switched => (home.from, home.from_type),
                Some(home) => (home.record.product, home.item_type),
                None => (0, 0),
            };
        trait_production += good_production_of(person, c.record.product, c.item_type)
            - good_production_of(person, from_product, from_type);
    }
    let extra = person.traits.iter().fold(0.0, |v, t| {
        v + match t.id {
            Some(Trait::Handy) => 40.0,
            Some(Trait::Improviser) => -25.0,
            _ => 0.0,
        }
    });
    let n = Needs {
        retirement: working_days(person) * 24.0,
        output_per_margin: (person.production + trait_production) / 4.0,
        tool_trait_bonus: extra,
    };
    cache.insert(key, n);
    n
}

/// The first projection of a class, and the margin and switch cost it was
/// made at: what `P.value` prices the class's other keys from.
#[derive(Clone)]
struct ClassSample {
    projection: Rc<Projection>,
    margin: f64,
    switch_cost: f64,
}

/// A company's value and PP (production points).
#[derive(Clone, Copy)]
pub struct Valuation {
    pub value: f64,
    pub production_points: f64,
}

/// Days saved on a good, set for one employee (`switch::InPlace`).
#[derive(Clone, Copy)]
pub struct SavedDaysOverride {
    pub employee: usize,
    pub product: u32,
    pub days: f64,
}

/// `withExclusions`' stat check: a member whose rebuilt stats differ from
/// the game's, `{ company, employee }` by place in the snapshot.
#[derive(Clone, Copy, Serialize)]
pub struct Mismatch {
    pub company: usize,
    pub employee: usize,
}

/// The snapshot as a plan sees it, and the projector.
pub struct Env {
    pub plan: Plan,
    /// Each place's company now (`s.companies`, re-tooled ones in place).
    pub company_at: Vec<usize>,
    /// Days saved on a good set for one employee (`switch::InPlace`).
    saved_days_overrides: Vec<SavedDaysOverride>,
    needs_cache: FastMap<(usize, u32, u32, bool), Needs>,
    /// The companies being planned (places).
    pub planned: Vec<usize>,
    is_planned: Vec<bool>,
    /// Hours projected: `s.hours ?? s.days * 24`.
    end: f64,
    match_id: u32,
    cache: FastMap<Rc<[u64]>, Rc<Projection>>,
    classes: FastMap<Box<[u64]>, ClassSample>,
    priced: FastMap<Rc<[u64]>, Valuation>,
    pub misses: f64,
    pub priced_count: f64,
    work: CallProjector,
    last_company: Option<usize>,
}

/// A tool a member takes over after hour 0, and when.
pub struct Handoff {
    tool: Rc<str>,
    from: f64,
    to: f64,
}

/// A member's tool spans after hour 0, for its row.
struct LaterSpans {
    employee: usize,
    spans: Vec<ToolSpan>,
}

/// A totals row, as `totals` returns it.
pub struct TotalsRow {
    row: Row,
    id: Rc<str>,
    company: Rc<str>,
    tool: Option<Rc<str>>,
    /// `parts.company`: the company's bonus.
    company_bonus: f64,
    value: f64,
    training: f64,
    min_happiness: f64,
    handoffs: Vec<Handoff>,
}

/// A planned company's value and PP.
pub struct CompanyValue {
    pub id: Rc<str>,
    pub value: f64,
    pub production_points: f64,
}

pub struct Totals {
    pub value: f64,
    pub daily: Vec<f64>,
    pub employees: Vec<TotalsRow>,
    pub by_company: Vec<CompanyValue>,
}

impl Env {
    pub fn new(plan: Plan) -> Env {
        let company_at: Vec<usize> = (0..plan.company_count).collect();
        let planned: Vec<usize> =
            (0..plan.company_count).filter(|&i| !plan.companies[i].excluded).collect();
        let mut is_planned = vec![false; plan.company_count];
        for &p in &planned {
            is_planned[p] = true;
        }
        let end = plan.hours.unwrap_or(plan.days * 24.0);
        Env {
            plan,
            company_at,
            saved_days_overrides: Vec::new(),
            needs_cache: FastMap::default(),
            planned,
            is_planned,
            end,
            match_id: intern("match"),
            cache: FastMap::default(),
            classes: FastMap::default(),
            priced: FastMap::default(),
            misses: 0.0,
            priced_count: 0.0,
            work: CallProjector::default(),
            last_company: None,
        }
    }

    /// A new, empty projector (each `evaluate` makes its own).
    pub fn reset_projector(&mut self) {
        self.cache.clear();
        self.classes.clear();
        self.priced.clear();
        self.misses = 0.0;
        self.priced_count = 0.0;
    }

    /// `e.specializations[product] || 0`.
    pub fn saved_days(&self, e: usize, product: u32) -> f64 {
        if let Some(o) =
            self.saved_days_overrides.iter().find(|o| o.employee == e && o.product == product)
        {
            return o.days;
        }
        self.plan.saved_days[e].iter().rev().find(|s| s.product == product).map_or(0.0, |s| s.days)
    }
    pub fn set_saved_days_overrides(&mut self, list: Vec<SavedDaysOverride>) {
        self.saved_days_overrides = list;
    }

    /// The company with this id, as it is now: the last one when ids repeat
    /// (`validate` reports that).
    pub fn company_by_id(&self, id: &str) -> &PlanCompany {
        let slot = (0..self.plan.company_count)
            .rev()
            .find(|&s| &*self.plan.companies[s].id == id)
            .unwrap_or(0);
        &self.plan.companies[self.company_at[slot]]
    }

    /// `compatible(tool, company)`.
    pub fn compatible(&self, tool: usize, company: usize) -> bool {
        self.plan.companies[company].record.tool_type == self.plan.tools[tool].tool_type
    }

    /// The tool timelines of `groups`, by group and member, with `spares` as
    /// the pool (`handoffs::handoffs`); and whether a member of `watch` was
    /// weighed for a free tool.
    pub fn handoffs(
        &mut self,
        companies: &[usize],
        members: &[&[PlanMember]],
        spares: &[usize],
        watch: Option<usize>,
    ) -> Timelines {
        let end = self.plan.days * 24.0;
        let (plan, company_at, cache) = (&self.plan, &self.company_at, &mut self.needs_cache);
        let tool = |t: usize| {
            let x = &plan.tools[t];
            Tool { tool_type: x.tool_type, bonus: x.bonus, hours: x.hours }
        };
        let need = |g: usize, m: &PlanMember| {
            let company = companies[g];
            let c = &plan.companies[company];
            if c.record.disabled {
                return None;
            }
            let needs = needs_of(plan, company_at, cache, m.employee, company);
            Some(Need {
                tool_type: c.record.tool_type,
                retire: needs.retirement,
                worth: needs.output_per_margin * c.record.margin,
                extra: needs.tool_trait_bonus,
                watched: Some(c.slot) == watch,
            })
        };
        handoffs::handoffs(end, members, tool, spares.iter().copied(), need)
    }

    /// The projection key of `company` with `members` (see the module notes).
    pub fn key(&self, company: usize, members: &[PlanMember]) -> Key {
        let mut words = Vec::with_capacity(8 + members.len() * 6);
        let class_len = self.key_words(company, members, &mut words);
        Key { words: words.into(), class_len }
    }

    /// `key`'s words, written into `words`, and the length of its class.
    pub fn key_words(&self, company: usize, members: &[PlanMember], words: &mut Vec<u64>) -> usize {
        // Words that mark a Specialist, a raw or product trait, a tool that
        // fits or doesn't, and a member's end.
        const S: u64 = 1;
        const R: u64 = 2;
        const P: u64 = 3;
        const PLUS: u64 = 4;
        const MINUS: u64 = 5;
        const END: u64 = 6;
        let c = &self.plan.companies[company];
        words.clear();
        words.push(c.record.id as u64);
        // goodKey
        if !c.record.switched {
            words.extend([0, c.record.product as u64]);
        } else {
            words.extend([1, c.record.engine_bonus.to_bits()]);
            let raw = c.record.item_type_text.as_deref() == Some("raw");
            for m in members {
                for t in &self.plan.people[m.employee].traits {
                    match t.id {
                        Some(Trait::Specialist) => {
                            if t.arg == c.record.product || t.arg == self.match_id {
                                words.push(S)
                            }
                        }
                        Some(Trait::Craftsman | Trait::Laborer) => {
                            words.push(if raw { R } else { P })
                        }
                        _ => {}
                    }
                }
                let mark = |t: usize| if self.compatible(t, company) { PLUS } else { MINUS };
                match &m.line {
                    Some(line) => {
                        for x in line.iter() {
                            words.push(mark(x.tool))
                        }
                    }
                    None => {
                        if let Some(t) = m.tool {
                            words.push(mark(t))
                        }
                    }
                }
                words.push(END);
            }
        }
        // memberKey per member: the employee, then segments; a tool held from
        // hour 0 keys as a timeline starting at 0 does.
        words.push(members.len() as u64);
        for m in members {
            words.push(self.plan.people[m.employee].id as u64);
            match &m.line {
                None => match m.tool {
                    Some(t) => words.extend([1, 0, self.plan.tools[t].key_word]),
                    None => words.push(0),
                },
                Some(line) => {
                    words.push(line.len() as u64);
                    for x in line.iter() {
                        let key_word = self.plan.tools[x.tool].key_word;
                        if x.from != 0.0 {
                            words.extend([1, key_word, x.from.to_bits(), x.to.to_bits()]);
                        } else {
                            words.extend([0, key_word]);
                        }
                    }
                }
            }
        }
        let class_len = words.len();
        if c.record.switched {
            for m in members {
                words.push(self.saved_days(m.employee, c.record.product).to_bits());
            }
        }
        words.push(c.record.margin.to_bits());
        words.push(c.switch_cost().to_bits());
        class_len
    }

    fn call(&mut self, company: usize, members: &[PlanMember]) {
        if self.last_company != Some(company) {
            self.work.call.company = self.plan.companies[company].record.clone();
            self.last_company = Some(company);
        }
        let slot = self.plan.companies[company].slot;
        let product = self.plan.companies[company].record.product;
        let saved: Vec<f64> =
            members.iter().map(|m| self.saved_days(m.employee, product)).collect();
        let call = &mut self.work.call;
        call.end = self.end;
        call.training_quota = self.plan.quota;
        call.management = self.plan.management;
        call.toolbox_value = self.plan.toolbox;
        call.current_size = self.plan.current_size[slot];
        call.members.clear();
        call.segments.clear();
        for (k, m) in members.iter().enumerate() {
            let line = m.line.as_ref().map(|line| {
                let start = call.segments.len();
                for x in line.iter() {
                    let t = &self.plan.tools[x.tool];
                    call.segments.push(Segment {
                        tool_type: t.tool_type,
                        bonus: t.bonus,
                        from: x.from,
                        to: x.to,
                    });
                }
                IndexRange { start, count: line.len() }
            });
            let tool = m.tool.map(|t| {
                let t = &self.plan.tools[t];
                Tool { tool_type: t.tool_type, bonus: t.bonus, hours: t.hours }
            });
            call.members.push(Member {
                who: Who::Snapshot(m.employee),
                saved: saved[k],
                tool,
                line,
            });
        }
    }

    fn run(&mut self, company: usize, members: &[PlanMember]) -> Projection {
        self.call(company, members);
        let out = self.work.run(&self.plan.people, &[]);
        Projection {
            value: out.value,
            production_points: out.production_points,
            daily: out.daily.clone(),
            totals: out.members.clone(),
            retooling: out.retooling().cloned(),
            company,
            members: members.to_vec(),
        }
    }

    /// The projection of `company` with `members`, kept under its key; with no
    /// key, members go in place order.
    pub fn project(
        &mut self,
        company: usize,
        members: &[PlanMember],
        key: Option<&Key>,
    ) -> Rc<Projection> {
        match key {
            Some(k) => self.project_words(company, members, &k.words, k.class_len),
            None => {
                let mut order: Vec<usize> = (0..members.len()).collect();
                sort_places(&mut order, &|a, b| by_place(members[a].employee, members[b].employee));
                let sorted = order.iter().map(|&i| members[i].clone()).collect::<Vec<PlanMember>>();
                let k = self.key(company, &sorted);
                self.project_words(company, &sorted, &k.words, k.class_len)
            }
        }
    }

    /// `project` under the key `words`, whose class is the first `class_len`.
    fn project_words(
        &mut self,
        company: usize,
        members: &[PlanMember],
        words: &[u64],
        class_len: usize,
    ) -> Rc<Projection> {
        if let Some(r) = self.cache.get(words) {
            return r.clone();
        }
        self.misses += 1.0;
        let r = Rc::new(self.run(company, members));
        self.cache.insert(words.into(), r.clone());
        let c = &self.plan.companies[company];
        let class = &words[..class_len];
        if !self.classes.contains_key(class) {
            let (margin, cost) = (c.record.margin, c.switch_cost());
            self.classes.insert(
                class.into(),
                ClassSample { projection: r.clone(), margin, switch_cost: cost },
            );
        }
        r
    }

    /// Value and PP, a re-tooled company priced from another of
    /// its class where its saved days alone differ.
    pub fn value(&mut self, company: usize, members: &[PlanMember], key: &Key) -> Valuation {
        self.value_of(company, members, &key.words, key.class_len)
    }

    /// `value` under the key `words`, whose class is the first `class_len`.
    pub fn value_of(
        &mut self,
        company: usize,
        members: &[PlanMember],
        words: &[u64],
        class_len: usize,
    ) -> Valuation {
        if let Some(r) = self.cache.get(words) {
            return r.valuation();
        }
        if let Some(&v) = self.priced.get(words) {
            return v;
        }
        let Some(sample) = self.classes.get(&words[..class_len]).cloned() else {
            return self.project_words(company, members, words, class_len).valuation();
        };
        let r = &sample.projection;
        if r.retooling.as_ref().is_some_and(|t| !t.linear) {
            return self.project_words(company, members, words, class_len).valuation();
        }
        let c = &self.plan.companies[company];
        let mut pp = r.production_points;
        if let Some(terms) = &r.retooling {
            // The class's key starts with its members, so the sample has the
            // same ones, in the same order.
            debug_assert_eq!(terms.members.len(), members.len());
            for (i, (m, &RetoolMember { saved: was, rate })) in
                members.iter().zip(&terms.members).enumerate()
            {
                let saved = self.saved_days(m.employee, c.record.product);
                if saved != was {
                    for (d, &qd) in terms.base_output(i).iter().enumerate() {
                        let d = d as f64;
                        pp += qd * ((saved + d * rate).min(20.0) - (was + d * rate).min(20.0))
                            / 100.0;
                    }
                }
            }
        }
        self.priced_count += 1.0;
        let out = Valuation {
            value: r.value + c.record.margin * pp
                - sample.margin * r.production_points
                - (c.switch_cost() - sample.switch_cost),
            production_points: pp,
        };
        self.priced.insert(words.into(), out);
        out
    }

    /// `arrange`: the planned companies' rosters under an assignment (per
    /// employee: place, tool), members in place order, each with its timeline.
    pub fn arrange(&mut self, assignment: &[Placement]) -> Vec<CompanyGroup> {
        let company_count = self.plan.company_count;
        let mut at: Vec<Vec<PlanMember>> = vec![Vec::new(); company_count];
        let mut held = vec![false; self.plan.tool_count];
        for (e, &Placement { company, tool }) in assignment.iter().enumerate() {
            if let Some(t) = tool {
                held[t] = true;
            }
            if let Some(c) = company.filter(|&c| self.is_planned[c]) {
                at[c].push(PlanMember { employee: e, tool, line: None });
            }
        }
        let mut groups: Vec<CompanyGroup> = self
            .planned
            .iter()
            .map(|&s| CompanyGroup {
                company: self.company_at[s],
                members: std::mem::take(&mut at[s]),
                same_members: false,
            })
            .collect();
        let spares: Vec<usize> = (0..self.plan.tool_count).filter(|&t| !held[t]).collect();
        let companies: Vec<usize> = groups.iter().map(|g| g.company).collect();
        let members: Vec<&[PlanMember]> = groups.iter().map(|g| &g.members[..]).collect();
        let timelines = self.handoffs(&companies, &members, &spares, None);
        for (g, lines) in groups.iter_mut().zip(timelines.lines) {
            for (m, line) in g.members.iter_mut().zip(lines) {
                m.line = Some(line.into());
            }
        }
        groups
    }

    /// The hour-0 rows of a projection, from the call that made it.
    fn rows_of(&mut self, r: &Projection, later: &[LaterSpans]) -> Vec<TotalsRow> {
        self.call(r.company, &r.members);
        let out = self.work.rows(&self.plan.people, &[], 0.0);
        let c = &self.plan.companies[r.company];
        let mut rows = Vec::with_capacity(out.len());
        for &row in out {
            let m = &r.members[row.member];
            let tool = match row.tool {
                None => None,
                Some(ToolSource::Held) => m.tool,
                Some(ToolSource::Line(k)) => m.line.as_ref().map(|l| l[k].tool),
            };
            let handoffs = later
                .iter()
                .find(|x| x.employee == m.employee)
                .map(|x| {
                    x.spans
                        .iter()
                        .map(|s| Handoff {
                            tool: self.plan.tools[s.tool].id.clone(),
                            from: s.from,
                            to: s.to,
                        })
                        .collect()
                })
                .unwrap_or_default();
            rows.push(TotalsRow {
                row,
                id: self.plan.employee_ids[m.employee].clone(),
                company: c.id.clone(),
                tool: tool.map(|t| self.plan.tools[t].id.clone()),
                company_bonus: c.record.bonus,
                value: r.totals[row.member].value,
                training: r.totals[row.member].training,
                min_happiness: r.totals[row.member].min_happiness,
                handoffs,
            });
        }
        rows
    }

    /// `totals`: an assignment projected over the planned companies (rows
    /// only if wanted: they don't change the counts).
    pub fn totals(&mut self, assignment: &[Placement], rows: bool) -> Totals {
        let groups = self.arrange(assignment);
        let mut daily = vec![0.0; project::day_count(self.end)];
        let (mut value, mut employees, mut by_company) = (0.0, Vec::new(), Vec::new());
        for g in &groups {
            let r = self.project(g.company, &g.members, None);
            if rows {
                let later: Vec<LaterSpans> = g
                    .members
                    .iter()
                    .map(|m| {
                        let line = m.line.as_deref().unwrap_or(&[]);
                        LaterSpans {
                            employee: m.employee,
                            spans: line
                                [if line.first().is_some_and(|x| x.from == 0.0) { 1 } else { 0 }..]
                                .to_vec(),
                        }
                    })
                    .collect();
                employees.extend(self.rows_of(&r, &later));
            }
            for (sum, &v) in daily.iter_mut().zip(&r.daily) {
                *sum += v;
            }
            value += r.value;
            by_company.push(CompanyValue {
                id: self.plan.companies[g.company].id.clone(),
                value: r.value,
                production_points: r.production_points,
            });
        }
        Totals { value, daily, employees, by_company }
    }

    /// The starting placement: everyone where they are, with their tool.
    pub fn initial(&self) -> Vec<Placement> {
        (0..self.plan.people.len())
            .map(|e| Placement { company: self.plan.company_of[e], tool: self.plan.equipped[e] })
            .collect()
    }

    /// Each employee's first `instant` row at hour 0 in `company`, alone and
    /// without a tool: its production.
    fn alone_production(&mut self, company: usize, e: usize) -> Option<f64> {
        self.call(company, &[PlanMember { employee: e, tool: None, line: None }]);
        self.work.rows(&self.plan.people, &[], 0.0).first().map(|row| row.production)
    }

    /// `withExclusions`' stat check: per company not in `skip`, its members
    /// whose rebuilt stats differ from the game's (company, employee).
    pub fn observed_mismatches(&mut self, skip: &[bool]) -> Vec<Mismatch> {
        // A company with data `validate` finds missing can't be rebuilt.
        let problems = check::data_problems(self);
        let incomplete = |member: &PlanMember| {
            problems.contains(&Problem::EmployeeData(member.employee))
                || problems.contains(&Problem::ClimberRaise(member.employee))
                || member.tool.is_some_and(|t| problems.contains(&Problem::ToolData(t)))
        };
        let mut out = Vec::new();
        for c in 0..self.plan.company_count {
            if skip.get(c).copied().unwrap_or(false) || problems.contains(&Problem::CompanyData(c))
            {
                continue;
            }
            let id = self.plan.companies[c].record.id;
            let members: Vec<PlanMember> = (0..self.plan.people.len())
                .filter(|&e| {
                    self.plan.company_of[e].is_some_and(|x| self.plan.companies[x].record.id == id)
                })
                .map(|e| PlanMember { employee: e, tool: self.plan.equipped[e], line: None })
                .collect();
            if members.iter().any(incomplete) {
                continue;
            }
            self.call(c, &members);
            let rows = self.work.rows(&self.plan.people, &[], 0.0);
            let disabled = self.plan.companies[c].record.disabled;
            for row in rows {
                let m = &members[row.member];
                // The first member with the row's id.
                let e = members
                    .iter()
                    .find(|x| self.plan.people[x.employee].id == self.plan.people[m.employee].id)
                    .map_or(m.employee, |x| x.employee);
                let Some(o) = self.plan.observed[e] else {
                    continue;
                };
                let off = |v: f64, o: Option<f64>, tol: f64| o.is_some_and(|o| (v - o).abs() > tol);
                if off(row.production, o.production, 0.01)
                    || off(row.responsibility, o.responsibility, 0.01)
                    || off(row.happiness, o.happiness, 0.15)
                    || off(row.bonus, o.bonus, 0.15)
                    || (!disabled && off(row.output, o.output, 0.011))
                {
                    out.push(Mismatch { company: c, employee: e });
                }
            }
        }
        out
    }
}

// --- Results ---

impl Serialize for TotalsRow {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Parts<'a>(&'a TotalsRow);
        impl Serialize for Parts<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let r = &self.0.row;
                let mut m = s.serialize_map(Some(7))?;
                m.serialize_entry("company", &self.0.company_bonus)?;
                m.serialize_entry("traits", &r.traits)?;
                m.serialize_entry("events", &r.events)?;
                m.serialize_entry("specialization", &r.specialization)?;
                m.serialize_entry("happiness", &(r.happiness - 50.0))?;
                m.serialize_entry("tool", &r.tool_bonus)?;
                m.serialize_entry("traitProduction", &r.trait_production)?;
                m.end()
            }
        }
        let r = &self.row;
        let mut m = s.serialize_map(None)?;
        for (k, v) in [
            ("luck", r.luck),
            ("learningLuck", r.learning_luck),
            ("toolboxes", r.toolboxes),
            ("loot", r.loot),
            ("trainingRate", r.training_rate),
            ("trainingsPerDay", r.trainings_per_day),
        ] {
            m.serialize_entry(k, &v)?;
        }
        m.serialize_entry("id", &*self.id)?;
        m.serialize_entry("company", &*self.company)?;
        m.serialize_entry("tool", &self.tool.as_deref())?;
        for (k, v) in [
            ("production", r.production),
            ("responsibility", r.responsibility),
            ("happiness", r.happiness),
            ("specialization", r.specialization),
            ("bonus", r.bonus),
        ] {
            m.serialize_entry(k, &v)?;
        }
        m.serialize_entry("parts", &Parts(self))?;
        for (k, v) in [
            ("output", r.output),
            ("engineOutput", r.engine_output),
            ("wage", r.wage),
            ("profit", r.profit),
            ("value", self.value),
            ("trainingValue", self.training),
            ("minHappiness", self.min_happiness),
        ] {
            m.serialize_entry(k, &v)?;
        }
        m.serialize_entry("handoffs", &self.handoffs)?;
        m.end()
    }
}

impl Serialize for Handoff {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("tool", &*self.tool)?;
        m.serialize_entry("from", &self.from)?;
        m.serialize_entry("to", &self.to)?;
        m.end()
    }
}

impl Serialize for CompanyValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("id", &*self.id)?;
        m.serialize_entry("value", &self.value)?;
        m.serialize_entry("pp", &self.production_points)?;
        m.end()
    }
}

impl Serialize for Totals {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(4))?;
        m.serialize_entry("value", &self.value)?;
        m.serialize_entry("daily", &self.daily)?;
        m.serialize_entry("employees", &self.employees)?;
        m.serialize_entry("byCompany", &self.by_company)?;
        m.end()
    }
}

/// A change to an employee's placement: their company and tool.
#[derive(Clone, Copy)]
struct Change {
    employee: usize,
    /// The company's place.
    company: usize,
    tool: Option<usize>,
}

#[derive(Clone)]
pub enum Step {
    Move { employee: usize, to: usize },
    Swap { a: usize, b: usize },
    Switch { slot: usize, from: u32, to: u32 },
}

// --- The search (`recommend`) ---

/// A place re-tooled: the company it holds instead (a variant of its
/// record, or the record itself to switch back).
#[derive(Clone, Copy)]
struct Retool {
    slot: usize,
    company: usize,
}

/// A figure at live prices and at the game's average margins.
#[derive(Clone, Copy)]
pub struct LiveAndGame {
    pub live: f64,
    pub game: f64,
}
impl Serialize for LiveAndGame {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("live", &self.live)?;
        m.serialize_entry("game", &self.game)?;
        m.end()
    }
}

/// The re-tooled company as a score saw it: what a remembered score, and a
/// sibling's price, read from its ref.
struct ScoredCompany {
    members: Vec<PlanMember>,
    value: f64,
    game_value: f64,
}

/// A score taken in a round: the gain (None: not possible) and the game gain.
#[derive(Clone, Copy)]
struct RoundScore {
    round: u32,
    gain: Option<f64>,
    game_gain: f64,
}

/// What a switch candidate's siblings (the same changes onto other goods)
/// read of it: its scores, bound and full.
#[derive(Default)]
struct CandidateState {
    scored_company: Option<Rc<ScoredCompany>>,
    bound_scored_company: Option<Rc<ScoredCompany>>,
    score: Option<RoundScore>,
    bound_score: Option<RoundScore>,
}

/// A switch's gain after its follow-up's own credit, and its PP.
#[derive(Clone, Copy)]
struct SwitchGain {
    live: f64,
    game: f64,
    production_points: f64,
}

struct Priced {
    gain: f64,
    exposure: f64,
    need: f64,
    switch: Option<SwitchGain>,
}

/// What tells candidates apart: the change, by places and tool classes
/// (`Plan::class_tools`; None for no tool). The report gives it to the
/// facade, which writes it as text.
#[derive(Clone, PartialEq, Eq, Hash)]
enum CandidateKey {
    /// An employee takes a free tool of a class, or one from `from` (who
    /// holds them all), or puts theirs away.
    Tool { employee: usize, class: Option<usize>, from: Option<usize> },
    /// An employee moves to a place with a tool of a class.
    Move { employee: usize, company: usize, class: Option<usize> },
    /// Two employees (in place order) swap places.
    Swap { a: usize, b: usize, tools: SwapTools },
    /// A place re-tooled onto a good: its members as they are, with free
    /// tools for the bare (`equip`), or with a follow-up.
    Product { company: usize, product: u32, equip: bool, follow_up: Option<Rc<CandidateKey>> },
    /// A switch's follow-up made without the switch.
    Alone { company: usize, tool_type: u32, follow_up: Rc<CandidateKey> },
}

/// A swap's tools: each keeps theirs where it fits, each takes the other's,
/// or one takes a free tool of a class.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum SwapTools {
    Keep,
    Stay,
    Give { employee: usize, class: usize },
}

/// A follow-up made without the switch (`unswitched`), and its key.
struct Unswitched {
    changes: Rc<Vec<Change>>,
    key: CandidateKey,
}

/// A change of money on a good (an entry of a candidate's `byProduct`).
#[derive(Clone, Copy)]
struct ProductMoney {
    product: u32,
    money: f64,
}

/// A change the search weighs.
struct Candidate {
    changes: Rc<Vec<Change>>,
    key: CandidateKey,
    /// The steps it takes, after a switch's own (`switch_step`): shared by
    /// a switch's siblings.
    steps: Option<Rc<[Step]>>,
    retool: Option<Retool>,
    /// Its scores, for its siblings to read: kept by the first sibling only,
    /// since only theirs is read.
    state: Option<Rc<RefCell<CandidateState>>>,
    /// The first sibling's state (`ref`).
    sibling_state: Option<Rc<RefCell<CandidateState>>>,
    follow_up: Option<Rc<CandidateKey>>,
    alone: Option<Rc<Unswitched>>,
    /// The re-tooled company's own gain.
    own_gain: Option<LiveAndGame>,
    scored_fully: bool,
    priced: Option<Priced>,
    rank: f64,
    /// Set when it leads its round.
    by_product: Option<Rc<Vec<ProductMoney>>>,
    game_gain: f64,
}
impl Candidate {
    fn new(changes: Rc<Vec<Change>>, key: CandidateKey, steps: Option<Rc<[Step]>>) -> Candidate {
        Candidate {
            changes,
            key,
            steps,
            retool: None,
            state: None,
            sibling_state: None,
            follow_up: None,
            alone: None,
            own_gain: None,
            scored_fully: false,
            priced: None,
            rank: 0.0,
            by_product: None,
            game_gain: 0.0,
        }
    }
    /// A stand-in for a candidate taken out of its queue.
    fn taken() -> Candidate {
        let key = CandidateKey::Tool { employee: usize::MAX, class: None, from: None };
        Candidate::new(Rc::default(), key, None)
    }
    /// Writes to its state, if it keeps one.
    fn note(&self, write: impl FnOnce(&mut CandidateState)) {
        if let Some(state) = &self.state {
            write(&mut state.borrow_mut());
        }
    }
}

/// A remembered score's dependency: a company's key when it was taken.
struct CompanyDependency {
    slot: usize,
    key: Option<Key>,
}

/// A remembered score's dependency: a tool type's signature when it was taken.
struct TypeDependency {
    tool_type: u32,
    signature: Option<Rc<[u32]>>,
}

struct MemoEntry {
    gain: Option<f64>,
    exposure: f64,
    by_product: Rc<Vec<ProductMoney>>,
    game_gain: f64,
    switch_production_points: f64,
    scored_company: Option<Rc<ScoredCompany>>,
    own_gain: Option<LiveAndGame>,
    companies: Vec<CompanyDependency>,
    types: Vec<TypeDependency>,
}

/// What the last score read: companies and tool types (what it depends
/// on) and the re-tooled company.
#[derive(Default)]
struct Reads {
    companies: Vec<usize>,
    types: Vec<u32>,
    scored_company: Option<Rc<ScoredCompany>>,
    own_gain: Option<LiveAndGame>,
}

/// `score`'s result.
struct Score {
    gain: Option<f64>,
    scored_company: Option<Rc<ScoredCompany>>,
    own_gain: Option<LiveAndGame>,
}

#[derive(Clone)]
pub struct Dropped {
    gain: f64,
    robust: f64,
    need: f64,
    changes: Rc<Vec<Change>>,
}

/// The changes dropped in the last round: how many, the best gain, and the
/// top five.
struct DroppedSummary {
    count: f64,
    best: f64,
    top: Vec<Dropped>,
}

#[derive(Clone)]
pub struct Hold {
    slot: usize,
    from: u32,
    to: u32,
    live: f64,
    game: f64,
    need: f64,
    spike: bool,
    key: CandidateKey,
}

/// A place re-tooled onto a good.
#[derive(Clone, Copy)]
struct CompanySwitch {
    slot: usize,
    product: u32,
}

pub struct Accepted {
    key: CandidateKey,
    changes: Rc<Vec<Change>>,
    gain: f64,
    exposure: Option<f64>,
    need: f64,
    by_product: Rc<Vec<ProductMoney>>,
    game: Option<f64>,
    switch: Option<CompanySwitch>,
}

/// A switch's break-even margin, and its ratio to the old margin.
struct BreakEven {
    margin: f64,
    ratio: Option<f64>,
}
impl Serialize for BreakEven {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("margin", &self.margin)?;
        m.serialize_entry("ratio", &self.ratio)?;
        m.end()
    }
}

/// A member's specialization on the new good: from, to, the days it takes
/// to make up, and whether they moved in.
struct Ramp {
    employee: usize,
    from: f64,
    to: f64,
    days: f64,
    moved_in: bool,
}

/// A member whose traits make them produce differently on the new good:
/// those traits, and their production alone before and after.
struct TraitShift {
    employee: usize,
    codes: Vec<&'static str>,
    from: f64,
    to: f64,
}

pub struct Report {
    slot: usize,
    from: u32,
    to: u32,
    cost: Option<f64>,
    concrete: f64,
    live: f64,
    game: f64,
    payback: f64,
    break_even: Option<BreakEven>,
    spike: bool,
    ratio: Option<f64>,
    ramp: Vec<Ramp>,
    tools_off: Vec<usize>,
    traits: Vec<TraitShift>,
    moves: Vec<usize>,
    follow_up: Option<Rc<CandidateKey>>,
    spares: Vec<usize>,
}

/// A company's earlier switch report, carried into its next one.
struct PriorSwitch {
    live: f64,
    game: f64,
    moves: Vec<usize>,
}

#[derive(Default)]
struct SwitchStats {
    goods: f64,
    candidates: f64,
    pruned: f64,
    lazy: f64,
    estimated: f64,
    cut: bool,
}

/// A map that keeps its values in the order their keys came.
struct Ordered<K, V> {
    index: FastMap<K, usize>,
    values: Vec<V>,
}
impl<K: std::hash::Hash + Eq, V> Ordered<K, V> {
    fn new() -> Self {
        Ordered { index: FastMap::default(), values: Vec::new() }
    }
    fn get(&self, k: &K) -> Option<&V> {
        self.index.get(k).map(|&i| &self.values[i])
    }
    fn set(&mut self, k: K, v: V) {
        match self.index.get(&k) {
            Some(&i) => self.values[i] = v,
            None => {
                self.index.insert(k, self.values.len());
                self.values.push(v);
            }
        }
    }
}

struct Round {
    best_gain: f64,
    /// By the employees changed, in place order.
    dropped: Ordered<Vec<usize>, Dropped>,
    holds: Ordered<(usize, u32), Hold>,
    hold_live: FastMap<usize, f64>,
}

pub struct Options {
    pub max_projections: f64,
    pub allow_moves: bool,
    pub min_max: bool,
    pub floor_at: Option<f64>,
    /// Switches with a follow-up, weighed once the search is stuck
    /// (`Search::stuck`).
    pub follow_ups: bool,
}

/// `recommend`'s options: `{ switches, maxProjections, allowMoves, minMax,
/// floorAt, followUps }`. Unknown ones: no switches, 60,000 projections,
/// moves allowed, the minimum gain on, no floor and follow-ups on; the
/// flags are read by truthiness.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendInput {
    pub switches: Option<SwitchInput>,
    max_projections: Option<f64>,
    allow_moves: Option<Truthy>,
    min_max: Option<Truthy>,
    floor_at: Option<f64>,
    follow_ups: Option<Truthy>,
}

impl RecommendInput {
    pub fn options(&self) -> Options {
        let flag = |f: &Option<Truthy>, default: bool| f.as_ref().map_or(default, |f| f.0);
        Options {
            max_projections: known(self.max_projections).unwrap_or(60_000.0),
            allow_moves: flag(&self.allow_moves, true),
            min_max: flag(&self.min_max, false),
            floor_at: known(self.floor_at),
            follow_ups: flag(&self.follow_ups, true),
        }
    }
}

/// The tools of a type, in snapshot order.
struct ToolsOfType {
    tool_type: u32,
    tools: Vec<usize>,
}

/// A bound taken earlier: the companies' versions then, and the live and
/// game gains.
struct EarlierBound {
    versions: Vec<u64>,
    live: f64,
    game: f64,
}

/// The last tool handoffs `score_afresh` made: the round, the companies,
/// their members (employee and tool from hour 0) and spares it handed out
/// for, and the timelines. A candidate's full score follows its bound with
/// the same handoffs, which depend on nothing else a round changes.
#[derive(Default)]
struct LastHandoffs {
    round: u32,
    companies: Vec<usize>,
    /// Per company its member count, then each member's employee and tool
    /// (`usize::MAX` for none).
    members: Vec<usize>,
    spares: Vec<usize>,
    watch: Option<usize>,
    timelines: Option<Timelines>,
}

impl LastHandoffs {
    fn same(
        &self,
        round: u32,
        companies: &[usize],
        members: &[&[PlanMember]],
        spares: &[usize],
        watch: Option<usize>,
    ) -> bool {
        let mut words = self.members.iter().copied();
        self.round == round
            && self.watch == watch
            && self.companies == companies
            && self.spares == spares
            && members.iter().all(|list| {
                words.next() == Some(list.len())
                    && list.iter().all(|m| {
                        words.next() == Some(m.employee)
                            && words.next() == Some(m.tool.unwrap_or(usize::MAX))
                    })
            })
            && words.next().is_none()
    }
    /// The kept timelines, if they were made for these.
    fn take_if_same(
        &mut self,
        round: u32,
        companies: &[usize],
        members: &[&[PlanMember]],
        spares: &[usize],
        watch: Option<usize>,
    ) -> Option<Timelines> {
        if self.timelines.is_none() || !self.same(round, companies, members, spares, watch) {
            return None;
        }
        self.timelines.take()
    }
    /// Notes what new timelines were made for; `keep` takes them once used.
    fn made(
        &mut self,
        round: u32,
        companies: &[usize],
        members: &[&[PlanMember]],
        spares: &[usize],
        watch: Option<usize>,
    ) {
        self.round = round;
        self.watch = watch;
        self.companies.clear();
        self.companies.extend_from_slice(companies);
        self.spares.clear();
        self.spares.extend_from_slice(spares);
        self.members.clear();
        for list in members {
            self.members.push(list.len());
            for m in list.iter() {
                self.members.extend([m.employee, m.tool.unwrap_or(usize::MAX)]);
            }
        }
        self.timelines = None;
    }
    fn keep(&mut self, timelines: Timelines) {
        self.timelines = Some(timelines);
    }
}

/// `estimate`'s buffers: where each changed employee ends up, the places
/// touched, a place's members, and a `best_values` key.
#[derive(Default)]
struct EstimateBuffers {
    over: Vec<(usize, usize)>,
    touched: Vec<usize>,
    ids: Vec<usize>,
    key: Vec<usize>,
}

/// The most a follow-up added in a round to switching a place to a tool
/// type.
#[derive(Clone, Copy)]
struct Ripple {
    round: u32,
    live: f64,
    game: f64,
}

pub struct Search {
    pub env: Env,
    switches: Option<SwitchContext>,
    options: Options,
    /// The employees being planned.
    people: Vec<usize>,
    assignment: Vec<Placement>,
    /// The tools the search hands out.
    manual: Vec<usize>,
    /// Their classes (`Plan::class_tools`), in order.
    classes: Vec<usize>,
    /// A tool of each class.
    class_sample: FastMap<usize, usize>,
    holder: Vec<Option<usize>>,
    /// Per place: the employees there.
    roster: Vec<Vec<usize>>,
    /// Per place: the key, value, money and game value now, and how often
    /// they changed.
    keys: Vec<Option<Key>>,
    value: Vec<f64>,
    money: Vec<f64>,
    game_value: Vec<f64>,
    versions: Vec<u64>,
    /// Per place: the tool type of its good (`toolTypeOf`; 0 unplanned),
    /// the types its members hold and the members.
    tool_types: Vec<u32>,
    held_types: Vec<Vec<u32>>,
    current_members: Vec<Vec<PlanMember>>,
    tools_of_type: Vec<ToolsOfType>,
    type_signatures: FastMap<u32, Rc<[u32]>>,
    baseline: Totals,
    floor: f64,
    steps: Vec<Step>,
    moved: Vec<bool>,
    rounds: u32,
    candidates: f64,
    limited: bool,
    stopped: &'static str,
    /// The projections run at the latest budget check (none yet: -inf).
    /// They only grow, so a smaller budget makes the same search as long
    /// as it is above this (`Comparison::within`).
    last_check: f64,
    dropped: Option<DroppedSummary>,
    accepted: Vec<Accepted>,
    switch_stats: SwitchStats,
    holds: Option<Vec<Hold>>,
    earlier: FastMap<CandidateKey, EarlierBound>,
    exposure: f64,
    by_product: Rc<Vec<ProductMoney>>,
    game_gain: f64,
    switch_production_points: f64,
    memo: FastMap<(bool, CandidateKey), MemoEntry>,
    reads: Reads,
    best_bonus: FastMap<u32, f64>,
    full_tools: FastMap<u32, usize>,
    ripple: FastMap<(usize, u32), Ripple>,
    /// By record, good and members (`best_value`).
    best_values: FastMap<Box<[usize]>, Option<LiveAndGame>>,
    /// Buffers reused from candidate to candidate: `estimate`'s, and the
    /// places a follow-up touches and their versions.
    estimate_buffers: EstimateBuffers,
    places: Vec<usize>,
    versions_at: Vec<u64>,
    /// A projection key's words (`Env::key_words`).
    key_buffer: Vec<u64>,
    /// The last tool handoffs a score made, for the next to reuse.
    handed: LastHandoffs,
    switched: Vec<CompanySwitch>,
    reports: Vec<Report>,
    horizon_days: f64,
    max_rounds: u32,
    variants: FastMap<(usize, u32), Option<usize>>,
    /// The last round found no change clearing the floor, so this one also
    /// weighs each switch with a follow-up. Pairs are most of a round's
    /// candidates and pay only where no single change does: a pair taken
    /// goes back to single changes, and a stuck round with nothing to take
    /// ends the search.
    stuck: bool,
    done: bool,
}

const NONE_TYPE: &str = "none";

impl Search {
    pub fn new(plan: Plan, switches: Option<SwitchContext>, options: Options) -> Search {
        let mut env = Env::new(plan);
        let plan = &env.plan;
        let employee_count = plan.people.len();
        let people: Vec<usize> = (0..employee_count)
            .filter(|&e| plan.company_of[e].is_some_and(|c| !plan.companies[c].excluded))
            .collect();
        let assignment = env.initial();
        let mut is_person = vec![false; employee_count];
        for &e in &people {
            is_person[e] = true;
        }
        let manual: Vec<usize> = (0..plan.tool_count)
            .filter(|&t| {
                plan.tools[t].hours > 0.0
                    && match plan.tools[t].holder {
                        Holder::Free => true,
                        Holder::Employee(e) => is_person[e],
                        Holder::Missing => false,
                    }
            })
            .collect();
        let mut classes: Vec<usize> = Vec::new();
        let mut class_sample = FastMap::default();
        for &t in &manual {
            let k = plan.tools[t].class;
            if !classes.contains(&k) {
                classes.push(k);
            }
            class_sample.insert(k, t);
        }
        sort_places(&mut classes, &by_place);
        let mut holder = vec![None; plan.tool_count];
        for (e, placement) in assignment.iter().enumerate() {
            if let Some(t) = placement.tool {
                holder[t] = Some(e);
            }
        }
        let company_count = plan.company_count;
        let mut roster = vec![Vec::new(); company_count];
        for &e in &people {
            if let Some(c) = plan.company_of[e] {
                roster[c].push(e);
            }
        }
        let tool_types = (0..company_count)
            .map(|s| if env.is_planned[s] { plan.companies[s].tool_type_of() } else { 0 })
            .collect();
        let mut tools_of_type: Vec<ToolsOfType> = Vec::new();
        for t in 0..plan.tool_count {
            let tool_type = plan.tools[t].tool_type;
            match tools_of_type.iter_mut().find(|x| x.tool_type == tool_type) {
                Some(x) => x.tools.push(t),
                None => tools_of_type.push(ToolsOfType { tool_type, tools: vec![t] }),
            }
        }
        let mut best_bonus: FastMap<u32, f64> = FastMap::default();
        for t in &plan.tools {
            if t.hours > 0.0 && !best_bonus.get(&t.tool_type).is_some_and(|&b| t.bonus <= b) {
                best_bonus.insert(t.tool_type, t.bonus);
            }
        }
        let horizon_days = plan.hours.unwrap_or(plan.days * 24.0) / 24.0;
        let max_rounds = (2 * people.len()
            + manual.len()
            + 10
            + if switches.is_some() { 2 * env.planned.len() } else { 0 })
            as u32;
        let switch_stats = SwitchStats {
            goods: switches.as_ref().map_or(0.0, |s| s.codes.len() as f64),
            ..SwitchStats::default()
        };
        env.reset_projector();
        let mut search = Search {
            env,
            switches,
            options,
            people,
            assignment,
            manual,
            classes,
            class_sample,
            holder,
            roster,
            keys: vec![None; company_count],
            value: vec![0.0; company_count],
            money: vec![0.0; company_count],
            game_value: vec![0.0; company_count],
            versions: vec![0; company_count],
            tool_types,
            held_types: vec![Vec::new(); company_count],
            current_members: vec![Vec::new(); company_count],
            tools_of_type,
            type_signatures: FastMap::default(),
            baseline: Totals {
                value: 0.0,
                daily: Vec::new(),
                employees: Vec::new(),
                by_company: Vec::new(),
            },
            floor: 0.0,
            steps: Vec::new(),
            moved: vec![false; employee_count],
            rounds: 0,
            candidates: 0.0,
            limited: false,
            stopped: "converged",
            last_check: f64::NEG_INFINITY,
            dropped: None,
            accepted: Vec::new(),
            switch_stats,
            holds: None,
            earlier: FastMap::default(),
            exposure: 0.0,
            by_product: Rc::default(),
            game_gain: 0.0,
            switch_production_points: 0.0,
            memo: FastMap::default(),
            reads: Reads::default(),
            best_bonus,
            full_tools: FastMap::default(),
            ripple: FastMap::default(),
            best_values: FastMap::default(),
            estimate_buffers: EstimateBuffers::default(),
            places: Vec::new(),
            versions_at: Vec::new(),
            key_buffer: Vec::new(),
            handed: LastHandoffs::default(),
            switched: Vec::new(),
            reports: Vec::new(),
            horizon_days,
            max_rounds,
            variants: FastMap::default(),
            stuck: false,
            done: false,
        };
        search.refresh();
        search.baseline = search.env.totals(&search.assignment, /* rows */ true);
        search.floor = if search.options.min_max {
            0.0
        } else {
            search.options.floor_at.unwrap_or_else(|| {
                (churn::FLOOR_SHARE * search.baseline.value).max(churn::FLOOR_MIN)
            })
        };
        search
    }

    fn game_margin(&self, company: usize) -> f64 {
        let c = &self.env.plan.companies[company];
        self.switches.as_ref().map_or(c.record.margin, |switches| switches.game_margin(c))
    }
    fn movable(&self, e: usize) -> bool {
        self.options.allow_moves && !self.env.plan.locked[e] && !self.moved[e]
    }
    fn class_of(&self, t: Option<usize>) -> Option<usize> {
        t.map(|t| self.env.plan.tools[t].class)
    }
    fn free_unit(&self, k: usize) -> Option<usize> {
        self.manual
            .iter()
            .copied()
            .find(|&t| self.env.plan.tools[t].class == k && self.holder[t].is_none())
    }
    fn compatible_tool(&self, tool: Option<usize>, company: usize) -> Option<usize> {
        tool.filter(|&t| self.env.compatible(t, company))
    }
    /// The place of a planned employee's company: everyone planned has one.
    fn place_of(&self, e: usize) -> usize {
        self.assignment[e].company.expect("a planned employee works at a company")
    }

    fn refresh(&mut self) {
        let groups = self.env.arrange(&self.assignment);
        for g in &groups {
            let slot = self.env.plan.companies[g.company].slot;
            let key = self.env.key(g.company, &g.members);
            if self.keys[slot].as_ref() != Some(&key) {
                self.versions[slot] += 1;
                let Valuation { value: v, production_points: pp } =
                    self.env.value(g.company, &g.members, &key);
                let margin = self.env.plan.companies[g.company].record.margin;
                self.keys[slot] = Some(key);
                self.value[slot] = v;
                self.money[slot] = margin * pp;
                if self.switches.is_some() {
                    self.game_value[slot] = v + (self.game_margin(g.company) - margin) * pp;
                }
            }
        }
        for g in groups {
            let slot = self.env.plan.companies[g.company].slot;
            let mut types: Vec<u32> = Vec::new();
            for m in &g.members {
                if let Some(t) = m.tool {
                    let ty = self.env.plan.tools[t].tool_type;
                    if !types.contains(&ty) {
                        types.push(ty);
                    }
                }
            }
            self.held_types[slot] = types;
            self.current_members[slot] = g.members;
        }
        for of_type in &self.tools_of_type {
            let ty = of_type.tool_type;
            let mut signature: Vec<u32> = self
                .env
                .planned
                .iter()
                .copied()
                .filter(|&c| self.tool_types[c] == ty || self.held_types[c].contains(&ty))
                .map(|c| c as u32)
                .collect();
            signature.push(u32::MAX);
            signature
                .extend(of_type.tools.iter().map(|&t| self.holder[t].map_or(0, |e| e as u32 + 1)));
            self.type_signatures.insert(ty, signature.into());
        }
    }

    /// The minimum gain for `changes`: higher if they move someone moved lately.
    fn floor_for(&self, changes: &[Change]) -> f64 {
        if changes.iter().any(|change| {
            Some(change.company) != self.assignment[change.employee].company
                && self.env.plan.people[change.employee].move_age_hours < churn::RECENT_HOURS
        }) {
            churn::RECENT_FACTOR * self.floor
        } else {
            self.floor
        }
    }
    fn switch_need(&self, retool: Retool, changes: &[Change]) -> f64 {
        if self.options.min_max {
            return 0.0;
        }
        let company = &self.env.plan.companies[retool.company];
        self.floor_for(changes)
            * if company.switched_age < churn::RECENT_HOURS { churn::RECENT_FACTOR } else { 1.0 }
    }

    /// The best free tool class of each type.
    fn best_spare_classes(&self) -> Vec<usize> {
        let tools = &self.env.plan.tools;
        // (tool type, its best free tool), types in the order they come up.
        let mut best: Vec<(u32, usize)> = Vec::new();
        for &t in &self.manual {
            if self.holder[t].is_some() {
                continue;
            }
            let x = &tools[t];
            match best.iter_mut().find(|(tool_type, _)| *tool_type == x.tool_type) {
                None => best.push((x.tool_type, t)),
                Some((_, b)) => {
                    let y = &tools[*b];
                    if x.bonus > y.bonus
                        || x.bonus == y.bonus && (x.hours > y.hours || x.hours == y.hours && t < *b)
                    {
                        *b = t;
                    }
                }
            }
        }
        let mut out: Vec<usize> = best.iter().map(|&(_, b)| tools[b].class).collect();
        sort_places(&mut out, &by_place);
        out
    }

    /// The candidates to weigh. `only_to`: only moves into that company; `best`:
    /// moves and swaps are offered the best free tool of each type only.
    fn candidates_for(
        &self,
        e: usize,
        partners: &[usize],
        only_to: Option<usize>,
        best: bool,
    ) -> Vec<Candidate> {
        let offered = if best { self.best_spare_classes() } else { self.classes.clone() };
        let (here_slot, own_tool) = (self.place_of(e), self.assignment[e].tool);
        let here = self.env.company_at[here_slot];
        let own_class = self.class_of(own_tool);
        let mut out = Vec::new();
        let mut add = |changes: Vec<Change>, key: CandidateKey, step: Option<Step>| {
            out.push(Candidate::new(Rc::new(changes), key, step.map(|x| Rc::from([x]))))
        };
        if own_tool.is_some() && only_to.is_none() {
            add(
                vec![Change { employee: e, company: here_slot, tool: None }],
                CandidateKey::Tool { employee: e, class: None, from: None },
                None,
            );
        }
        if only_to.is_none() {
            for &k in &self.classes {
                if Some(k) == own_class || !self.env.compatible(self.class_sample[&k], here) {
                    continue;
                }
                if let Some(unit) = self.free_unit(k) {
                    add(
                        vec![Change { employee: e, company: here_slot, tool: Some(unit) }],
                        CandidateKey::Tool { employee: e, class: Some(k), from: None },
                        None,
                    );
                    continue;
                }
                for &t in &self.manual {
                    let Some(other) = self.holder[t] else {
                        continue;
                    };
                    if self.env.plan.tools[t].class != k {
                        continue;
                    }
                    let there = self.env.company_at[self.place_of(other)];
                    add(
                        vec![
                            Change { employee: e, company: here_slot, tool: Some(t) },
                            Change {
                                employee: other,
                                company: self.env.plan.companies[there].slot,
                                tool: self.compatible_tool(own_tool, there),
                            },
                        ],
                        CandidateKey::Tool { employee: e, class: Some(k), from: Some(other) },
                        None,
                    );
                }
            }
        }
        if !self.movable(e) {
            return out;
        }
        for &cs in &self.env.planned {
            let c = self.env.company_at[cs];
            let company = &self.env.plan.companies[c];
            if cs == here_slot
                || company.record.disabled
                || self.roster[cs].len() as f64 >= company.capacity
                || only_to.is_some_and(|o| o != cs)
            {
                continue;
            }
            let step = Step::Move { employee: e, to: cs };
            let keep = self.compatible_tool(own_tool, c);
            add(
                vec![Change { employee: e, company: cs, tool: keep }],
                CandidateKey::Move { employee: e, company: cs, class: self.class_of(keep) },
                Some(step.clone()),
            );
            for &k in &offered {
                if !self.env.compatible(self.class_sample[&k], c) {
                    continue;
                }
                let unit = if own_class == Some(k) { None } else { self.free_unit(k) };
                if let Some(unit) = unit {
                    add(
                        vec![Change { employee: e, company: cs, tool: Some(unit) }],
                        CandidateKey::Move { employee: e, company: cs, class: Some(k) },
                        Some(step.clone()),
                    );
                }
            }
        }
        if only_to.is_some() {
            return out;
        }
        for &f in partners {
            let (there_slot, theirs) = (self.place_of(f), self.assignment[f].tool);
            let there = self.env.company_at[there_slot];
            if self.env.plan.companies[here].record.disabled
                && self.env.plan.companies[there].record.disabled
            {
                continue;
            }
            let (a, b) = (e.min(f), e.max(f));
            let swap = |tools: SwapTools| CandidateKey::Swap { a, b, tools };
            let step = Step::Swap { a: e, b: f };
            add(
                vec![
                    Change {
                        employee: e,
                        company: there_slot,
                        tool: self.compatible_tool(own_tool, there),
                    },
                    Change {
                        employee: f,
                        company: here_slot,
                        tool: self.compatible_tool(theirs, here),
                    },
                ],
                swap(SwapTools::Keep),
                Some(step.clone()),
            );
            if own_tool.is_some() || theirs.is_some() {
                add(
                    vec![
                        Change {
                            employee: e,
                            company: there_slot,
                            tool: self.compatible_tool(theirs, there),
                        },
                        Change {
                            employee: f,
                            company: here_slot,
                            tool: self.compatible_tool(own_tool, here),
                        },
                    ],
                    swap(SwapTools::Stay),
                    Some(step.clone()),
                );
            }
            for &k in &offered {
                let Some(unit) = self.free_unit(k) else {
                    continue;
                };
                if self.env.compatible(unit, there) {
                    add(
                        vec![
                            Change { employee: e, company: there_slot, tool: Some(unit) },
                            Change {
                                employee: f,
                                company: here_slot,
                                tool: self.compatible_tool(theirs, here),
                            },
                        ],
                        swap(SwapTools::Give { employee: e, class: k }),
                        Some(step.clone()),
                    );
                }
                if self.env.compatible(unit, here) {
                    add(
                        vec![
                            Change {
                                employee: e,
                                company: there_slot,
                                tool: self.compatible_tool(own_tool, there),
                            },
                            Change { employee: f, company: here_slot, tool: Some(unit) },
                        ],
                        swap(SwapTools::Give { employee: f, class: k }),
                        Some(step.clone()),
                    );
                }
            }
        }
        out
    }

    /// The planner's own changes that touch place `slot` once
    /// it is re-tooled as `next` with `drops` made, on that state, undone after.
    fn follow_ups(&mut self, slot: usize, next: usize, drops: &[Change]) -> Vec<Candidate> {
        let was = self.env.company_at[slot];
        let before: Vec<(usize, Placement)> =
            drops.iter().map(|d| (d.employee, self.assignment[d.employee])).collect();
        self.env.company_at[slot] = next;
        for &Change { employee: e, company, tool } in drops {
            if let Some(t) = self.assignment[e].tool {
                self.holder[t] = None;
            }
            self.assignment[e] = Placement { company: Some(company), tool };
        }
        let partners: Vec<usize> = self
            .people
            .iter()
            .copied()
            .filter(|&f| self.movable(f) && self.assignment[f].company != Some(slot))
            .collect();
        let mut out = Vec::new();
        for e in self.roster[slot].clone() {
            out.extend(self.candidates_for(e, &partners, None, /* best */ true));
        }
        for &f in &partners {
            out.extend(self.candidates_for(f, &[], Some(slot), /* best */ true));
        }
        for (e, placement) in before {
            self.assignment[e] = placement;
            if let Some(t) = placement.tool {
                self.holder[t] = Some(e);
            }
        }
        self.env.company_at[slot] = was;
        out
    }

    /// A follow-up made without the switch.
    fn unswitched(&self, changes: &[Change]) -> Vec<Change> {
        let used: Vec<usize> = changes.iter().filter_map(|x| x.tool).collect();
        changes
            .iter()
            .map(|&change| {
                let there = self.env.company_at[change.company];
                let own = self.assignment[change.employee].tool;
                if change.tool.is_some_and(|t| self.env.compatible(t, there)) {
                    return change;
                }
                Change {
                    tool: own.filter(|&o| !used.contains(&o) && self.env.compatible(o, there)),
                    ..change
                }
            })
            .collect()
    }

    /// The company on `product`, re-tooled from place `slot`'s record (one
    /// per good, as every retool of it is equal); None for a good without a
    /// known margin.
    fn variant(&mut self, slot: usize, product: u32) -> Option<usize> {
        if let Some(&v) = self.variants.get(&(slot, product)) {
            return v;
        }
        let switches = self.switches.as_ref().expect("variants are made only with switch options");
        let v = switches.retool(&self.env.plan.companies[slot], product).map(|company| {
            self.env.plan.companies.push(company);
            self.env.plan.companies.len() - 1
        });
        self.variants.insert((slot, product), v);
        v
    }

    fn switch_candidates(&mut self) -> Vec<Vec<Candidate>> {
        if self.switches.is_none() {
            return Vec::new();
        }
        let mut lists = Vec::new();
        for cs in self.env.planned.clone() {
            let c = self.env.company_at[cs];
            if self.env.plan.companies[c].record.disabled {
                lists.push(Vec::new());
                continue;
            }
            let ids = self.roster[cs].clone();
            let home = cs;
            let home_product = self.env.plan.companies[home].record.product;
            let products = self.switches.as_ref().map_or_else(Vec::new, |switches| {
                switches.products(self.env.plan.companies[c].record.product)
            });
            // The goods by the tool type they take, types in the order they come up.
            let mut by_type: Vec<(u32, Vec<u32>)> = Vec::new();
            for product in products {
                let ty = tool_type_id(product);
                match by_type.iter_mut().find(|(t, _)| *t == ty) {
                    Some((_, goods)) => goods.push(product),
                    None => by_type.push((ty, vec![product])),
                }
            }
            let (mut alone, mut follow) = (Vec::new(), Vec::new());
            for (ty, goods) in by_type {
                let fits = |t: usize| self.env.plan.tools[t].tool_type == ty;
                let drops: Vec<Change> = ids
                    .iter()
                    .filter(|&&id| self.assignment[id].tool.is_some_and(|t| !fits(t)))
                    .map(|&id| Change { employee: id, company: cs, tool: None })
                    .collect();
                let mut bare: Vec<usize> = ids
                    .iter()
                    .copied()
                    .filter(|&id| {
                        self.assignment[id].tool.is_none() || drops.iter().any(|d| d.employee == id)
                    })
                    .collect();
                let plan = &self.env.plan;
                sort_places(&mut bare, &|a, b| {
                    (plan.people[b].production)
                        .total_cmp(&plan.people[a].production)
                        .then(a.cmp(&b))
                });
                let mut free: Vec<usize> = self
                    .manual
                    .iter()
                    .copied()
                    .filter(|&t| self.holder[t].is_none() && fits(t))
                    .collect();
                sort_places(&mut free, &|a, b| {
                    let (x, y) = (&plan.tools[a], &plan.tools[b]);
                    y.bonus.total_cmp(&x.bonus).then(y.hours.total_cmp(&x.hours)).then(a.cmp(&b))
                });
                let equip: Vec<Change> = bare
                    .iter()
                    .zip(&free)
                    .map(|(&id, &t)| Change { employee: id, company: cs, tool: Some(t) })
                    .collect();
                let mut after = Vec::new();
                for &product in &goods {
                    let next = if product == home_product {
                        Some(home)
                    } else {
                        self.variant(home, product)
                    };
                    after.extend(next);
                }
                if after.is_empty() {
                    continue;
                }
                // Per good: the company on it and the good.
                let each: Vec<(usize, u32)> = after
                    .iter()
                    .map(|&next| (next, self.env.plan.companies[next].record.product))
                    .collect();
                let add_variants =
                    |list: &mut Vec<Candidate>,
                     changes: Rc<Vec<Change>>,
                     equip: bool,
                     then: &[Step],
                     follow: Option<(Rc<CandidateKey>, Rc<Unswitched>)>| {
                        let mut first: Option<Rc<RefCell<CandidateState>>> = None;
                        let then: Option<Rc<[Step]>> = (!then.is_empty()).then(|| then.into());
                        for &(next, product) in &each {
                            let key = CandidateKey::Product {
                                company: cs,
                                product,
                                equip,
                                follow_up: follow.as_ref().map(|(f, _)| f.clone()),
                            };
                            let mut c = Candidate::new(changes.clone(), key, then.clone());
                            c.retool = Some(Retool { slot: cs, company: next });
                            c.sibling_state = first.clone();
                            if let Some((follow_up, alone)) = &follow {
                                c.follow_up = Some(follow_up.clone());
                                c.alone = Some(alone.clone());
                            }
                            if first.is_none() {
                                let state = Rc::default();
                                c.state = Some(Rc::clone(&state));
                                first = Some(state);
                            }
                            list.push(c);
                        }
                    };
                let drops_rc = Rc::new(drops.clone());
                add_variants(&mut alone, drops_rc, false, &[], None);
                if !equip.is_empty() {
                    add_variants(&mut alone, Rc::new(merge(&drops, &equip)), true, &[], None);
                }
                if self.stuck {
                    for f in self.follow_ups(cs, after[0], &drops) {
                        let follow_up = Rc::new(f.key);
                        let unswitched = Rc::new(Unswitched {
                            changes: Rc::new(self.unswitched(&f.changes)),
                            key: CandidateKey::Alone {
                                company: cs,
                                tool_type: ty,
                                follow_up: follow_up.clone(),
                            },
                        });
                        add_variants(
                            &mut follow,
                            Rc::new(merge(&drops, &f.changes)),
                            false,
                            f.steps.as_deref().unwrap_or(&[]),
                            Some((follow_up, unswitched)),
                        );
                    }
                }
            }
            alone.extend(follow);
            lists.push(alone);
        }
        lists
    }

    fn score(
        &mut self,
        changes: &[Change],
        key: &CandidateKey,
        retool: Option<Retool>,
        bound: bool,
    ) -> Score {
        let memo_key = (bound, key.clone());
        if let Some(m) = self.memo.get(&memo_key)
            && m.companies.iter().all(|d| self.keys[d.slot] == d.key)
            && m.types
                .iter()
                .all(|d| self.type_signatures.get(&d.tool_type).cloned() == d.signature)
        {
            self.exposure = m.exposure;
            self.by_product = m.by_product.clone();
            self.game_gain = m.game_gain;
            self.switch_production_points = m.switch_production_points;
            return Score {
                gain: m.gain,
                scored_company: m.scored_company.clone(),
                own_gain: m.own_gain,
            };
        }
        let gain = self.score_afresh(changes, retool, bound);
        let (scored_company, own_gain) = if gain.is_none() {
            (None, None)
        } else {
            (self.reads.scored_company.clone(), self.reads.own_gain)
        };
        let companies = self
            .reads
            .companies
            .iter()
            .map(|&slot| CompanyDependency { slot, key: self.keys[slot].clone() })
            .collect();
        let types = self
            .reads
            .types
            .iter()
            .map(|&tool_type| TypeDependency {
                tool_type,
                signature: self.type_signatures.get(&tool_type).cloned(),
            })
            .collect();
        self.memo.insert(
            memo_key,
            MemoEntry {
                gain,
                exposure: self.exposure,
                by_product: self.by_product.clone(),
                game_gain: self.game_gain,
                switch_production_points: self.switch_production_points,
                scored_company: scored_company.clone(),
                own_gain,
                companies,
                types,
            },
        );
        Score { gain, scored_company, own_gain }
    }

    /// The tool type of the good at `slot`, with `retool` made.
    fn tool_type_at(&self, retool: Option<Retool>, slot: usize) -> u32 {
        match retool {
            Some(r) if r.slot == slot => self.env.plan.companies[r.company].tool_type_of(),
            _ => self.tool_types[slot],
        }
    }

    fn score_afresh(
        &mut self,
        changes: &[Change],
        retool: Option<Retool>,
        bound: bool,
    ) -> Option<f64> {
        // Each changed employee's last change.
        let mut over: Vec<Change> = Vec::new();
        let mut touched: Vec<usize> = Vec::new();
        let mut types: Vec<u32> = Vec::new();
        let mut taken: Vec<usize> = Vec::new();
        let has_type = |s: &Search, x: u32| s.tools_of_type.iter().any(|t| t.tool_type == x);
        let note = |s: &Search, types: &mut Vec<u32>, x: u32| {
            if has_type(s, x) && !types.contains(&x) {
                types.push(x)
            }
        };
        let add = |v: &mut Vec<usize>, x: usize| {
            if !v.contains(&x) {
                v.push(x)
            }
        };
        if let Some(r) = retool {
            add(&mut touched, r.slot);
            note(self, &mut types, self.tool_types[r.slot]);
            note(self, &mut types, self.tool_type_at(retool, r.slot));
        }
        for &change in changes {
            let Change { employee: id, company, tool } = change;
            let was = self.assignment[id];
            match over.iter_mut().find(|o| o.employee == id) {
                Some(o) => {
                    o.company = company;
                    o.tool = tool;
                }
                None => over.push(change),
            }
            let was_slot = was.company.expect("a changed employee works at a company");
            add(&mut touched, was_slot);
            add(&mut touched, company);
            if let Some(t) = tool {
                taken.push(t);
            }
            note(self, &mut types, self.tool_type_at(retool, was_slot));
            note(self, &mut types, self.tool_type_at(retool, company));
            note(self, &mut types, was.tool.map_or(0, |t| self.env.plan.tools[t].tool_type));
            note(self, &mut types, tool.map_or(0, |t| self.env.plan.tools[t].tool_type));
        }
        let members_of = |s: &Search, c: usize| -> Vec<PlanMember> {
            let mut ids: Vec<usize> = s.roster[c]
                .iter()
                .copied()
                .filter(|&x| over.iter().find(|o| o.employee == x).is_none_or(|o| o.company == c))
                .collect();
            for o in &over {
                if o.company == c && s.assignment[o.employee].company != Some(c) {
                    ids.push(o.employee);
                }
            }
            sort_places(&mut ids, &by_place);
            ids.into_iter()
                .map(|x| PlanMember {
                    employee: x,
                    tool: over
                        .iter()
                        .find(|o| o.employee == x)
                        .map_or(s.assignment[x].tool, |o| o.tool),
                    line: None,
                })
                .collect()
        };
        let mut groups: Vec<CompanyGroup> = Vec::new();
        // Per place: whether its company is in play.
        let mut in_play = vec![false; self.env.plan.company_count];
        // What the score reads so far: the types its members hold are
        // noted once every touched company fits.
        let noted = types.len();
        for &id in &touched {
            let members = members_of(self, id);
            let company = match retool {
                Some(r) if r.slot == id => r.company,
                _ => self.env.company_at[id],
            };
            if members.len() as f64 > self.env.plan.companies[company].capacity {
                types.truncate(noted);
                self.reads =
                    Reads { companies: touched, types, scored_company: None, own_gain: None };
                return None;
            }
            for m in &members {
                if let Some(t) = m.tool {
                    note(self, &mut types, self.env.plan.tools[t].tool_type);
                }
            }
            in_play[id] = true;
            groups.push(CompanyGroup { company, members, same_members: false });
        }
        let mut grew = !types.is_empty();
        while grew {
            grew = false;
            for &c in &self.env.planned {
                if in_play[c] {
                    continue;
                }
                let own = &self.held_types[c];
                if !types.contains(&self.tool_types[c]) && !own.iter().any(|t| types.contains(t)) {
                    continue;
                }
                in_play[c] = true;
                // Its members are the place's current ones, read there.
                groups.push(CompanyGroup {
                    company: self.env.company_at[c],
                    members: Vec::new(),
                    same_members: true,
                });
                note(self, &mut types, self.tool_types[c]);
                for &t in own {
                    note(self, &mut types, t);
                }
                grew = true;
            }
        }
        let mut spares = Vec::new();
        for &ty in &types {
            let Some(of_type) = self.tools_of_type.iter().find(|x| x.tool_type == ty) else {
                continue;
            };
            for &t in &of_type.tools {
                let h = self.holder[t];
                if !taken.contains(&t)
                    && !h.is_some_and(|h| over.iter().find(|o| o.employee == h).is_none())
                {
                    spares.push(t);
                }
            }
        }
        let plan = &self.env.plan;
        let mut order: Vec<usize> = (0..groups.len()).collect();
        sort_places(&mut order, &|a, b| {
            by_place(plan.companies[groups[a].company].slot, plan.companies[groups[b].company].slot)
        });
        let mut unsorted: Vec<Option<CompanyGroup>> = groups.into_iter().map(Some).collect();
        let mut groups: Vec<CompanyGroup> = order
            .iter()
            .map(|&i| unsorted[i].take().expect("the order names each group once"))
            .collect();
        self.reads.companies =
            groups.iter().map(|g| self.env.plan.companies[g.company].slot).collect();
        let companies: Vec<usize> = groups.iter().map(|g| g.company).collect();
        let members: Vec<&[PlanMember]> = groups
            .iter()
            .map(|g| {
                if g.same_members {
                    &self.current_members[self.env.plan.companies[g.company].slot][..]
                } else {
                    &g.members[..]
                }
            })
            .collect();
        let watch = retool.map(|r| r.slot);
        let Timelines { lines, contended } = if types.is_empty() {
            Timelines {
                lines: members.iter().map(|m| vec![Vec::new(); m.len()]).collect(),
                contended: false,
            }
        } else if let Some(t) =
            self.handed.take_if_same(self.rounds, &companies, &members, &spares, watch)
        {
            t
        } else {
            let t = self.env.handoffs(&companies, &members, &spares, watch);
            self.handed.made(self.rounds, &companies, &members, &spares, watch);
            t
        };
        self.reads.scored_company = None;
        self.reads.own_gain = None;
        let mut gain = 0.0;
        let mut by_product: Vec<ProductMoney> = Vec::new();
        // Per good: the first change makes its entry from 0, later ones add
        // to it in the order they come.
        let add_money =
            |list: &mut Vec<ProductMoney>, product: u32, f: &dyn Fn(f64) -> f64| match list
                .iter_mut()
                .find(|x| x.product == product)
            {
                Some(x) => x.money = f(x.money),
                None => list.push(ProductMoney { product, money: f(0.0) }),
            };
        self.game_gain = 0.0;
        self.switch_production_points = 0.0;
        let mut words = std::mem::take(&mut self.key_buffer);
        for (g, group_lines) in groups.iter_mut().zip(&lines) {
            if g.same_members {
                let current = &self.current_members[self.env.plan.companies[g.company].slot];
                if current
                    .iter()
                    .zip(group_lines)
                    .all(|(m, l)| m.line.as_deref().is_some_and(|x| x == &l[..]))
                {
                    continue;
                }
                g.members = current
                    .iter()
                    .map(|m| PlanMember { employee: m.employee, tool: m.tool, line: None })
                    .collect();
            }
            for (m, l) in g.members.iter_mut().zip(group_lines) {
                m.line = Some(Rc::from(&l[..]));
            }
            let slot = self.env.plan.companies[g.company].slot;
            let class_len = self.env.key_words(g.company, &g.members, &mut words);
            if self.keys[slot]
                .as_ref()
                .is_some_and(|k| k.class_len == class_len && *k.words == words[..])
            {
                continue;
            }
            let best = if bound && retool.is_some_and(|r| r.slot == slot) {
                self.best_case(g.company, &g.members)
            } else {
                None
            };
            let Valuation { value: v, production_points: pp } = match &best {
                Some(b) => {
                    let class_len = self.env.key_words(g.company, b, &mut words);
                    self.env.value_of(g.company, b, &words, class_len)
                }
                None => self.env.value_of(g.company, &g.members, &words, class_len),
            };
            let (c, was) = (
                &self.env.plan.companies[g.company],
                &self.env.plan.companies[self.env.company_at[slot]],
            );
            let (cp, wp, margin) = (c.record.product, was.record.product, c.record.margin);
            gain += v - self.value[slot];
            let money = self.money[slot];
            if cp == wp {
                add_money(&mut by_product, cp, &|x| x + margin * pp - money);
            } else {
                add_money(&mut by_product, cp, &|x| x + margin * pp);
                add_money(&mut by_product, wp, &|x| x - money);
            }
            if self.switches.is_some() {
                let gv = v + (self.game_margin(g.company) - margin) * pp;
                self.game_gain += gv - self.game_value[slot];
                if retool.is_some_and(|r| r.slot == slot) {
                    self.switch_production_points = pp;
                    self.reads.own_gain = Some(LiveAndGame {
                        live: v - self.value[slot],
                        game: gv - self.game_value[slot],
                    });
                    if !contended {
                        self.reads.scored_company = Some(Rc::new(ScoredCompany {
                            members: best.unwrap_or_else(|| g.members.clone()),
                            value: v,
                            game_value: gv,
                        }));
                    }
                }
            }
        }
        self.key_buffer = words;
        if !types.is_empty() {
            self.handed.keep(Timelines { lines, contended });
        }
        self.exposure = by_product.iter().fold(0.0, |a, x| a + x.money.abs());
        self.by_product = Rc::new(by_product);
        self.reads.types = types;
        Some(gain)
    }

    /// A synthetic tool of type `ty` at `bonus` that never runs out, for
    /// the bounds (one per type).
    fn full_tool(&mut self, ty: u32, bonus: f64) -> usize {
        if let Some(&t) = self.full_tools.get(&ty) {
            return t;
        }
        let tools = &mut self.env.plan.tools;
        tools.push(PlanTool {
            id: "best".into(),
            key_word: (1 << 63) | ty as u64,
            tool_type: ty,
            bonus,
            hours: f64::INFINITY,
            holder: Holder::Free,
            class: usize::MAX,
        });
        let t = tools.len() - 1;
        self.full_tools.insert(ty, t);
        t
    }

    /// Every member with the best tool of the good's type all
    /// along, or none where that is worth more to them.
    fn best_case(&mut self, company: usize, members: &[PlanMember]) -> Option<Vec<PlanMember>> {
        let c = &self.env.plan.companies[company];
        if c.record.margin < 0.0 || self.game_margin(company) < 0.0 {
            return None;
        }
        let ty = c.tool_type_of();
        let best = self.best_bonus.get(&ty).copied();
        let mut out = Vec::with_capacity(members.len());
        for m in members {
            let handy = if self.env.plan.has(m.employee, Trait::Handy) { 40.0 } else { 0.0 };
            let without = if self.env.plan.has(m.employee, Trait::Improviser) { 25.0 } else { 0.0 };
            let held = match best {
                Some(b) => b + handy,
                None => {
                    if handy != 0.0 {
                        handy
                    } else {
                        f64::NEG_INFINITY
                    }
                }
            };
            let tool = if held > without {
                Some(match best {
                    Some(b) => self.full_tool(ty, b),
                    None => self.full_tool(intern(NONE_TYPE), 0.0),
                })
            } else {
                None
            };
            out.push(PlanMember { employee: m.employee, tool, line: None });
        }
        Some(out)
    }

    /// The best case of `company` with `ids` as members, kept by its record,
    /// good and members (`key`: a buffer for the key).
    fn best_value(
        &mut self,
        company: usize,
        ids: &[usize],
        key: &mut Vec<usize>,
    ) -> Option<LiveAndGame> {
        let c = &self.env.plan.companies[company];
        key.clear();
        key.extend([c.record.id as usize, c.record.product as usize]);
        key.extend_from_slice(ids);
        if let Some(&v) = self.best_values.get(&key[..]) {
            return v;
        }
        let members: Vec<PlanMember> =
            ids.iter().map(|&e| PlanMember { employee: e, tool: None, line: None }).collect();
        let v = self.best_case(company, &members).map(|best| {
            let k = self.env.key(company, &best);
            let Valuation { value: v, production_points: pp } = self.env.value(company, &best, &k);
            LiveAndGame {
                live: v,
                game: v
                    + (self.game_margin(company) - self.env.plan.companies[company].record.margin)
                        * pp,
            }
        });
        self.best_values.insert(key[..].into(), v);
        v
    }

    fn estimate(&mut self, c: &Candidate) -> Option<LiveAndGame> {
        let Retool { slot: rid, company: rco } = c.retool?;
        let ripple = *self.ripple.get(&(rid, self.env.plan.companies[rco].tool_type_of()))?;
        if ripple.round != self.rounds {
            return None;
        }
        let mut buffers = std::mem::take(&mut self.estimate_buffers);
        let out = self.estimate_from(c, Retool { slot: rid, company: rco }, ripple, &mut buffers);
        self.estimate_buffers = buffers;
        out
    }

    fn estimate_from(
        &mut self,
        c: &Candidate,
        Retool { slot: rid, company: rco }: Retool,
        ripple: Ripple,
        buffers: &mut EstimateBuffers,
    ) -> Option<LiveAndGame> {
        let EstimateBuffers { over, touched, ids, key } = buffers;
        // (employee, company place): where each changed employee ends up.
        over.clear();
        for change in c.changes.iter() {
            match over.iter_mut().find(|(e, _)| *e == change.employee) {
                Some((_, to)) => *to = change.company,
                None => over.push((change.employee, change.company)),
            }
        }
        touched.clear();
        touched.push(rid);
        for &(id, company) in over.iter() {
            for x in [self.place_of(id), company] {
                if !touched.contains(&x) {
                    touched.push(x);
                }
            }
        }
        let (mut live, mut game) = (ripple.live, ripple.game);
        for &id in touched.iter() {
            ids.clear();
            ids.extend(
                self.roster[id].iter().copied().filter(|&x| {
                    over.iter().find(|(e, _)| *e == x).is_none_or(|&(_, to)| to == id)
                }),
            );
            for &(x, to) in over.iter() {
                if to == id && self.assignment[x].company != Some(id) {
                    ids.push(x);
                }
            }
            let company = if rid == id { rco } else { self.env.company_at[id] };
            if ids.len() as f64 > self.env.plan.companies[company].capacity {
                return Some(LiveAndGame { live: f64::NEG_INFINITY, game: f64::NEG_INFINITY });
            }
            sort_places(ids, &by_place);
            let best = self.best_value(company, ids, key)?;
            live += best.live - self.value[id];
            game += best.game - self.game_value[id];
        }
        Some(LiveAndGame { live, game })
    }

    fn sibling(&mut self, c: &Candidate, bound: bool) -> Option<f64> {
        let state = c.sibling_state.as_ref()?;
        let (scored_company, score) = {
            let st = state.borrow();
            if bound {
                (st.bound_scored_company.clone(), st.bound_score)
            } else {
                (st.scored_company.clone(), st.score)
            }
        };
        let score = score?;
        if score.round != self.rounds {
            return None;
        }
        // Without the sibling's own gain there is nothing to derive this one
        // from: it is scored in full.
        let gain = score.gain?;
        let scored_company = scored_company?;
        let next = c.retool?.company;
        if bound
            && (self.env.plan.companies[next].record.margin < 0.0 || self.game_margin(next) < 0.0)
        {
            return None;
        }
        let k = self.env.key(next, &scored_company.members);
        let Valuation { value: v, production_points: pp } =
            self.env.value(next, &scored_company.members, &k);
        self.game_gain = score.game_gain - scored_company.game_value
            + v
            + (self.game_margin(next) - self.env.plan.companies[next].record.margin) * pp;
        self.switch_production_points = pp;
        self.exposure = 0.0;
        self.by_product = Rc::default();
        Some(gain - scored_company.value + v)
    }

    /// A follow-up with its switch: a bound, to skip the hopeless (true).
    /// `places` and `at` are buffers for the places it touches and their
    /// versions.
    fn follow_up_bound(
        &mut self,
        c: &mut Candidate,
        retool: Retool,
        round: &Round,
        places: &mut Vec<usize>,
        at: &mut Vec<u64>,
    ) -> bool {
        let rounds = self.rounds;
        let slot = retool.slot;
        let need = self.switch_need(retool, &c.changes);
        let hold_live = round.hold_live.get(&slot).copied().unwrap_or(f64::NEG_INFINITY);
        let best_gain = round.best_gain;
        let hopeless = |live: f64, game: f64| {
            live.min(game) <= need.max(best_gain) + 1e-9 && live <= need.max(hold_live) + 1e-9
        };
        places.clear();
        places.push(slot);
        for change in c.changes.iter() {
            for x in [self.place_of(change.employee), change.company] {
                if !places.contains(&x) {
                    places.push(x);
                }
            }
        }
        at.clear();
        at.extend(places.iter().map(|&i| self.versions[i]));
        if let Some(was) = self.earlier.get(&c.key)
            && was.versions == *at
            && hopeless(was.live, was.game)
        {
            self.switch_stats.pruned += 1.0;
            self.switch_stats.lazy += 1.0;
            return true;
        }
        if let Some(estimate) = self.estimate(c)
            && hopeless(estimate.live, estimate.game)
        {
            self.switch_stats.pruned += 1.0;
            self.switch_stats.estimated += 1.0;
            return true;
        }
        let mut upper_bound = if c.sibling_state.is_some() {
            self.sibling(c, /* bound */ true)
        } else {
            None
        };
        if upper_bound.is_none() {
            let score = self.score(&c.changes, &c.key, c.retool, /* bound */ true);
            c.note(|st| st.bound_scored_company = score.scored_company);
            c.own_gain = score.own_gain;
            upper_bound = score.gain;
        }
        let game_gain = self.game_gain;
        c.note(|st| {
            st.bound_score = Some(RoundScore { round: rounds, gain: upper_bound, game_gain })
        });
        if let Some(u) = upper_bound {
            self.earlier.insert(
                c.key.clone(),
                EarlierBound { versions: at.clone(), live: u, game: self.game_gain },
            );
        }
        if upper_bound.is_none_or(|u| hopeless(u, self.game_gain)) {
            self.switch_stats.pruned += 1.0;
            return true;
        }
        false
    }

    /// One candidate weighed: the gain it ranks by, or None to skip it.
    fn weigh(&mut self, c: &mut Candidate, round: &mut Round) -> Option<f64> {
        let rounds = self.rounds;
        // A follow-up with its switch: first a bound, to skip the hopeless.
        if c.alone.is_some()
            && let Some(retool) = c.retool
        {
            let (mut places, mut at) =
                (std::mem::take(&mut self.places), std::mem::take(&mut self.versions_at));
            let hopeless = self.follow_up_bound(c, retool, round, &mut places, &mut at);
            (self.places, self.versions_at) = (places, at);
            if hopeless {
                return None;
            }
        }
        let sibling_gain = if c.sibling_state.is_some() {
            self.sibling(c, /* bound */ false)
        } else {
            None
        };
        c.scored_fully = sibling_gain.is_none();
        let gain = match sibling_gain {
            Some(v) => Some(v),
            None => {
                let score = self.score(&c.changes, &c.key, c.retool, /* bound */ false);
                c.note(|st| st.scored_company = score.scored_company);
                c.own_gain = score.own_gain;
                score.gain
            }
        };
        if let Some(Retool { slot, company }) = c.retool {
            self.switch_stats.candidates += 1.0;
            let game_gain = self.game_gain;
            c.note(|st| st.score = Some(RoundScore { round: rounds, gain, game_gain }));
            if c.alone.is_none()
                && let (Some(g), Some(own)) = (gain, if c.scored_fully { c.own_gain } else { None })
            {
                let at = (slot, self.env.plan.companies[company].tool_type_of());
                let (live, game) = ((g - own.live).max(0.0), (self.game_gain - own.game).max(0.0));
                let next = match self.ripple.get(&at) {
                    Some(w) if w.round == rounds => {
                        Ripple { round: rounds, live: w.live.max(live), game: w.game.max(game) }
                    }
                    _ => Ripple { round: rounds, live, game },
                };
                self.ripple.insert(at, next);
            }
        }
        self.candidates += 1.0;
        let gain = gain?;
        if let Some(retool) = c.retool {
            let Retool { slot, company } = retool;
            let (total_live, total_game, pp) =
                (gain, self.game_gain, self.switch_production_points);
            let need = self.switch_need(retool, &c.changes);
            let (mut live, mut game) = (total_live, total_game);
            let hold = round.hold_live.get(&slot).copied();
            let could_win = live.min(game) > need.max(round.best_gain) + 1e-9;
            let could_hold = live > need + 1e-9 && live > hold.unwrap_or(f64::NEG_INFINITY);
            if let Some(alone) = c.alone.clone() {
                // The follow-up alone is credited only where the switch could
                // win or hold; otherwise the candidate is skipped.
                if !(could_win || could_hold) {
                    return None;
                }
                let kept = (
                    self.exposure,
                    self.by_product.clone(),
                    self.game_gain,
                    self.switch_production_points,
                );
                let alone_gain =
                    self.score(&alone.changes, &alone.key, None, /* bound */ false).gain;
                let credit = LiveAndGame {
                    live: alone_gain.unwrap_or(0.0).max(0.0),
                    game: (if alone_gain.is_none() { 0.0 } else { self.game_gain }).max(0.0),
                };
                (self.exposure, self.by_product, self.game_gain, self.switch_production_points) =
                    kept;
                live -= credit.live;
                game -= credit.game;
            }
            if live.min(game) <= need + 1e-9 {
                let to = self.env.plan.companies[company].record.product;
                let at = (slot, to);
                if live > need + 1e-9 && round.holds.get(&at).is_none_or(|w| live > w.live) {
                    let spike = self.switches.as_ref().is_some_and(|s| s.spike(to));
                    round.holds.set(
                        at,
                        Hold {
                            slot,
                            from: self.env.plan.companies[slot].record.product,
                            to,
                            live,
                            game,
                            need,
                            spike,
                            key: c.key.clone(),
                        },
                    );
                    if !hold.is_some_and(|h| live <= h) {
                        round.hold_live.insert(slot, live);
                    }
                }
                return None;
            }
            c.priced = Some(Priced {
                gain,
                exposure: 0.0,
                need,
                switch: Some(SwitchGain { live, game, production_points: pp }),
            });
            return Some(total_live.min(total_game));
        } else if !self.options.min_max {
            let robust = gain - churn::PRICE_UNCERTAINTY * self.exposure;
            let need = self.floor_for(&c.changes);
            if robust < need {
                if gain > 1e-7 {
                    let mut who: Vec<usize> = Vec::new();
                    for change in c.changes.iter() {
                        if !who.contains(&change.employee) {
                            who.push(change.employee);
                        }
                    }
                    sort_places(&mut who, &by_place);
                    if round.dropped.get(&who).is_none_or(|w| gain > w.gain) {
                        round
                            .dropped
                            .set(who, Dropped { gain, robust, need, changes: c.changes.clone() });
                    }
                }
                return None;
            }
            c.priced = Some(Priced { gain, exposure: self.exposure, need, switch: None });
            return Some(robust);
        }
        Some(gain)
    }

    /// One round of the search: false when it is done.
    pub fn step(&mut self) -> bool {
        if self.done {
            return false;
        }
        if self.rounds >= self.max_rounds {
            self.limited = true;
            self.stopped = "rounds";
            self.done = true;
            return false;
        }
        let n = self.people.len();
        let mut lists: Vec<Vec<usize>> = vec![Vec::new(); n];
        for i in 0..n {
            for j in i + 1..n {
                let (a, b) = (self.people[i], self.people[j]);
                if !self.movable(a)
                    || !self.movable(b)
                    || self.assignment[a].company == self.assignment[b].company
                {
                    continue;
                }
                if (i + j) % 2 == 1 {
                    lists[i].push(b);
                } else {
                    lists[j].push(a);
                }
            }
        }
        let mut queues: Vec<Vec<Candidate>> = Vec::new();
        for (i, partners) in lists.iter().enumerate() {
            queues.push(self.candidates_for(self.people[i], partners, None, /* best */ false));
        }
        queues.extend(self.switch_candidates());
        let start = self.rounds as usize % queues.len().max(1);
        // The best candidate so far: (queue, depth).
        let mut best: Option<(usize, usize)> = None;
        let mut round = Round {
            best_gain: 1e-7,
            dropped: Ordered::new(),
            holds: Ordered::new(),
            hold_live: FastMap::default(),
        };
        let deepest = queues.iter().map(|q| q.len()).max().unwrap_or(0);
        'outer: for depth in 0..deepest {
            for k in 0..queues.len() {
                let qi = (start + k) % queues.len();
                if depth >= queues[qi].len() {
                    continue;
                }
                self.last_check = self.env.misses;
                if self.env.misses >= self.options.max_projections {
                    self.limited = true;
                    self.stopped = "budget";
                    if self.switches.is_some() {
                        self.switch_stats.cut =
                            queues.iter().any(|q| q.len() > depth && q[0].retool.is_some());
                    }
                    break 'outer;
                }
                let c = &mut queues[qi][depth];
                let g = self.weigh(c, &mut round);
                if let Some(g) = g {
                    // Within 1e-9, the earlier candidate (by queue, then depth).
                    let wins = g > round.best_gain + 1e-9
                        || best.is_some_and(|earlier| {
                            (g - round.best_gain).abs() <= 1e-9 && (qi, depth) < earlier
                        });
                    if wins {
                        best = Some((qi, depth));
                        round.best_gain = g;
                        c.rank = g;
                        c.by_product = Some(self.by_product.clone());
                        if self.switches.is_some() {
                            c.game_gain = self.game_gain;
                        }
                    }
                }
            }
        }
        self.rounds += 1;
        if !self.options.min_max {
            let mut left: Vec<Dropped> = round.dropped.values;
            sort_list(&mut left, &|x, y| y.gain.total_cmp(&x.gain));
            let (count, top_gain) = (left.len() as f64, left.first().map_or(0.0, |x| x.gain));
            left.truncate(5);
            self.dropped = Some(DroppedSummary { count, best: top_gain, top: left });
        }
        if self.switches.is_some() {
            let mut holds: Vec<Hold> = round.holds.values;
            sort_list(&mut holds, &|x, y| y.live.total_cmp(&x.live));
            let mut seen: Vec<usize> = Vec::new();
            holds.retain(|h| {
                if seen.contains(&h.slot) {
                    false
                } else {
                    seen.push(h.slot);
                    true
                }
            });
            self.holds = Some(holds);
        }
        let Some((bq, bd)) = best else {
            if self.options.follow_ups && self.switches.is_some() && !self.stuck && !self.limited {
                self.stuck = true;
                return true;
            }
            self.done = true;
            return false;
        };
        self.stuck = false;
        let b = std::mem::replace(&mut queues[bq][bd], Candidate::taken());
        self.accept(b);
        if self.limited {
            self.done = true;
            return false;
        }
        true
    }

    fn accept(&mut self, best: Candidate) {
        let priced = best.priced.as_ref();
        self.accepted.push(Accepted {
            key: best.key.clone(),
            changes: best.changes.clone(),
            gain: priced.map_or(best.rank, |p| p.gain),
            exposure: priced.map(|p| p.exposure),
            need: priced.map_or(0.0, |p| p.need),
            by_product: best.by_product.clone().unwrap_or_default(),
            game: self.switches.is_some().then_some(best.game_gain),
            switch: if self.switches.is_some() {
                best.retool.map(|r| CompanySwitch {
                    slot: r.slot,
                    product: self.env.plan.companies[r.company].record.product,
                })
            } else {
                None
            },
        });
        if let Some(retool) = best.retool {
            let slot = retool.slot;
            let prior = self.reports.iter().position(|w| w.slot == slot);
            let report = if retool.company == slot {
                None
            } else {
                let gain = best
                    .priced
                    .as_ref()
                    .and_then(|p| p.switch)
                    .expect("a switch that wins is priced with its gain");
                let prior_switch = prior.map(|i| {
                    let w = &self.reports[i];
                    PriorSwitch { live: w.live, game: w.game, moves: w.moves.clone() }
                });
                let mut r = self.switch_report(&best, retool, gain, prior_switch);
                r.follow_up = best.follow_up.clone();
                let mut spares: Vec<usize> = best
                    .changes
                    .iter()
                    .filter_map(|x| x.tool)
                    .filter(|&t| self.holder[t].is_none())
                    .collect();
                sort_places(&mut spares, &by_place);
                r.spares = spares;
                Some(r)
            };
            if let Some(i) = prior {
                self.reports.remove(i);
            }
            if let Some(r) = report {
                self.reports.push(r);
            }
            if let Some(i) = self
                .steps
                .iter()
                .position(|x| matches!(x, Step::Switch { slot: s, .. } if *s == slot))
            {
                self.steps.remove(i);
            }
        }
        self.apply(best);
    }

    fn switch_report(
        &mut self,
        c: &Candidate,
        retool: Retool,
        gain: SwitchGain,
        prior: Option<PriorSwitch>,
    ) -> Report {
        let Retool { slot: id, company: next } = retool;
        let SwitchGain { mut live, mut game, production_points: pp } = gain;
        let horizon_days = self.horizon_days;
        let prior_moves = prior.as_ref().map(|p| p.moves.clone()).unwrap_or_default();
        if let Some(p) = &prior {
            live += p.live * horizon_days;
            game += p.game * horizon_days;
        }
        let plan = &self.env.plan;
        let (n, old) = (&plan.companies[next], &plan.companies[id]);
        let cost = n.cost;
        let worse = live.min(game);
        let gross = (worse + cost.unwrap_or(0.0)) / horizon_days;
        let break_even = (pp > 0.0).then(|| n.record.margin - live / pp);
        let mut into: Vec<usize> = Vec::new();
        for &Change { employee: e, company, .. } in c.changes.iter() {
            if company == id && self.assignment[e].company != Some(id) && !into.contains(&e) {
                into.push(e);
            }
        }
        let mut members: Vec<usize> = self.roster[id].clone();
        members.extend(into.iter().copied());
        sort_places(&mut members, &by_place);
        let before_of: Vec<usize> = (0..plan.people.len())
            .map(|e| match self.assignment[e].company {
                Some(c) if c != id => self.env.company_at[c],
                _ => id,
            })
            .collect();
        let before = |e: usize| before_of[e];
        let np = n.record.product;
        let ramp = members
            .iter()
            .map(|&e| {
                let from =
                    self.env.saved_days(e, plan.companies[before(e)].record.product).min(20.0);
                let to = saved_specialization(self.env.saved_days(e, np));
                let rate = if plan.has(e, Trait::QuickStudy) { 2.0 } else { 1.0 };
                let days = ((from.min(20.0) - to) / rate).ceil().max(0.0);
                Ramp {
                    employee: e,
                    from,
                    to,
                    days,
                    moved_in: into.contains(&e) || prior_moves.contains(&e),
                }
            })
            .collect();
        let mut tools_off: Vec<usize> = self.roster[id]
            .iter()
            .filter_map(|&e| self.assignment[e].tool)
            .filter(|&t| !self.env.compatible(t, next))
            .collect();
        sort_places(&mut tools_off, &by_place);
        let (from_product, concrete, old_margin) =
            (old.record.product, n.concrete, old.record.margin);
        let mut traits = Vec::new();
        for &e in &members {
            let a = self.env.alone_production(before(e), e);
            let b = self.env.alone_production(next, e);
            if let (Some(a), Some(b)) = (a, b)
                && (a - b).abs() > 1e-9
            {
                let codes = self.env.plan.people[e]
                    .traits
                    .iter()
                    .filter_map(|t| match t.id {
                        Some(Trait::Specialist) => Some("specialist"),
                        Some(Trait::Craftsman) => Some("craftsman"),
                        Some(Trait::Laborer) => Some("laborer"),
                        _ => None,
                    })
                    .collect();
                traits.push(TraitShift { employee: e, codes, from: a, to: b });
            }
        }
        let switches =
            self.switches.as_ref().expect("switch reports are made only with switch options");
        let mut moves = prior_moves.clone();
        for &e in &into {
            if !moves.contains(&e) {
                moves.push(e);
            }
        }
        Report {
            slot: id,
            from: from_product,
            to: np,
            cost,
            concrete,
            live: live / horizon_days,
            game: game / horizon_days,
            payback: payback(cost, gross),
            break_even: break_even.map(|margin| BreakEven {
                margin,
                ratio: (old_margin != 0.0).then(|| margin / old_margin),
            }),
            spike: switches.spike(np),
            ratio: switches.ratio(np),
            ramp,
            tools_off,
            traits,
            moves,
            follow_up: None,
            spares: Vec::new(),
        }
    }

    fn apply(&mut self, best: Candidate) {
        if let Some(Retool { slot, company }) = best.retool {
            self.env.company_at[slot] = company;
            self.tool_types[slot] = self.env.plan.companies[company].tool_type_of();
            let i = self.switched.iter().position(|x| x.slot == slot);
            if company == slot {
                if let Some(i) = i {
                    self.switched.remove(i);
                }
            } else {
                let product = self.env.plan.companies[company].record.product;
                match i {
                    Some(i) => self.switched[i].product = product,
                    None => self.switched.push(CompanySwitch { slot, product }),
                }
            }
        }
        for &Change { employee: id, company, tool } in best.changes.iter() {
            let was = self.assignment[id];
            if let Some(t) = was.tool {
                self.holder[t] = None;
            }
            if let Some(w) = was.company {
                self.roster[w].retain(|&x| x != id);
            }
            self.roster[company].push(id);
            self.assignment[id] = Placement { company: Some(company), tool };
        }
        for &Change { employee: id, tool, .. } in best.changes.iter() {
            if let Some(t) = tool {
                self.holder[t] = Some(id);
            }
        }
        self.refresh();
        let switch_step = best.retool.filter(|r| r.company != r.slot).map(|r| Step::Switch {
            slot: r.slot,
            from: self.env.plan.companies[r.slot].record.product,
            to: self.env.plan.companies[r.company].record.product,
        });
        let steps = best.steps.as_deref().unwrap_or(&[]);
        for x in switch_step.into_iter().chain(steps.iter().cloned()) {
            match x {
                Step::Move { employee, .. } => self.moved[employee] = true,
                Step::Swap { a, b } => {
                    self.moved[a] = true;
                    self.moved[b] = true;
                }
                Step::Switch { .. } => {}
            }
            self.steps.push(x);
        }
    }

    /// `remaining` for the output-only comparison, and whether the full
    /// model differs from output only (training, toolboxes, recruiting).
    pub fn floor(&self) -> f64 {
        self.floor
    }

    /// The result so far (`result(partial)`).
    pub fn result(&mut self, partial: bool) -> SearchOut<'_> {
        let proposed = self.env.totals(&self.assignment, /* rows */ true);
        SearchOut { search: self, partial, proposed }
    }
}

// --- The output-only comparison ---

/// A different objective can steer a greedy search into a worse local
/// optimum, so `recommend` also searches for output alone (no training,
/// toolboxes or recruiting) with the projections left, comparing switches
/// alone and with free tools only, and scores that plan with the full model.
pub struct OutputOnly {
    pub alternative: Search,
    /// The output-only plan, on its own switches, by the full model (None if it doesn't validate).
    pub scored: Option<Totals>,
    /// Whether it beats the primary plan.
    pub selected: bool,
    /// Planned companies: `evaluate` projects each once.
    pub planned: usize,
}

/// The comparison's terms once the main search has finished: the
/// projections it left (`budget`) and the value of its plan, which the
/// output-only plan must beat.
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Terms {
    pub budget: f64,
    pub value: f64,
}

/// The output-only comparison's search, a round at a time, so it can run
/// alongside the main search: started with the most projections the main
/// search can leave (`budget` before it runs), then held to the budget it
/// did leave (`within`, `limit`).
pub struct Comparison {
    alternative: Search,
    switches: Option<SwitchContext>,
    company_count: usize,
    planned: usize,
}

impl Comparison {
    /// The projections `primary` leaves the comparison, or None when it
    /// isn't made: no more than the planned companies' left, or a model
    /// with nothing besides output. Projections only grow, so before
    /// `primary` runs this is the most it can leave.
    pub fn budget(primary: &Search) -> Option<f64> {
        let plan = &primary.env.plan;
        let planned = primary.env.planned.len();
        let remaining = primary.options.max_projections - primary.env.misses - planned as f64;
        let more = plan.toolbox != 0.0
            || plan.quota != 0.0
            || primary.env.planned.iter().any(|&s| plan.companies[s].record.recruitment.is_some());
        (remaining > planned as f64 && more).then_some(remaining)
    }

    /// The comparison for `primary`, the search of `snapshot` with switch
    /// options `switches`, searching with `budget` projections.
    pub fn new(
        primary: &Search,
        snapshot: &Snapshot,
        switches: Option<SwitchContext>,
        budget: f64,
    ) -> Comparison {
        // The snapshot without training, toolboxes or recruiting, through
        // the stat check again.
        let mut plan = Plan::new(snapshot);
        plan.quota = 0.0;
        plan.toolbox = 0.0;
        for c in &mut plan.companies {
            c.record.recruitment = None;
        }
        let company_count = plan.company_count;
        let skip: Vec<bool> = (0..company_count).map(|s| plan.companies[s].excluded).collect();
        let mut env = Env::new(plan);
        let mismatches = env.observed_mismatches(&skip);
        let mut plan = env.plan;
        for mismatch in mismatches {
            let id = plan.companies[mismatch.company].record.id;
            for s in 0..company_count {
                if plan.companies[s].record.id == id {
                    plan.companies[s].excluded = true;
                }
            }
        }
        let options = Options {
            max_projections: budget,
            allow_moves: primary.options.allow_moves,
            min_max: primary.options.min_max,
            floor_at: Some(primary.floor),
            follow_ups: false,
        };
        let alternative = Search::new(plan, switches.clone(), options);
        Comparison { alternative, switches, company_count, planned: primary.env.planned.len() }
    }

    /// One round: false when the search is done.
    pub fn step(&mut self) -> bool {
        self.alternative.step()
    }

    /// Whether the search so far is the one `budget` makes: every budget
    /// check so far ran below it.
    pub fn within(&self, budget: f64) -> bool {
        self.alternative.last_check < budget
    }

    /// Searches on with `budget` (one it is `within`).
    pub fn limit(&mut self, budget: f64) {
        self.alternative.options.max_projections = budget;
    }

    /// The finished search's plan, on its own switches, scored by the full
    /// model on `snapshot`, against a main plan worth `primary_value`.
    pub fn finish(self, snapshot: &Snapshot, primary_value: f64) -> OutputOnly {
        let Comparison { alternative, switches, company_count, planned } = self;
        let mut env = Env::new(Plan::new(snapshot));
        if let Some(switches) = &switches {
            for &CompanySwitch { slot, product } in &alternative.switched {
                let id = env.plan.companies[slot].record.id;
                let first = (0..company_count)
                    .find(|&s| env.plan.companies[s].record.id == id)
                    .unwrap_or(slot);
                let c = switches
                    .retool(&env.plan.companies[first], product)
                    .expect("the search switches only onto goods with a margin");
                env.plan.companies.push(c);
                let at = env.plan.companies.len() - 1;
                for s in 0..company_count {
                    if env.plan.companies[s].record.id == id {
                        env.company_at[s] = at;
                    }
                }
            }
        }
        let valid =
            validate(&env, &ArrangementEntry::of(&env.plan, &alternative.assignment)).is_empty();
        let scored = valid.then(|| env.totals(&alternative.assignment, /* rows */ true));
        let selected = scored.as_ref().is_some_and(|t| t.value > primary_value + 1e-7);
        OutputOnly { alternative, scored, selected, planned }
    }
}

/// The comparison after `primary` finished with a plan worth
/// `primary_value`, or None when it isn't made (`Comparison::budget`).
/// `snapshot` is the one `primary` searched, `switches` its switch options.
pub fn output_only(
    primary: &Search,
    snapshot: &Snapshot,
    switches: Option<SwitchContext>,
    primary_value: f64,
) -> Option<OutputOnly> {
    let budget = Comparison::budget(primary)?;
    let mut comparison = Comparison::new(primary, snapshot, switches, budget);
    while comparison.step() {}
    Some(comparison.finish(snapshot, primary_value))
}

/// `merge`: a follow-up's changes override the switch's own for the same person.
fn merge(a: &[Change], b: &[Change]) -> Vec<Change> {
    let mut merged: Vec<Change> = a.to_vec();
    for &x in b {
        match merged.iter_mut().find(|y| y.employee == x.employee) {
            Some(y) => *y = x,
            None => merged.push(x),
        }
    }
    merged
}

// --- The search's result, as it crosses to the facade ---

pub struct SearchOut<'a> {
    search: &'a Search,
    partial: bool,
    proposed: Totals,
}
impl SearchOut<'_> {
    /// The proposed plan's value.
    pub fn value(&self) -> f64 {
        self.proposed.value
    }
}

/// Changes as `[employee, company, tool]` ids: the tuples serialize as
/// arrays.
struct ChangesOut<'a> {
    search: &'a Search,
    changes: &'a [Change],
}
impl Serialize for ChangesOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let plan = &self.search.env.plan;
        let list: Vec<(&str, &str, Option<&str>)> = self
            .changes
            .iter()
            .map(|c| {
                (
                    &*plan.employee_ids[c.employee],
                    &*plan.companies[c.company].id,
                    c.tool.map(|t| &*plan.tools[t].id),
                )
            })
            .collect();
        list.serialize(s)
    }
}
/// A candidate's key as `{ kind, ... }` (`tool`, `move`, `swap`, `product`,
/// `alone`): employees, companies and goods by id, a tool class by one of
/// its tools (null for no tool). The facade writes it as text.
struct KeyOut<'a> {
    plan: &'a Plan,
    key: &'a CandidateKey,
}
impl Serialize for KeyOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let plan = self.plan;
        let employee = |e: usize| &*plan.employee_ids[e];
        let company = |c: usize| &*plan.companies[c].id;
        let class = |k: Option<usize>| k.map(|k| &*plan.tools[plan.class_tools[k]].id);
        let mut m = s.serialize_map(None)?;
        match self.key {
            &CandidateKey::Tool { employee: e, class: k, from } => {
                m.serialize_entry("kind", "tool")?;
                m.serialize_entry("employee", employee(e))?;
                m.serialize_entry("tool", &class(k))?;
                m.serialize_entry("from", &from.map(employee))?;
            }
            &CandidateKey::Move { employee: e, company: c, class: k } => {
                m.serialize_entry("kind", "move")?;
                m.serialize_entry("employee", employee(e))?;
                m.serialize_entry("company", company(c))?;
                m.serialize_entry("tool", &class(k))?;
            }
            &CandidateKey::Swap { a, b, tools } => {
                /// `"keep"`, `"stay"` or `{ employee, tool }`.
                struct ToolsOut<'a>(SwapTools, &'a Plan);
                impl Serialize for ToolsOut<'_> {
                    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                        match self.0 {
                            SwapTools::Keep => s.serialize_str("keep"),
                            SwapTools::Stay => s.serialize_str("stay"),
                            SwapTools::Give { employee, class } => {
                                let plan = self.1;
                                let mut m = s.serialize_map(Some(2))?;
                                m.serialize_entry("employee", &*plan.employee_ids[employee])?;
                                m.serialize_entry(
                                    "tool",
                                    &*plan.tools[plan.class_tools[class]].id,
                                )?;
                                m.end()
                            }
                        }
                    }
                }
                m.serialize_entry("kind", "swap")?;
                m.serialize_entry("employees", &[employee(a), employee(b)])?;
                m.serialize_entry("tools", &ToolsOut(tools, plan))?;
            }
            CandidateKey::Product { company: c, product, equip, follow_up } => {
                m.serialize_entry("kind", "product")?;
                m.serialize_entry("company", company(*c))?;
                m.serialize_entry("product", &*id_text(*product))?;
                m.serialize_entry("tools", equip)?;
                m.serialize_entry("followUp", &follow_up.as_ref().map(|key| KeyOut { plan, key }))?;
            }
            CandidateKey::Alone { company: c, tool_type, follow_up } => {
                m.serialize_entry("kind", "alone")?;
                m.serialize_entry("company", company(*c))?;
                m.serialize_entry("toolType", &*id_text(*tool_type))?;
                m.serialize_entry("followUp", &KeyOut { plan, key: follow_up })?;
            }
        }
        m.end()
    }
}

struct ByProduct<'a>(&'a [ProductMoney]);
impl Serialize for ByProduct<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for x in self.0 {
            m.serialize_entry(&*id_text(x.product), &x.money)?;
        }
        m.end()
    }
}
struct Steps<'a>(&'a Search);
impl Serialize for Steps<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct StepOut<'a> {
            search: &'a Search,
            step: &'a Step,
        }
        impl Serialize for StepOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let plan = &self.search.env.plan;
                let mut m = s.serialize_map(None)?;
                match *self.step {
                    Step::Move { employee, to } => {
                        m.serialize_entry("kind", "move")?;
                        m.serialize_entry("employees", &[&*plan.employee_ids[employee]])?;
                        m.serialize_entry("to", &*plan.companies[to].id)?;
                    }
                    Step::Swap { a, b } => {
                        m.serialize_entry("kind", "swap")?;
                        m.serialize_entry(
                            "employees",
                            &[&*plan.employee_ids[a], &*plan.employee_ids[b]],
                        )?;
                    }
                    Step::Switch { slot, from, to } => {
                        m.serialize_entry("kind", "switch")?;
                        m.serialize_entry("company", &*plan.companies[slot].id)?;
                        m.serialize_entry("from", &*id_text(from))?;
                        m.serialize_entry("to", &*id_text(to))?;
                        m.serialize_entry("employees", &[] as &[&str])?;
                    }
                }
                m.end()
            }
        }
        let list: Vec<StepOut> =
            self.0.steps.iter().map(|step| StepOut { search: self.0, step }).collect();
        list.serialize(s)
    }
}

/// A place re-tooled onto a good, as `{ company, product }`.
struct SwitchOut<'a> {
    company: &'a str,
    product: Rc<str>,
}
impl Serialize for SwitchOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("company", self.company)?;
        m.serialize_entry("product", &*self.product)?;
        m.end()
    }
}

impl Serialize for SearchOut<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = self.search;
        let plan = &s.env.plan;
        let tool_ids = |v: &[usize]| v.iter().map(|&t| &*plan.tools[t].id).collect::<Vec<_>>();
        let mut m = ser.serialize_map(None)?;
        m.serialize_entry("valid", &true)?;
        m.serialize_entry("partial", &self.partial)?;
        m.serialize_entry("baseline", &s.baseline)?;
        m.serialize_entry("proposed", &self.proposed)?;
        m.serialize_entry("gain", &(self.proposed.value - s.baseline.value))?;
        struct Arrangement<'a>(&'a Search);
        impl Serialize for Arrangement<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                struct PlacementOut<'a> {
                    employee: &'a str,
                    company: Option<&'a str>,
                    tool: Option<&'a str>,
                }
                impl Serialize for PlacementOut<'_> {
                    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                        let mut m = s.serialize_map(Some(3))?;
                        m.serialize_entry("employee", self.employee)?;
                        m.serialize_entry("company", &self.company)?;
                        m.serialize_entry("tool", &self.tool)?;
                        m.end()
                    }
                }
                let plan = &self.0.env.plan;
                let list: Vec<PlacementOut> = (0..plan.people.len())
                    .map(|e| {
                        let placement = self.0.assignment[e];
                        PlacementOut {
                            employee: &plan.employee_ids[e],
                            company: placement.company.map(|c| &*plan.companies[c].id),
                            tool: placement.tool.map(|t| &*plan.tools[t].id),
                        }
                    })
                    .collect();
                list.serialize(s)
            }
        }
        m.serialize_entry("arrangement", &Arrangement(s))?;
        m.serialize_entry("steps", &Steps(s))?;
        let unused: Vec<usize> =
            s.manual.iter().copied().filter(|&t| s.holder[t].is_none()).collect();
        m.serialize_entry("unused", &tool_ids(&unused))?;
        if s.switches.is_some() {
            struct Switched<'a>(&'a Search);
            impl Serialize for Switched<'_> {
                fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                    let plan = &self.0.env.plan;
                    let list: Vec<SwitchOut> = self
                        .0
                        .switched
                        .iter()
                        .map(|x| SwitchOut {
                            company: &plan.companies[x.slot].id,
                            product: id_text(x.product),
                        })
                        .collect();
                    list.serialize(s)
                }
            }
            m.serialize_entry("switched", &Switched(s))?;
            let reports: Vec<ReportOut> = s
                .reports
                .iter()
                .map(|report| {
                    let moves: Vec<&str> = (0..plan.people.len())
                        .filter(|&e| {
                            s.assignment[e].company == Some(report.slot)
                                && plan.company_of[e] != Some(report.slot)
                        })
                        .map(|e| &*plan.employee_ids[e])
                        .collect();
                    ReportOut { search: s, report, moves }
                })
                .collect();
            m.serialize_entry("switches", &reports)?;
        }
        m.serialize_entry("search", &SearchStats(s))?;
        m.end()
    }
}

struct ReportOut<'a> {
    search: &'a Search,
    report: &'a Report,
    moves: Vec<&'a str>,
}
impl Serialize for ReportOut<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let (s, w) = (self.search, self.report);
        let plan = &s.env.plan;
        struct CostsOut<'a> {
            search: &'a Search,
            report: &'a Report,
        }
        impl Serialize for CostsOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let plan = &self.search.env.plan;
                struct RampOut<'a> {
                    employee: &'a str,
                    ramp: &'a Ramp,
                }
                impl Serialize for RampOut<'_> {
                    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                        let mut m = s.serialize_map(Some(5))?;
                        m.serialize_entry("employee", self.employee)?;
                        m.serialize_entry("from", &self.ramp.from)?;
                        m.serialize_entry("to", &self.ramp.to)?;
                        m.serialize_entry("days", &self.ramp.days)?;
                        m.serialize_entry("movedIn", &self.ramp.moved_in)?;
                        m.end()
                    }
                }
                struct TraitShiftOut<'a> {
                    employee: &'a str,
                    shift: &'a TraitShift,
                }
                impl Serialize for TraitShiftOut<'_> {
                    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                        let mut m = s.serialize_map(Some(4))?;
                        m.serialize_entry("employee", self.employee)?;
                        m.serialize_entry("codes", &self.shift.codes[..])?;
                        m.serialize_entry("from", &self.shift.from)?;
                        m.serialize_entry("to", &self.shift.to)?;
                        m.end()
                    }
                }
                let report = self.report;
                let mut m = s.serialize_map(Some(3))?;
                m.serialize_entry(
                    "ramp",
                    &report
                        .ramp
                        .iter()
                        .map(|ramp| RampOut { employee: &plan.employee_ids[ramp.employee], ramp })
                        .collect::<Vec<_>>(),
                )?;
                m.serialize_entry(
                    "toolsOff",
                    &report.tools_off.iter().map(|&t| &*plan.tools[t].id).collect::<Vec<_>>(),
                )?;
                m.serialize_entry(
                    "traits",
                    &report
                        .traits
                        .iter()
                        .map(|shift| TraitShiftOut {
                            employee: &plan.employee_ids[shift.employee],
                            shift,
                        })
                        .collect::<Vec<_>>(),
                )?;
                m.end()
            }
        }
        let mut m = ser.serialize_map(None)?;
        m.serialize_entry("company", &*plan.companies[w.slot].id)?;
        m.serialize_entry("from", &*id_text(w.from))?;
        m.serialize_entry("to", &*id_text(w.to))?;
        m.serialize_entry("cost", &w.cost)?;
        m.serialize_entry("concrete", &w.concrete)?;
        m.serialize_entry("gain", &LiveAndGame { live: w.live, game: w.game })?;
        m.serialize_entry("payback", &w.payback)?;
        m.serialize_entry("breakEven", &w.break_even)?;
        m.serialize_entry("spike", &w.spike)?;
        m.serialize_entry("ratio", &w.ratio)?;
        m.serialize_entry("costs", &CostsOut { search: s, report: w })?;
        m.serialize_entry("moves", &self.moves)?;
        m.serialize_entry("followUp", &w.follow_up.as_deref().map(|key| KeyOut { plan, key }))?;
        m.serialize_entry(
            "spares",
            &w.spares.iter().map(|&t| &*plan.tools[t].id).collect::<Vec<_>>(),
        )?;
        m.end()
    }
}

struct SearchStats<'a>(&'a Search);
impl Serialize for SearchStats<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = self.0;
        struct Threshold(f64);
        impl Serialize for Threshold {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let mut m = s.serialize_map(Some(6))?;
                m.serialize_entry("floor", &self.0)?;
                m.serialize_entry("priceUncertainty", &churn::PRICE_UNCERTAINTY)?;
                m.serialize_entry("floorShare", &churn::FLOOR_SHARE)?;
                m.serialize_entry("floorMin", &churn::FLOOR_MIN)?;
                m.serialize_entry("recentHours", &churn::RECENT_HOURS)?;
                m.serialize_entry("recentFactor", &churn::RECENT_FACTOR)?;
                m.end()
            }
        }
        struct DroppedOut<'a> {
            search: &'a Search,
            dropped: &'a Dropped,
        }
        impl Serialize for DroppedOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let d = self.dropped;
                let mut m = s.serialize_map(Some(4))?;
                m.serialize_entry("gain", &d.gain)?;
                m.serialize_entry("robust", &d.robust)?;
                m.serialize_entry("need", &d.need)?;
                m.serialize_entry(
                    "changes",
                    &ChangesOut { search: self.search, changes: &d.changes },
                )?;
                m.end()
            }
        }
        struct DroppedSummaryOut<'a> {
            search: &'a Search,
            summary: &'a DroppedSummary,
        }
        impl Serialize for DroppedSummaryOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let summary = self.summary;
                let mut m = s.serialize_map(Some(3))?;
                m.serialize_entry("count", &summary.count)?;
                m.serialize_entry("best", &summary.best)?;
                m.serialize_entry(
                    "top",
                    &summary
                        .top
                        .iter()
                        .map(|dropped| DroppedOut { search: self.search, dropped })
                        .collect::<Vec<_>>(),
                )?;
                m.end()
            }
        }
        struct AcceptedOut<'a> {
            search: &'a Search,
            accepted: &'a Accepted,
        }
        impl Serialize for AcceptedOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let (x, a) = (self.search, self.accepted);
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("key", &KeyOut { plan: &x.env.plan, key: &a.key })?;
                m.serialize_entry("changes", &ChangesOut { search: x, changes: &a.changes })?;
                m.serialize_entry("gain", &a.gain)?;
                m.serialize_entry("exposure", &a.exposure)?;
                m.serialize_entry("need", &a.need)?;
                m.serialize_entry("byProduct", &ByProduct(&a.by_product))?;
                if let Some(g) = a.game {
                    m.serialize_entry("game", &g)?;
                }
                if let Some(switch) = a.switch {
                    m.serialize_entry(
                        "switch",
                        &SwitchOut {
                            company: &x.env.plan.companies[switch.slot].id,
                            product: id_text(switch.product),
                        },
                    )?;
                }
                m.end()
            }
        }
        struct HoldOut<'a> {
            search: &'a Search,
            hold: &'a Hold,
        }
        impl Serialize for HoldOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let (x, h) = (self.search, self.hold);
                let horizon_days = x.horizon_days;
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("company", &*x.env.plan.companies[h.slot].id)?;
                m.serialize_entry("from", &*id_text(h.from))?;
                m.serialize_entry("to", &*id_text(h.to))?;
                m.serialize_entry("live", &h.live)?;
                m.serialize_entry("game", &h.game)?;
                m.serialize_entry("need", &h.need)?;
                m.serialize_entry("spike", &h.spike)?;
                m.serialize_entry("key", &KeyOut { plan: &x.env.plan, key: &h.key })?;
                m.serialize_entry(
                    "gain",
                    &LiveAndGame { live: h.live / horizon_days, game: h.game / horizon_days },
                )?;
                m.end()
            }
        }
        let mut m = ser.serialize_map(None)?;
        m.serialize_entry("rounds", &(s.rounds as f64))?;
        m.serialize_entry("candidates", &s.candidates)?;
        m.serialize_entry("projections", &s.env.misses)?;
        m.serialize_entry("maxProjections", &s.options.max_projections)?;
        m.serialize_entry("limited", &s.limited)?;
        m.serialize_entry("stopped", s.stopped)?;
        m.serialize_entry("threshold", &(!s.options.min_max).then_some(Threshold(s.floor)))?;
        m.serialize_entry(
            "dropped",
            &s.dropped.as_ref().map(|summary| DroppedSummaryOut { search: s, summary }),
        )?;
        m.serialize_entry(
            "accepted",
            &s.accepted
                .iter()
                .map(|accepted| AcceptedOut { search: s, accepted })
                .collect::<Vec<_>>(),
        )?;
        if s.switches.is_some() {
            struct SwitchSearchOut<'a>(&'a Search);
            impl Serialize for SwitchSearchOut<'_> {
                fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                    let x = &self.0.switch_stats;
                    let mut m = s.serialize_map(Some(7))?;
                    m.serialize_entry("goods", &x.goods)?;
                    m.serialize_entry("candidates", &x.candidates)?;
                    m.serialize_entry("pruned", &x.pruned)?;
                    m.serialize_entry("lazy", &x.lazy)?;
                    m.serialize_entry("estimated", &x.estimated)?;
                    m.serialize_entry("cut", &x.cut)?;
                    m.serialize_entry("priced", &self.0.env.priced_count)?;
                    m.end()
                }
            }
            m.serialize_entry("switchSearch", &SwitchSearchOut(s))?;
            if let Some(holds) = &s.holds {
                m.serialize_entry(
                    "switchHolds",
                    &holds.iter().map(|hold| HoldOut { search: s, hold }).collect::<Vec<_>>(),
                )?;
            }
        }
        m.end()
    }
}
