//! Card pricing (`EmployeePlanner.cardSession`, the planner worker's
//! `priceSubject` path) and retention (`retentionSession`).
//!
//! A session decodes its snapshot once (`Roster`). Card pricing then works
//! per subject and tool assignment (a `State`): a menu of local plans (moves,
//! swaps, tool choices), each plan's companies laid out once with their tool
//! timelines (`handoffs`) and the subject left as a gap, and a card's
//! variants of the subject (records made from the subject's
//! `EmployeeRecord`, changed by the card's outcomes in the module) projected
//! into that gap with `project::CallProjector`, no JS round trip per variant.
//! Prices the pool asks for (Reroll's outlook) come from `quote` itself
//! (`rules::Price::Given`, failing with its `Fail`).
//!
//! What is kept, and under what key: the session's most recently used
//! projections, by the company's layout and the subject's variant (the
//! fields of the record a card can change, `Pricer::variant_key`); per
//! price, the subject's company in each plan by variant; per (subject,
//! tools) state, its plans and layouts, its `Ranking` (best plan, every
//! plan's value, short menu) by the price's base variant (the subject with
//! the price's numbers, `Pricer::base_variant`), and its quotes and trait
//! shifts by the rules' inputs (`PriceOptions`, which fix the base variant)
//! and card, both compared by value. Employees, companies and tools go in
//! snapshot order, and ties break on it.
//!
//! What the facade (js/employee-planner.js) does around a session: the
//! exclusions and input checks before it (`withExclusions`, `validate`), the
//! price's options merged into `e` and `ctx`, plan descriptions and notes
//! (text), and the retention's warnings and unpriced list.

use crate::cache::Recent;
use crate::cards::Stat;
use crate::cfg::CFG;
use crate::check;
use crate::handoffs::{self, Need, Seated, ToolSpan};
use crate::model::{Card, Code, Context, Kind, RulesEmployee};
use crate::planner;
use crate::project::{
    CallProjector, CompanyRecord, EmployeeRecord, HeldMember, IndexRange, Member, Projected,
    Segment, Tool, TraitRecord, Who, intern, working_days,
};
use crate::rules::{self, ALL_POLARITIES, Memo, OutcomeTrait, Price};
use crate::snapshot::{Snapshot, Truthy};
use crate::sort::sort_places;
use crate::traits::{Polarity, Trait, TraitSet};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::borrow::Cow;
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// Thresholds are evaluated exactly at event boundaries (the planner's EPS).
const EPS: f64 = 1e-9;
/// Plans tested per subject (`CARD_PLAN_CAP`).
pub const PLAN_CAP: usize = 256;
/// Projections kept (`cache::Recent`): about 15 MB at most, and every
/// distinct projection of the capture rosters' card sessions (about 95,000
/// priced, fewer distinct).
const PROJECTIONS_KEPT: usize = 80_000;
/// The short menu: the best plans overall, and the best at each place.
const SCREEN_TOP: usize = 16;
const SCREEN_PER_PLACE: usize = 3;
/// A word no index or interned id takes: the subject's gap in a layout, the
/// end of a list.
const NONE: u64 = u64::MAX;

/// `TOOL_TYPES`: each tool type and the goods it fits.
pub const TOOL_TYPES: [(&str, &[&str]); 6] = [
    ("sickle", &["grain", "livestock", "coca", "wood", "fish"]),
    ("pickaxe", &["limestone", "iron", "lead", "petroleum"]),
    ("skillet", &["bread", "steak", "cookedFish"]),
    ("hammer", &["steel", "concrete"]),
    ("flask", &["oil", "paper", "cocain"]),
    ("caliper", &["lightAmmo", "ammo", "heavyAmmo"]),
];

/// `TOOL_OF[product]`: the tool type a good takes.
pub fn tool_type_of(product: &str) -> Option<&'static str> {
    TOOL_TYPES.iter().find(|(_, goods)| goods.contains(&product)).map(|(ty, _)| *ty)
}

/// Why a price failed; `message` is its text (a card price's `failure`,
/// the error a retention price throws).
#[derive(Clone, Copy)]
pub enum Fail {
    Budget,
    /// The employee isn't in a planned company.
    NotPlanned,
    /// A number the projection reads is missing (`check::numbers_known`).
    UnknownNumbers,
}
impl Fail {
    pub fn message(self) -> &'static str {
        match self {
            Fail::Budget => "Projection budget reached.",
            Fail::NotPlanned => "The employee isn't in a planned company.",
            Fail::UnknownNumbers => check::UNKNOWN_NUMBERS,
        }
    }
}

// --- The snapshot, as card pricing and retention read it ---

#[derive(Clone, Copy, PartialEq)]
enum Holder {
    Free,
    Employee(usize),
    Missing,
}

struct RosterTool {
    tool: Tool,
    holder: Holder,
}

/// A session's snapshot as card pricing and retention read it: each
/// employee and company as the projection reads them and what the planner
/// looks up besides.
pub struct Roster {
    /// Whether every number the projection reads is known where the
    /// session plans (`check::numbers_known`): a price fails if not.
    numbers_known: bool,
    /// `s.days * 24`, the tool timelines' end; `s.hours`, if set, the
    /// projections' (`s.hours ?? s.days * 24`).
    timeline_end: f64,
    projection_hours: Option<f64>,
    training_quota: f64,
    management: f64,
    toolbox_value: f64,
    people: Vec<EmployeeRecord>,
    companies: Vec<CompanyRecord>,
    capacity: Vec<f64>,
    tools: Vec<RosterTool>,
    /// Each employee's equipped tool, by its place in `tools`.
    equipped: Vec<Option<usize>>,
    /// Each employee's company (index), if it is in the snapshot.
    company_of: Vec<Option<usize>>,
    locked: Vec<bool>,
    /// `e.specializations[company.product] || 0`, by employee then company.
    specializations: Vec<f64>,
    /// Traits that change no projection of this snapshot: Recruiter without
    /// a company recruiting, Trainer without trainings beyond one a day.
    idle_traits: TraitSet,
    /// How many employees each company has now.
    current_size: Vec<f64>,
    /// Per employee: hours to retirement, output per point of margin, the
    /// trait points a tool adds.
    retirement: Vec<f64>,
    output_per_margin: Vec<f64>,
    tool_trait_bonus: Vec<f64>,
    /// The companies being planned.
    planned: Vec<usize>,
}

/// An employee and the tool they start with.
#[derive(Clone, Copy)]
struct MemberTool {
    employee: usize,
    tool: Option<usize>,
}
impl Seated for MemberTool {
    fn employee(&self) -> usize {
        self.employee
    }
    fn tool(&self) -> Option<usize> {
        self.tool
    }
}

/// A company and its members, for `handoffs`.
struct CompanyGroup {
    company: usize,
    members: Vec<MemberTool>,
}

/// The subject's place in a company's members, and the variant's record
/// projected there.
#[derive(Clone, Copy)]
struct Gap<'a> {
    member: usize,
    record: &'a EmployeeRecord,
}

/// A projection workspace and the company its call holds (copied in only
/// when it changes).
#[derive(Default)]
struct CompanyProjector {
    calls: CallProjector,
    company: Option<usize>,
}

impl Roster {
    /// The session's snapshot (with its exclusions and horizon).
    pub fn new(s: &Snapshot) -> Roster {
        let company_count = s.companies.len();
        let mut idle_traits = TraitSet::EMPTY;
        if !s.companies.iter().any(|c| c.record.recruitment.is_some()) {
            idle_traits = idle_traits.with(Trait::Recruiter);
        }
        if s.training_quota <= 1.0 {
            idle_traits = idle_traits.with(Trait::Trainer);
        }
        let mut roster = Roster {
            numbers_known: check::numbers_known(&planner::Env::new(planner::Plan::new(s))),
            timeline_end: s.days * 24.0,
            projection_hours: s.hours,
            training_quota: s.training_quota,
            management: s.management,
            toolbox_value: s.toolbox_value,
            people: Vec::with_capacity(s.employees.len()),
            companies: s.companies.iter().map(|c| c.record.clone()).collect(),
            capacity: s.companies.iter().map(|c| c.capacity).collect(),
            tools: s
                .tools
                .iter()
                .map(|t| RosterTool {
                    tool: t.tool,
                    holder: if t.holder == 0 {
                        Holder::Free
                    } else {
                        s.last_employee(t.holder).map_or(Holder::Missing, Holder::Employee)
                    },
                })
                .collect(),
            equipped: Vec::new(),
            company_of: Vec::new(),
            locked: Vec::new(),
            specializations: Vec::new(),
            idle_traits,
            current_size: vec![0.0; company_count],
            retirement: Vec::new(),
            output_per_margin: Vec::new(),
            tool_trait_bonus: Vec::new(),
            planned: Vec::new(),
        };
        for e in &s.employees {
            let record = &e.record;
            roster.company_of.push(s.first_company(record.company));
            roster.locked.push(e.locked);
            roster.equipped.push(s.last_tool(e.equipped));
            for c in &s.companies {
                // `e.specializations[c.product] || 0`.
                let good =
                    if c.record.product == 0 { intern("undefined") } else { c.record.product };
                roster.specializations.push(e.saved_days(good).unwrap_or(0.0));
            }
            roster.retirement.push(working_days(record) * 24.0);
            roster.output_per_margin.push((record.production + record.trait_production) / 4.0);
            roster.tool_trait_bonus.push(record.traits.iter().fold(0.0, |v, t| {
                v + match t.id {
                    Some(Trait::Handy) => 40.0,
                    Some(Trait::Improviser) => -25.0,
                    _ => 0.0,
                }
            }));
            roster.people.push(record.clone());
        }
        for company in roster.company_of.iter().flatten() {
            roster.current_size[*company] += 1.0;
        }
        roster.planned = (0..company_count).filter(|&i| !s.companies[i].excluded).collect();
        roster
    }

    pub fn len(&self) -> usize {
        self.people.len()
    }

    fn compatible(&self, tool: usize, company: usize) -> bool {
        self.companies[company].tool_type == self.tools[tool].tool.tool_type
    }

    fn specialization(&self, employee: usize, company: usize) -> f64 {
        self.specializations[employee * self.companies.len() + company]
    }

    /// The tool timelines of `groups`, by group and member, with `spares` as
    /// the pool (`handoffs::handoffs`).
    fn handoffs(
        &self,
        end: f64,
        groups: &[CompanyGroup],
        spares: impl Iterator<Item = usize>,
    ) -> Vec<Vec<Vec<ToolSpan>>> {
        let members: Vec<&[MemberTool]> = groups.iter().map(|g| &g.members[..]).collect();
        let need = |g: usize, m: &MemberTool| {
            let c = &self.companies[groups[g].company];
            (!c.disabled).then(|| Need {
                tool_type: c.tool_type,
                retire: self.retirement[m.employee],
                worth: self.output_per_margin[m.employee] * c.margin,
                extra: self.tool_trait_bonus[m.employee],
                watched: false,
            })
        };
        handoffs::handoffs(end, &members, |t| self.tools[t].tool, spares, need).lines
    }

    /// Builds the projection's call for one company and projects it: members
    /// in order, each the snapshot's employee or (at the `gap`) the held
    /// variant, with its tool from hour 0 and its timeline.
    fn project<'p>(
        &self,
        projector: &'p mut CompanyProjector,
        end: f64,
        company: usize,
        members: &[LayoutMember],
        gap: Option<Gap>,
    ) -> &'p Projected {
        if projector.company != Some(company) {
            projector.calls.call.company = self.companies[company].clone();
            projector.company = Some(company);
        }
        let call = &mut projector.calls.call;
        call.end = end;
        call.training_quota = self.training_quota;
        call.management = self.management;
        call.toolbox_value = self.toolbox_value;
        call.current_size = self.current_size[company];
        call.members.clear();
        call.segments.clear();
        for (k, member) in members.iter().enumerate() {
            let start = call.segments.len();
            for x in &member.line {
                let t = &self.tools[x.tool].tool;
                call.segments.push(Segment {
                    tool_type: t.tool_type,
                    bonus: t.bonus,
                    from: x.from,
                    to: x.to,
                });
            }
            call.members.push(Member {
                who: if gap.is_some_and(|gap| gap.member == k) {
                    Who::Held(0)
                } else {
                    Who::Snapshot(member.employee)
                },
                saved: self.specialization(member.employee, company),
                tool: member.tool.map(|t| self.tools[t].tool),
                line: Some(IndexRange { start, count: member.line.len() }),
            });
        }
        let subject;
        let held: &[HeldMember] = match gap {
            Some(gap) => {
                subject = [HeldMember { employee: gap.record, saved: 0.0, tool: None }];
                &subject
            }
            None => &[],
        };
        projector.calls.run(&self.people, held)
    }
}

/// A company's member in a layout: employee, tool from hour 0, timeline.
struct LayoutMember {
    employee: usize,
    tool: Option<usize>,
    line: Vec<ToolSpan>,
}

/// A projection: its value, and its rows at hour 0 (members working then,
/// in member order) with each one's totals.
pub struct Projection {
    pub value: f64,
    rows: Vec<ProjectionRow>,
}
#[derive(Clone, Copy)]
struct ProjectionRow {
    id: u32,
    employee: usize,
    /// The subject's gap, where the variant was projected.
    subject: bool,
    value: f64,
    training: f64,
    min_happiness: f64,
}

/// A member as `projection_of` reads its output.
struct ProjectedMember {
    id: u32,
    employee: usize,
    subject: bool,
    working_days: f64,
}

fn projection_of(
    projected: &Projected,
    members: impl Iterator<Item = ProjectedMember>,
) -> Projection {
    let rows = members
        .zip(&projected.members)
        .filter(|(m, _)| 0.0 < m.working_days * 24.0)
        .map(|(m, totals)| ProjectionRow {
            id: m.id,
            employee: m.employee,
            subject: m.subject,
            value: totals.value,
            training: totals.training,
            min_happiness: totals.min_happiness,
        })
        .collect();
    Projection { value: projected.value, rows }
}

fn has_trait(e: &EmployeeRecord, t: Trait) -> bool {
    e.traits.iter().any(|x| x.id == Some(t))
}

// --- Card pricing ---

/// What a local plan changes: nothing, tools, a move or a swap.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PlanKind {
    Stay,
    Tool,
    Move,
    Swap,
}

/// An employee moving to a company (places in the snapshot).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
struct Move {
    employee: usize,
    company: usize,
}

/// A local plan: its moves and every planned employee's tool (by `people`
/// position; a tool's place in the snapshot), as `{ kind, changes:
/// [{ employee, company }], equipment: [tool | null] }`.
#[derive(Serialize)]
pub struct Plan {
    kind: PlanKind,
    changes: Vec<Move>,
    equipment: Vec<Option<usize>>,
}

/// What tells plans apart: their moves and tools.
#[derive(PartialEq, Eq, Hash)]
struct PlanKey {
    changes: Vec<Move>,
    equipment: Vec<Option<usize>>,
}

struct LayoutGroup {
    company: usize,
    members: Vec<LayoutMember>,
    /// The subject's place among the members, in its company.
    gap: Option<usize>,
    key: u32,
}
/// A plan's companies, and once worked out, the projections of those
/// without the subject (`fixed`).
struct Layout {
    groups: Vec<LayoutGroup>,
    touched: Vec<usize>,
    fixed: OnceCell<Rc<FixedGroups>>,
}
/// A layout's projections without the subject: by group, None for the
/// subject's (`subject_group`), and the value of those before and after it.
struct FixedGroups {
    projections: Vec<Option<Rc<Projection>>>,
    subject_group: usize,
    value_before: f64,
    values_after: Vec<f64>,
}

/// A projected plan for one variant: the value, its layout with the fixed
/// projections, and the subject's company's projection.
#[derive(Clone)]
struct PlanProjection {
    value: f64,
    layout: Rc<Layout>,
    fixed: Rc<FixedGroups>,
    subject: Rc<Projection>,
}

impl PlanProjection {
    /// Group `i`'s projection.
    fn group(&self, i: usize) -> &Projection {
        self.fixed.projections[i].as_deref().unwrap_or(&self.subject)
    }
    /// Every row, by company.
    fn rows(&self) -> impl Iterator<Item = &ProjectionRow> {
        (0..self.fixed.projections.len()).flat_map(|i| self.group(i).rows.iter())
    }
}

struct Best {
    value: f64,
    plan: usize,
    projection: PlanProjection,
}

/// A state's plans ranked for one base variant: the best plan, each plan's
/// value in `plans` order (the stay plan's is the stay value), and the
/// short menu for forecasts, made when a price first asks for it
/// (`Pricer::screened`).
struct Ranking {
    best: Best,
    scores: Vec<f64>,
    screened: OnceCell<Vec<usize>>,
}

/// How a quote priced its card.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuoteKind {
    /// From the card's outcomes, each on its best plan.
    Outcomes,
    /// A fresh hand.
    Reroll,
    SecondWind,
    /// Trait and stat apart, in a forecast.
    WildCard,
    /// Not priced (`unpriced` names the trait if one is why).
    Unpriced,
}

/// The plans an outcome quote compared.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Coverage {
    FullMenu,
    ShortMenu,
    RestrictedPair,
}

/// What an outcome quote leaves out, for the facade's note.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuoteNote {
    /// Anchor's protection against quitting.
    Anchor,
    /// The planner's assumptions (Trainer, Recruiter, Lucky Charm, Jinx).
    Assumptions,
    /// A Wild Card's non-output effects.
    WildCard,
}

/// What `quote` worked out: `{ kind, value, stay, outcomes, plan,
/// coverage, note, unpriced }`.
pub struct Quote {
    pub kind: QuoteKind,
    pub value: Option<f64>,
    pub stay: Option<f64>,
    pub outcomes: Vec<OutcomeQuote>,
    pub plan: usize,
    pub coverage: Coverage,
    pub note: Option<QuoteNote>,
    pub unpriced: Option<Code>,
}

impl Serialize for Quote {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(8))?;
        m.serialize_entry("kind", &self.kind)?;
        m.serialize_entry("value", &self.value)?;
        m.serialize_entry("stay", &self.stay)?;
        m.serialize_entry("outcomes", &self.outcomes)?;
        m.serialize_entry("plan", &self.plan)?;
        m.serialize_entry("coverage", &self.coverage)?;
        m.serialize_entry("note", &self.note)?;
        m.serialize_entry("unpriced", &self.unpriced.as_ref().map(Code::as_str))?;
        m.end()
    }
}

/// One outcome of a card, priced on its best plan: `{ p, arg, value, stay,
/// plan }`.
#[derive(Serialize)]
pub struct OutcomeQuote {
    #[serde(rename = "p")]
    pub probability: f64,
    pub arg: Option<Rc<str>>,
    pub value: f64,
    pub stay: f64,
    pub plan: usize,
}

/// `traitShift`: gaining a trait, on its best plan and staying.
#[derive(Clone, Copy)]
struct Shift {
    value: f64,
    stay: f64,
}

/// One subject under one tool assignment: its plans and everything priced on them.
struct State {
    subject: usize,
    plans: Vec<Plan>,
    total: f64,
    /// By the base variant's key (`Pricer::variant_key`), made on the first
    /// price with it.
    rankings: RefCell<HashMap<u32, Rc<Ranking>>>,
    /// By (options, card, whether priced for the pool), numbered by the
    /// session. The options fix the base variant, so the ranking a quote is
    /// measured from.
    quotes: RefCell<HashMap<(u32, u32, bool), Rc<Quote>>>,
    /// By (options, trait).
    shifts: RefCell<HashMap<(u32, u8), Shift>>,
    layouts: RefCell<Vec<Option<Rc<Layout>>>>,
}

/// The session's projection cache, keys and workspace.
struct Caches {
    /// By (company's layout, subject variant): `LayoutGroup::key`,
    /// `Variant::key` (`u32::MAX` without the subject).
    projections: Recent<(u32, u32), Rc<Projection>>,
    /// A company's members and their tool timelines, numbered.
    group_keys: HashMap<Vec<u64>, u32>,
    /// The subject's variants, by what tells their projections apart (`variant_key`).
    variant_keys: HashMap<Vec<u64>, u32>,
    /// The cards priced, numbered by their place here.
    cards: Vec<Card>,
    /// The rules' inputs priced with (`PriceOptions`), numbered likewise.
    options: Vec<Rc<PriceOptions>>,
    projector: CompanyProjector,
}
/// The number of a list of words: the next free one if it is new.
fn key_number(map: &mut HashMap<Vec<u64>, u32>, words: Vec<u64>) -> u32 {
    let n = map.len() as u32;
    *map.entry(words).or_insert(n)
}
/// The number of `x` in `list` (compared by value), added if it is new.
fn number_of<T: PartialEq>(list: &mut Vec<T>, x: &T, make: impl FnOnce() -> T) -> u32 {
    match list.iter().position(|y| y == x) {
        Some(i) => i as u32,
        None => {
            list.push(make());
            (list.len() - 1) as u32
        }
    }
}

/// What a price's rules read besides the cards: `e`, the forecasts' `e`
/// and the context. Quotes and trait shifts are kept per value of these.
#[derive(PartialEq)]
struct PriceOptions {
    employee: RulesEmployee,
    forecast_employee: RulesEmployee,
    context: Context,
}

pub struct CardSession {
    roster: Roster,
    projection_end: f64,
    /// Employees of the planned companies; plans' equipment follows it.
    people: Vec<usize>,
    /// Each employee's place in `people`.
    positions: Vec<Option<usize>>,
    allow_moves: bool,
    /// Traits whose display row says unpriced (the facade's list).
    unpriced: TraitSet,
    /// Whether a planned company is recruiting.
    planned_recruitment: bool,
    /// By (subject, each employee's tool): the state's number.
    state_numbers: HashMap<(usize, Vec<Option<usize>>), u32>,
    states: Vec<Rc<State>>,
    caches: RefCell<Caches>,
}

/// Per call: the inputs the facade merged, as the rules and the projection read them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inputs {
    subject: usize,
    /// Each employee's tool (its place in the snapshot's tools), or null.
    tools: Vec<Option<usize>>,
    /// Projections the price may run; unknown is 80,000.
    budget: Option<f64>,
    /// Whether the cards are priced for the pool (`quote`'s `pool`).
    #[serde(default)]
    feed: Truthy,
    /// `e`, the subject over the options (decoded with the defaults), for
    /// the rules, and the forecasts' `e` (the options' Luck).
    employee: RulesEmployee,
    forecast_employee: RulesEmployee,
    /// The rules' context; its PP value (1 when unknown) converts the
    /// projections' money into PP.
    context: Context,
    cards: Vec<Card>,
}

/// A price's result: `{ state, quotes, baseline, tested, total,
/// projections, warnings }`, plans by index in the state
/// (`CardSession::plan`).
#[derive(Serialize)]
pub struct Priced {
    /// The (subject, tools) state's number, for its plans.
    pub state: u32,
    pub quotes: Vec<Rc<Quote>>,
    pub baseline: usize,
    pub tested: usize,
    pub total: f64,
    pub projections: f64,
    /// Employees already below 30 happiness in the best plan.
    pub warnings: Vec<usize>,
}

/// A price, or why it couldn't be made: `{ failure }` with the message.
#[derive(Serialize)]
#[serde(untagged)]
pub enum PriceResult {
    Priced(Priced),
    Failed { failure: &'static str },
}

impl From<Result<Priced, Fail>> for PriceResult {
    fn from(result: Result<Priced, Fail>) -> PriceResult {
        match result {
            Ok(priced) => PriceResult::Priced(priced),
            Err(f) => PriceResult::Failed { failure: f.message() },
        }
    }
}

impl CardSession {
    /// Card variants change Luck against a reference: an employee without a
    /// training base Luck takes today's (`e.luck ?? 0`), so their own Luck
    /// reaches only toolbox loot and a variant's key can leave it out
    /// without toolboxes.
    pub fn new(mut roster: Roster, allow_moves: bool, unpriced: &[u8]) -> CardSession {
        for e in &mut roster.people {
            if e.training_base_luck.is_none() {
                e.training_base_luck = Some(e.luck);
            }
        }
        let people: Vec<usize> = (0..roster.len())
            .filter(|&i| roster.company_of[i].is_some_and(|c| roster.planned.contains(&c)))
            .collect();
        let mut positions = vec![None; roster.len()];
        for (k, &i) in people.iter().enumerate() {
            positions[i] = Some(k);
        }
        let unpriced = unpriced
            .iter()
            .filter_map(|&id| crate::traits::TRAITS.get(id as usize))
            .fold(TraitSet::EMPTY, |set, &t| set.with(t));
        let planned_recruitment =
            roster.planned.iter().any(|&c| roster.companies[c].recruitment.is_some());
        let projection_end = roster.projection_hours.unwrap_or(roster.timeline_end);
        CardSession {
            roster,
            projection_end,
            people,
            positions,
            allow_moves,
            unpriced,
            planned_recruitment,
            state_numbers: HashMap::new(),
            states: Vec::new(),
            caches: RefCell::new(Caches {
                projections: Recent::new(PROJECTIONS_KEPT),
                group_keys: HashMap::new(),
                variant_keys: HashMap::new(),
                cards: Vec::new(),
                options: Vec::new(),
                projector: CompanyProjector::default(),
            }),
        }
    }

    pub fn people(&self) -> &[usize] {
        &self.people
    }

    /// A plan of a state, by its index in the state's plans.
    pub fn plan(&self, state: u32, index: usize) -> Option<&Plan> {
        self.states.get(state as usize).and_then(|st| st.plans.get(index))
    }

    /// The state's plans: the local plans, and the tool choices on top.
    fn build_state(&self, subject: usize, tools: &[Option<usize>]) -> State {
        let roster = &self.roster;
        let people = &self.people;
        let company = |e: usize| roster.company_of[e].unwrap_or(usize::MAX);
        let movable = |e: usize| self.allow_moves && !roster.locked[e];
        let mut count = vec![0.0; roster.companies.len()];
        for &e in people {
            count[company(e)] += 1.0;
        }
        let disabled = |c: usize| roster.companies[c].disabled;
        let room = |c: usize| count[c] < roster.capacity[c];
        let mut menu: Vec<(PlanKind, Vec<Move>)> = vec![(PlanKind::Stay, Vec::new())];
        let mut seen: HashSet<Vec<Move>> = HashSet::new();
        let mut add = |kind: PlanKind, mut changes: Vec<Move>| {
            // A swap's two moves in one order, so it is offered once.
            if changes.len() == 2 && changes[1].employee < changes[0].employee {
                changes.swap(0, 1);
            }
            if seen.insert(changes.clone()) {
                menu.push((kind, changes));
            }
        };
        let moves = |e: usize, add: &mut dyn FnMut(PlanKind, Vec<Move>)| {
            if !movable(e) {
                return;
            }
            for &c in &roster.planned {
                if c != company(e) && !disabled(c) && room(c) {
                    add(PlanKind::Move, vec![Move { employee: e, company: c }]);
                }
            }
        };
        let swaps = |e: usize, add: &mut dyn FnMut(PlanKind, Vec<Move>)| {
            if !movable(e) {
                return;
            }
            for &f in people {
                if movable(f)
                    && company(f) != company(e)
                    && !(disabled(company(e)) && disabled(company(f)))
                {
                    add(
                        PlanKind::Swap,
                        vec![
                            Move { employee: e, company: company(f) },
                            Move { employee: f, company: company(e) },
                        ],
                    );
                }
            }
        };
        moves(subject, &mut add);
        swaps(subject, &mut add);
        let home = company(subject);
        let peers: Vec<usize> =
            people.iter().copied().filter(|&e| e != subject && company(e) == home).collect();
        for &e in &peers {
            moves(e, &mut add);
        }
        for &e in people {
            if company(e) != home && movable(e) && !disabled(home) && room(home) {
                add(PlanKind::Move, vec![Move { employee: e, company: home }]);
            }
        }
        for &e in &peers {
            swaps(e, &mut add);
        }
        let menu_total = menu.len();
        menu.truncate(PLAN_CAP);

        // Each plan with the tools as they are (or back to inventory when
        // they don't fit), a swap with tools swapped too, the subject with
        // no tool, and the subject with each compatible registered tool,
        // its donor taking the subject's tool if that fits.
        let tool = |e: usize| tools.get(e).copied().flatten();
        let position = |e: usize| self.positions[e].unwrap_or(0);
        let available: Vec<usize> = (0..roster.tools.len())
            .filter(|&t| {
                roster.tools[t].tool.hours > 0.0
                    && match roster.tools[t].holder {
                        Holder::Free => true,
                        Holder::Employee(i) => self.positions[i].is_some(),
                        Holder::Missing => false,
                    }
            })
            .collect();
        let mut seen: HashSet<PlanKey> = HashSet::new();
        let mut queues: Vec<Vec<Plan>> = Vec::new();
        for (kind, changes) in menu {
            let mut queue = Vec::new();
            let company_of = |x: usize| {
                changes.iter().find(|m| m.employee == x).map_or(company(x), |m| m.company)
            };
            let mut push = |kind: PlanKind, equipment: Vec<Option<usize>>| {
                let key = PlanKey { changes: changes.clone(), equipment: equipment.clone() };
                if seen.insert(key) {
                    queue.push(Plan { kind, changes: changes.clone(), equipment });
                }
            };
            let equipment: Vec<Option<usize>> = people
                .iter()
                .map(|&x| {
                    tool(x).filter(|&t| {
                        roster.compatible(t, company_of(x)) || company_of(x) == company(x)
                    })
                })
                .collect();
            push(kind, equipment.clone());
            if kind == PlanKind::Swap {
                let (a, b) = (changes[0].employee, changes[1].employee);
                let mut swapped = equipment.clone();
                swapped[position(a)] = tool(b);
                swapped[position(b)] = tool(a);
                for id in [a, b] {
                    if swapped[position(id)].is_some_and(|t| !roster.compatible(t, company_of(id)))
                    {
                        swapped[position(id)] = None;
                    }
                }
                push(kind, swapped);
            }
            let kind = if kind == PlanKind::Stay { PlanKind::Tool } else { kind };
            let me = position(subject);
            let mut bare = equipment.clone();
            bare[me] = None;
            push(kind, bare);
            for &t in &available {
                if !roster.compatible(t, company_of(subject)) || equipment[me] == Some(t) {
                    continue;
                }
                let mut next = equipment.clone();
                next[me] = Some(t);
                if let Some(d) = (0..people.len()).find(|&k| equipment[k] == Some(t)) {
                    next[d] =
                        equipment[me].filter(|&old| roster.compatible(old, company_of(people[d])));
                }
                push(kind, next);
            }
            queues.push(queue);
        }
        let total = (menu_total as f64).max(queues.iter().map(|q| q.len()).sum::<usize>() as f64);
        let mut plans = Vec::new();
        let mut queues: Vec<std::vec::IntoIter<Plan>> =
            queues.into_iter().map(Vec::into_iter).collect();
        while plans.len() < PLAN_CAP {
            let mut any = false;
            for q in &mut queues {
                if plans.len() >= PLAN_CAP {
                    break;
                }
                if let Some(p) = q.next() {
                    plans.push(p);
                    any = true;
                }
            }
            if !any {
                break;
            }
        }
        let n = plans.len();
        State {
            subject,
            plans,
            total,
            rankings: RefCell::default(),
            quotes: RefCell::default(),
            shifts: RefCell::default(),
            layouts: RefCell::new(vec![None; n]),
        }
    }

    /// `price(subjectId, cards, options)`, after the facade's checks.
    /// The subject as priced: their record with the numbers of `e`, which
    /// differ from the record's only where the subject's is unknown (and the
    /// options or defaults give it). The wage `validate` requires is the
    /// record's when `e` has none.
    fn priced_record(&self, subject: usize, e: &RulesEmployee) -> EmployeeRecord {
        let mut record = self.roster.people[subject].clone();
        record.age = e.age;
        record.retire_in_days = e.retire_in_days;
        record.production = e.production;
        record.trait_production = e.trait_production;
        record.responsibility = e.responsibility;
        record.luck = e.luck;
        record.potential_left = Some(e.potential_left);
        if let Some(wage) = e.wage {
            record.wage = wage;
        }
        record.climber_raise = e.climber_raise.unwrap_or(0.0);
        record
    }

    pub fn price(&mut self, inputs: Inputs) -> Result<Priced, Fail> {
        if !self.roster.numbers_known {
            return Err(Fail::UnknownNumbers);
        }
        let Inputs { subject, tools, budget, feed, employee, forecast_employee, context, cards } =
            inputs;
        let key = (subject, tools);
        let state_number = match self.state_numbers.get(&key) {
            Some(&n) => n,
            None => {
                let state = Rc::new(self.build_state(subject, &key.1));
                self.states.push(state);
                let n = (self.states.len() - 1) as u32;
                self.state_numbers.insert(key, n);
                n
            }
        };
        let state = self.states[state_number as usize].clone();
        let toolbox = self.roster.toolbox_value != 0.0;
        let pp_value = context.pp_value.unwrap_or(1.0);
        let record = self.priced_record(subject, &employee);
        let options = PriceOptions { employee, forecast_employee, context };
        let (options_number, options) = {
            let mut caches = self.caches.borrow_mut();
            let list = &mut caches.options;
            let n = match list.iter().position(|x| **x == options) {
                Some(n) => n,
                None => {
                    list.push(Rc::new(options));
                    list.len() - 1
                }
            };
            (n as u32, list[n].clone())
        };
        let pricer = Pricer {
            session: self,
            state: &state,
            toolbox,
            employee: &options.employee,
            forecast_employee: &options.forecast_employee,
            context: &options.context,
            memo: Memo::default(),
            forecast_memo: Memo::default(),
            pp_value,
            budget: budget.filter(|b| b.is_finite()).unwrap_or(80_000.0),
            feed: feed.0,
            options: options_number,
            used: Cell::new(0.0),
            variants: RefCell::default(),
        };
        let base = pricer.base_variant(record);
        let priced = pricer.run(&base, &cards)?;
        Ok(Priced { state: state_number, ..priced })
    }
}

/// A variant of the subject: the projection's record and its key.
struct Variant {
    record: EmployeeRecord,
    key: u32,
}

struct Pricer<'a> {
    session: &'a CardSession,
    state: &'a State,
    toolbox: bool,
    employee: &'a RulesEmployee,
    forecast_employee: &'a RulesEmployee,
    context: &'a Context,
    memo: Memo,
    forecast_memo: Memo,
    pp_value: f64,
    budget: f64,
    feed: bool,
    /// The number of the price's `PriceOptions` in the session.
    options: u32,
    used: Cell<f64>,
    /// A layout's projection of the subject's company, by (plan, variant key).
    variants: RefCell<HashMap<(usize, u32), Rc<Projection>>>,
}

/// What a price's quotes are measured from, both for this price's numbers:
/// the state's ranking (its best plan and short menu), and the subject's
/// value where they are.
struct Baseline {
    ranking: Rc<Ranking>,
    stay: f64,
}

impl Pricer<'_> {
    fn roster(&self) -> &Roster {
        &self.session.roster
    }

    /// A variant's key: everything a variant can change in the record the
    /// projection reads (the rest is the subject's own). Traits that change
    /// no projection here (`Roster::idle_traits`) are left out, and Luck
    /// without toolboxes (see `CardSession::new`).
    fn variant_key(&self, record: &EmployeeRecord) -> u32 {
        let idle = self.roster().idle_traits;
        let mut words = vec![record.id as u64];
        for t in &record.traits {
            if t.id.is_some_and(|t| idle.has(t)) {
                continue;
            }
            words.push(t.id.map_or(NONE - 1, |t| t as u64));
            words.push(t.arg as u64);
        }
        words.push(NONE);
        words.push(if self.toolbox { record.luck.to_bits() } else { NONE });
        let known = |x: Option<f64>| x.map_or(NONE, f64::to_bits);
        words.push(known(record.potential_left));
        words.extend(
            [
                record.production,
                record.trait_production,
                record.responsibility,
                record.wage,
                record.climber_raise,
                record.age,
            ]
            .map(f64::to_bits),
        );
        words.push(known(record.retire_in_days));
        key_number(&mut self.session.caches.borrow_mut().variant_keys, words)
    }

    fn base_variant(&self, record: EmployeeRecord) -> Variant {
        let key = self.variant_key(&record);
        Variant { record, key }
    }

    /// `o.employee`: the subject after an outcome.
    fn variant(&self, base: &Variant, o: &rules::Outcome) -> Variant {
        let mut record = base.record.clone();
        if let Some(items) = &o.traits {
            record.traits = items
                .iter()
                .map(|it| match it {
                    OutcomeTrait::Held(i) => base.record.traits[*i].clone(),
                    OutcomeTrait::New { trait_id, arg } => TraitRecord::new(
                        Some(*trait_id),
                        arg.as_deref().filter(|a| !a.is_empty()).map_or(0, intern),
                    ),
                })
                .collect();
            record.update_flags();
        }
        for &rules::FieldChange { name, value } in &o.set {
            match name {
                "production" => record.production = value,
                "responsibility" => record.responsibility = value,
                "luck" => record.luck = value,
                "traitProduction" => record.trait_production = value,
                "wage" => record.wage = value,
                "climberRaise" => record.climber_raise = value,
                "potentialLeft" => record.potential_left = Some(value),
                _ => {}
            }
        }
        let key = self.variant_key(&record);
        Variant { record, key }
    }

    /// The plan's companies, members sorted and keyed with the subject as a
    /// gap (`layoutOf`).
    fn layout(&self, plan_index: usize) -> Rc<Layout> {
        if let Some(l) = self.state.layouts.borrow()[plan_index].clone() {
            return l;
        }
        let stay = if plan_index == 0 { None } else { Some(self.layout(0)) };
        let roster = self.roster();
        let plan = &self.state.plans[plan_index];
        let company_of = |x: usize| {
            plan.changes
                .iter()
                .find(|m| m.employee == x)
                .map(|m| m.company)
                .or(roster.company_of[x])
        };
        let tool_in = |x: usize| self.session.positions[x].and_then(|k| plan.equipment[k]);
        let groups: Vec<CompanyGroup> = roster
            .planned
            .iter()
            .map(|&company| {
                let members: Vec<MemberTool> = (0..roster.len())
                    .filter(|&x| company_of(x) == Some(company))
                    .map(|x| MemberTool { employee: x, tool: tool_in(x) })
                    .collect();
                CompanyGroup { company, members }
            })
            .collect();
        let held: HashSet<usize> = plan.equipment.iter().flatten().copied().collect();
        let spares = (0..roster.tools.len()).filter(|t| {
            !held.contains(t)
                && match roster.tools[*t].holder {
                    Holder::Free => true,
                    Holder::Employee(i) => {
                        roster.company_of[i].is_some_and(|c| roster.planned.contains(&c))
                    }
                    Holder::Missing => false,
                }
        });
        let lines = roster.handoffs(roster.timeline_end, &groups, spares);
        let mut caches = self.session.caches.borrow_mut();
        let groups: Vec<LayoutGroup> = groups
            .into_iter()
            .zip(lines)
            .map(|(group, lines)| {
                let gap = group.members.iter().position(|m| m.employee == self.state.subject);
                let mut words = vec![group.company as u64];
                let members: Vec<LayoutMember> = group
                    .members
                    .into_iter()
                    .zip(lines)
                    .enumerate()
                    .map(|(k, (member, line))| {
                        words.push(if gap == Some(k) { NONE } else { member.employee as u64 });
                        words.push(line.len() as u64);
                        for x in &line {
                            words.extend([x.tool as u64, x.from.to_bits(), x.to.to_bits()]);
                        }
                        LayoutMember { employee: member.employee, tool: member.tool, line }
                    })
                    .collect();
                LayoutGroup {
                    company: group.company,
                    members,
                    gap,
                    key: key_number(&mut caches.group_keys, words),
                }
            })
            .collect();
        drop(caches);
        let touched = stay.map_or_else(Vec::new, |stay| {
            (0..groups.len()).filter(|&i| groups[i].key != stay.groups[i].key).collect()
        });
        let layout = Rc::new(Layout { groups, touched, fixed: OnceCell::new() });
        self.state.layouts.borrow_mut()[plan_index] = Some(layout.clone());
        layout
    }

    /// A group's projection: from the cache, the older generation (moved up),
    /// or projected.
    fn project_group(
        &self,
        group: &LayoutGroup,
        variant: Option<&Variant>,
    ) -> Result<Rc<Projection>, Fail> {
        let key = (group.key, variant.map_or(u32::MAX, |v| v.key));
        let mut caches = self.session.caches.borrow_mut();
        if let Some(projection) = caches.projections.get(&key) {
            return Ok(projection);
        }
        let projection = {
            let used = self.used.get() + 1.0;
            self.used.set(used);
            if used > self.budget {
                return Err(Fail::Budget);
            }
            let gap = group
                .gap
                .zip(variant)
                .map(|(member, variant)| Gap { member, record: &variant.record });
            let caches = &mut *caches;
            let projected = self.roster().project(
                &mut caches.projector,
                self.session.projection_end,
                group.company,
                &group.members,
                gap,
            );
            let people = &self.roster().people;
            Rc::new(projection_of(
                projected,
                group.members.iter().enumerate().map(|(k, member)| {
                    let at_gap = gap.filter(|gap| gap.member == k);
                    let e = match at_gap {
                        Some(gap) => gap.record,
                        None => &people[member.employee],
                    };
                    ProjectedMember {
                        id: e.id,
                        employee: member.employee,
                        subject: at_gap.is_some(),
                        working_days: working_days(e),
                    }
                }),
            ))
        };
        caches.projections.insert(key, projection.clone());
        Ok(projection)
    }

    /// The layout's companies without the subject, projected once per
    /// layout.
    fn fixed_groups(&self, layout: &Layout) -> Result<Rc<FixedGroups>, Fail> {
        if let Some(fixed) = layout.fixed.get() {
            return Ok(fixed.clone());
        }
        let mut projections = Vec::with_capacity(layout.groups.len());
        for group in &layout.groups {
            projections.push(if group.gap.is_none() {
                Some(self.project_group(group, None)?)
            } else {
                None
            });
        }
        let subject_group =
            layout.groups.iter().position(|g| g.gap.is_some()).ok_or(Fail::NotPlanned)?;
        // The subject is in one company: every other group is projected.
        let value_before =
            projections[..subject_group].iter().flatten().fold(0.0, |v, p| v + p.value);
        let values_after =
            projections[subject_group + 1..].iter().flatten().map(|p| p.value).collect();
        let fixed = Rc::new(FixedGroups { projections, subject_group, value_before, values_after });
        Ok(layout.fixed.get_or_init(|| fixed).clone())
    }

    /// `project(variant, plan)`: only the subject's company changes with
    /// the variant; the others are projected once per layout and summed in
    /// company order around it.
    fn project(&self, variant: &Variant, plan_index: usize) -> Result<PlanProjection, Fail> {
        let layout = self.layout(plan_index);
        let fixed = self.fixed_groups(&layout)?;
        let found = self.variants.borrow().get(&(plan_index, variant.key)).cloned();
        let subject = match found {
            Some(subject) => subject,
            None => {
                let subject =
                    self.project_group(&layout.groups[fixed.subject_group], Some(variant))?;
                self.variants.borrow_mut().insert((plan_index, variant.key), subject.clone());
                subject
            }
        };
        let mut value = if fixed.subject_group != 0 {
            fixed.value_before + subject.value
        } else {
            subject.value
        };
        for x in &fixed.values_after {
            value += x;
        }
        Ok(PlanProjection { value, layout, fixed, subject })
    }

    /// `best(variant, plans)`: the plan worth most for the variant that
    /// pushes nobody newly below their quitting threshold. With `scores`,
    /// also each plan's value, in `plans`' order.
    fn best(
        &self,
        variant: &Variant,
        plans: &[usize],
        mut scores: Option<&mut Vec<f64>>,
    ) -> Result<Best, Fail> {
        let stay = self.project(variant, 0)?;
        let mut result = Best { value: stay.value, plan: 0, projection: stay.clone() };
        let mut stay_happiness: Option<HashMap<u32, f64>> = None;
        for &plan_index in plans {
            if self.state.plans[plan_index].kind == PlanKind::Stay {
                if let Some(s) = scores.as_deref_mut() {
                    s.push(stay.value);
                }
                continue;
            }
            let projected = self.project(variant, plan_index)?;
            if let Some(s) = scores.as_deref_mut() {
                s.push(projected.value);
            }
            if projected.value <= result.value + EPS {
                continue;
            }
            let stay_happiness = stay_happiness.get_or_insert_with(|| {
                let mut m = HashMap::new();
                for row in stay.rows() {
                    m.insert(row.id, row.min_happiness);
                }
                m
            });
            let people = &self.roster().people;
            let risky = projected.layout.touched.iter().any(|&i| {
                projected.group(i).rows.iter().any(|row| {
                    let who = if row.subject { &variant.record } else { &people[row.employee] };
                    let threshold = if has_trait(who, Trait::FlightRisk) { 50.0 } else { 30.0 };
                    !has_trait(who, Trait::Anchor)
                        && row.min_happiness < threshold
                        && stay_happiness.get(&row.id).is_some_and(|&h| h >= threshold)
                })
            });
            if !risky {
                result = Best { value: projected.value, plan: plan_index, projection: projected };
            }
        }
        Ok(result)
    }

    /// The short menu for forecasts (`screened`): the stay plan, the
    /// ranking's best, and its highest-scored plans overall and at each place.
    fn screened<'r>(&self, ranking: &'r Ranking) -> &'r [usize] {
        ranking.screened.get_or_init(|| {
            let n = self.state.plans.len();
            let scores = &ranking.scores;
            let mut ranked: Vec<usize> = (1..n).collect();
            sort_places(&mut ranked, &|a, b| scores[b].total_cmp(&scores[a]));
            let mut keep = vec![false; n];
            keep[0] = true;
            keep[ranking.best.plan] = true;
            for &p in ranked.iter().take(SCREEN_TOP) {
                keep[p] = true;
            }
            let subject = self.state.subject;
            let me = self.session.positions[subject].unwrap_or(0);
            let mut seen: HashMap<(Option<usize>, Option<usize>), usize> = HashMap::new();
            for &p in &ranked {
                let plan = &self.state.plans[p];
                let place = (
                    plan.changes
                        .iter()
                        .find(|m| m.employee == subject)
                        .map(|m| m.company)
                        .or(self.roster().company_of[subject]),
                    plan.equipment[me],
                );
                let k = seen.entry(place).or_insert(0);
                if *k < SCREEN_PER_PLACE {
                    keep[p] = true;
                    *k += 1;
                }
            }
            (0..n).filter(|&p| keep[p]).collect()
        })
    }

    /// A card's number in the session (cards compare by value).
    fn card_number(&self, card: &Card) -> u32 {
        number_of(&mut self.session.caches.borrow_mut().cards, card, || card.clone())
    }

    /// The state's ranking for the base variant: every plan projected for
    /// it on its first price.
    fn ranking(&self, base: &Variant) -> Result<Rc<Ranking>, Fail> {
        if let Some(ranking) = self.state.rankings.borrow().get(&base.key) {
            return Ok(ranking.clone());
        }
        let all: Vec<usize> = (0..self.state.plans.len()).collect();
        let mut scores = Vec::with_capacity(all.len());
        let best = self.best(base, &all, Some(&mut scores))?;
        let ranking = Rc::new(Ranking { best, scores, screened: OnceCell::new() });
        self.state.rankings.borrow_mut().insert(base.key, ranking.clone());
        Ok(ranking)
    }

    fn run(&self, base: &Variant, cards: &[Card]) -> Result<Priced, Fail> {
        let baseline =
            Baseline { ranking: self.ranking(base)?, stay: self.project(base, 0)?.value };
        let mut quotes = Vec::with_capacity(cards.len());
        for card in cards {
            quotes.push(self.quote(base, card, self.card_number(card), self.feed, &baseline)?);
        }
        let best = &baseline.ranking.best;
        let mut warnings = Vec::new();
        for row in best.projection.rows() {
            if row.min_happiness < 30.0 {
                warnings.push(row.employee);
            }
        }
        Ok(Priced {
            state: 0,
            quotes,
            baseline: best.plan,
            tested: self.state.plans.len(),
            total: self.state.total,
            projections: self.used.get(),
            warnings,
        })
    }

    fn luck_delta(&self, o: &rules::Outcome) -> f64 {
        let base = self.employee.luck;
        let luck = o.set.iter().rev().find(|x| x.name == "luck").map_or(base, |x| x.value);
        luck - base
    }

    /// `quote(c, pool)`, measured from `baseline`.
    fn quote(
        &self,
        base: &Variant,
        c: &Card,
        card: u32,
        pool: bool,
        baseline: &Baseline,
    ) -> Result<Rc<Quote>, Fail> {
        let key = (self.options, card, pool);
        if let Some(q) = self.state.quotes.borrow().get(&key) {
            return Ok(q.clone());
        }
        let q = match c.kind {
            Kind::Reroll => {
                // A pool card's price is the value of its quote as one.
                let price = |card: &Card| {
                    let number = self.card_number(card);
                    Ok(self.quote(base, card, number, /* pool */ true, baseline)?.value)
                };
                let value = rules::training_outlook(
                    self.employee,
                    self.context,
                    &Price::Given(&price),
                    1.0,
                    &self.memo,
                )?
                .value;
                let stay = rules::card_value(self.employee, c, self.context, 1.0, &self.memo);
                Quote {
                    kind: QuoteKind::Reroll,
                    value: Some(value),
                    stay,
                    outcomes: Vec::new(),
                    plan: baseline.ranking.best.plan,
                    coverage: Coverage::FullMenu,
                    note: None,
                    unpriced: None,
                }
            }
            Kind::SecondWind => {
                let value = rules::model_only(rules::second_wind_value(
                    self.forecast_employee,
                    c.gain,
                    self.context,
                    1.0,
                    &Price::Model,
                    &self.forecast_memo,
                ));
                Quote {
                    kind: QuoteKind::SecondWind,
                    value: Some(value),
                    stay: Some(value),
                    outcomes: Vec::new(),
                    plan: 0,
                    coverage: Coverage::FullMenu,
                    note: None,
                    unpriced: None,
                }
            }
            Kind::WildCard if pool => {
                let codes: Vec<Code> =
                    self.employee.traits().iter().map(|h| h.code.clone()).collect();
                let traits = rules::eligible_traits(
                    &codes,
                    self.context.situation.gender.as_deref(),
                    &ALL_POLARITIES,
                );
                let mut shifts = Vec::with_capacity(traits.len());
                for &t in &traits {
                    shifts.push(self.trait_shift(base, t, baseline)?);
                }
                let mut drills = Vec::with_capacity(3);
                for stat in Stat::ALL {
                    let card = Card::drill(stat, CFG.wild_card_stat_gain);
                    drills.push(self.quote(
                        base,
                        &card,
                        self.card_number(&card),
                        /* pool */ true,
                        baseline,
                    )?);
                }
                let mean = |k: fn(&Shift) -> f64, d: fn(&Quote) -> Option<f64>| {
                    shifts.iter().fold(0.0, |v, x| v + k(x)) / shifts.len() as f64
                        + drills.iter().fold(0.0, |v, x| v + d(x).unwrap_or(0.0))
                            / drills.len() as f64
                };
                Quote {
                    kind: QuoteKind::WildCard,
                    value: Some(mean(|x| x.value, |q| q.value)),
                    stay: Some(mean(|x| x.stay, |q| q.stay)),
                    outcomes: Vec::new(),
                    plan: baseline.ranking.best.plan,
                    coverage: Coverage::FullMenu,
                    note: None,
                    unpriced: None,
                }
            }
            _ => self.priced(base, c, pool, baseline)?,
        };
        let q = Rc::new(q);
        self.state.quotes.borrow_mut().insert(key, q.clone());
        Ok(q)
    }

    /// The card's outcomes, each on its best plan, or why it isn't priced.
    fn priced(
        &self,
        base: &Variant,
        c: &Card,
        pool: bool,
        baseline: &Baseline,
    ) -> Result<Quote, Fail> {
        let quota = self.roster().training_quota;
        let codes: Vec<Code> = match c.kind {
            Kind::RehabAll => self
                .employee
                .traits()
                .iter()
                .filter(|h| h.code.known().is_some_and(|t| t.rule().polarity == Polarity::Negative))
                .map(|h| h.code.clone())
                .collect(),
            Kind::Mentoring => c.code.iter().chain(&c.to).cloned().collect(),
            _ => match &c.codes {
                Some(cs) => cs.to_vec(),
                None => c.code.iter().cloned().collect(),
            },
        };
        let unpriced_at = |code: &Code| match code {
            Code::Unknown(_) => true,
            Code::Known(t) => {
                self.session.unpriced.has(*t)
                    && !(*t == Trait::Trainer && quota > 0.0)
                    && !(*t == Trait::Recruiter && self.session.planned_recruitment)
                    || t.rule().partner && !self.employee.holds(*t)
            }
        };
        // The first of the card's codes not priced here.
        let unpriced = codes.iter().find(|c| unpriced_at(c)).cloned();
        let blocked = unpriced.is_some()
            || matches!(c.kind, Kind::Rehab)
                && !c
                    .code
                    .as_ref()
                    .and_then(Code::known)
                    .is_some_and(|t| t.rule().polarity == Polarity::Negative)
            || matches!(c.kind, Kind::Negotiation) && !rules::can_negotiate(self.employee, c.drop);
        if blocked {
            return Ok(Quote {
                kind: QuoteKind::Unpriced,
                value: None,
                stay: None,
                outcomes: Vec::new(),
                plan: 0,
                coverage: Coverage::FullMenu,
                note: None,
                unpriced,
            });
        }
        let plans: Cow<[usize]> = if pool && matches!(c.kind, Kind::HabitPair) {
            let mut list = vec![0, baseline.ranking.best.plan];
            for code in c.codes.iter().flat_map(|cs| cs.iter()) {
                let card = Card::with_code(Kind::Habit, code.clone());
                let q = self.quote(
                    base,
                    &card,
                    self.card_number(&card),
                    /* pool */ true,
                    baseline,
                )?;
                if q.outcomes.is_empty() {
                    list.push(q.plan);
                } else {
                    list.extend(q.outcomes.iter().map(|o| o.plan));
                }
            }
            let mut seen = HashSet::new();
            Cow::Owned(list.into_iter().filter(|p| seen.insert(*p)).collect())
        } else if pool {
            Cow::Borrowed(self.screened(&baseline.ranking))
        } else {
            Cow::Owned((0..self.state.plans.len()).collect())
        };
        let outs = rules::card_outcomes(self.employee, c, self.context);
        let mut outcomes = Vec::with_capacity(outs.len());
        for o in &outs {
            let variant = self.variant(base, o);
            let b = self.best(&variant, &plans, None)?;
            let delta = self.luck_delta(o);
            let future = if delta != 0.0 {
                rules::future_luck_value(
                    self.forecast_employee,
                    delta,
                    self.context,
                    &self.forecast_memo,
                )
            } else {
                0.0
            };
            let value = (b.value - baseline.ranking.best.value) / self.pp_value + future;
            let stay = (self.project(&variant, 0)?.value - baseline.stay) / self.pp_value + future;
            outcomes.push(OutcomeQuote {
                probability: o.probability,
                arg: o.arg.clone(),
                value,
                stay,
                plan: b.plan,
            });
        }
        let mean = |k: fn(&OutcomeQuote) -> f64| {
            outcomes.iter().fold(0.0, |v, o| v + o.probability * k(o))
        };
        let (value, stay) = (mean(|o| o.value), mean(|o| o.stay));
        let plan = outcomes.first().map_or(0, |o| o.plan);
        let note = if codes.iter().any(|c| c.is(Trait::Anchor)) {
            Some(QuoteNote::Anchor)
        } else if codes.iter().any(|c| {
            [Trait::Trainer, Trait::Recruiter, Trait::LuckyCharm, Trait::Jinx]
                .iter()
                .any(|&t| c.is(t))
        }) {
            Some(QuoteNote::Assumptions)
        } else if matches!(c.kind, Kind::WildCard) {
            Some(QuoteNote::WildCard)
        } else {
            None
        };
        let coverage = if !pool {
            Coverage::FullMenu
        } else if matches!(c.kind, Kind::HabitPair) {
            Coverage::RestrictedPair
        } else {
            Coverage::ShortMenu
        };
        Ok(Quote {
            kind: QuoteKind::Outcomes,
            value: Some(value),
            stay: Some(stay),
            outcomes: if outcomes.len() > 1 { outcomes } else { Vec::new() },
            plan,
            coverage,
            note,
            unpriced: None,
        })
    }

    /// `traitShift(code)`: gaining a trait on the short menu.
    fn trait_shift(&self, base: &Variant, t: Trait, baseline: &Baseline) -> Result<Shift, Fail> {
        /// One outcome's probability and shift.
        struct Weighted {
            probability: f64,
            shift: Shift,
        }
        let key = (self.options, t.id());
        if let Some(&s) = self.state.shifts.borrow().get(&key) {
            return Ok(s);
        }
        let outs = rules::card_outcomes(
            self.employee,
            &Card::with_code(Kind::Habit, Code::Known(t)),
            self.context,
        );
        let mut weighted = Vec::with_capacity(outs.len());
        for o in &outs {
            let variant = self.variant(base, o);
            let screened = self.screened(&baseline.ranking);
            let value = (self.best(&variant, screened, None)?.value - baseline.ranking.best.value)
                / self.pp_value;
            let stay = (self.project(&variant, 0)?.value - baseline.stay) / self.pp_value;
            weighted.push(Weighted { probability: o.probability, shift: Shift { value, stay } });
        }
        let shift = Shift {
            value: weighted.iter().fold(0.0, |a, x| a + x.probability * x.shift.value),
            stay: weighted.iter().fold(0.0, |a, x| a + x.probability * x.shift.stay),
        };
        self.state.shifts.borrow_mut().insert(key, shift);
        Ok(shift)
    }
}

// --- Retention ---

/// `retentionSession`: one employee's company over its working life with
/// and without them, its other members' tools handed on.
pub struct Retention {
    roster: Roster,
    baselines: HashMap<usize, Rc<Timed>>,
    projector: CompanyProjector,
}

/// A retention projection: its rows, the company's value by day, and the
/// training values in it by `(employee, day, value)`, the employee by place.
struct Timed {
    projection: Projection,
    daily: Vec<f64>,
    credits: Vec<(usize, usize, f64)>,
}

/// A member's lowest happiness over a retention projection: `{ employee,
/// minHappiness }`, the employee by place in the snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberHappiness {
    pub employee: usize,
    pub min_happiness: f64,
}

/// A retention price: `{ value, own, with, without }`, the company's rows
/// with the employee and without them. `by_day` is `value` a day at a time:
/// what the company makes each day with them less without them, their own
/// training left out as in `value`. Days after they retire count too.
#[derive(Serialize)]
pub struct Kept {
    pub value: f64,
    pub own: f64,
    pub with: Vec<MemberHappiness>,
    pub without: Vec<MemberHappiness>,
    #[serde(skip)]
    pub by_day: Vec<f64>,
}

impl Retention {
    pub fn new(roster: Roster) -> Retention {
        Retention { roster, baselines: HashMap::new(), projector: CompanyProjector::default() }
    }

    /// `company` with `members` over `end` hours, the tool timelines over
    /// `timeline_end`; spare tools are the free ones and `employee`'s.
    fn project(
        &mut self,
        company: usize,
        end: f64,
        timeline_end: f64,
        employee: usize,
        members: &[MemberTool],
    ) -> Result<Rc<Timed>, Fail> {
        let roster = &self.roster;
        let held: HashSet<usize> = members.iter().filter_map(|m| m.tool).collect();
        let spares = (0..roster.tools.len())
            .filter(|t| {
                matches!(roster.tools[*t].holder, Holder::Free)
                    || roster.tools[*t].holder == Holder::Employee(employee)
            })
            .filter(|t| !held.contains(t));
        let groups = [CompanyGroup { company, members: members.to_vec() }];
        let lines = roster.handoffs(timeline_end, &groups, spares);
        let members: Vec<LayoutMember> = members
            .iter()
            .zip(lines.into_iter().next().unwrap_or_default())
            .map(|(member, line)| LayoutMember {
                employee: member.employee,
                tool: member.tool,
                line,
            })
            .collect();
        let projected = roster.project(&mut self.projector, end, company, &members, None);
        let projection = projection_of(
            projected,
            members.iter().map(|m| {
                let e = &roster.people[m.employee];
                ProjectedMember {
                    id: e.id,
                    employee: m.employee,
                    subject: false,
                    working_days: working_days(e),
                }
            }),
        );
        let credits = projected
            .credits
            .iter()
            .map(|&(slot, day, v)| (members[slot].employee, day, v))
            .collect();
        Ok(Rc::new(Timed { projection, daily: projected.daily.clone(), credits }))
    }

    /// `price(id)` for an employee whose company is planned.
    pub fn price(&mut self, employee: usize) -> Result<Kept, Fail> {
        if !self.roster.numbers_known {
            return Err(Fail::UnknownNumbers);
        }
        let Some(company) = self.roster.company_of[employee] else {
            return Err(Fail::NotPlanned);
        };
        let members: Vec<MemberTool> = (0..self.roster.len())
            .filter(|&x| self.roster.company_of[x] == Some(company))
            .map(|x| MemberTool { employee: x, tool: self.roster.equipped[x] })
            .collect();
        let days = members
            .iter()
            .map(|member| working_days(&self.roster.people[member.employee]).ceil())
            .fold(1.0, f64::max)
            .min(47.0);
        let (end, timeline_end) =
            (self.roster.projection_hours.unwrap_or(days * 24.0), days * 24.0);
        let baseline = match self.baselines.get(&company) {
            Some(b) => b.clone(),
            None => {
                let b = self.project(company, end, timeline_end, employee, &members)?;
                self.baselines.insert(company, b.clone());
                b
            }
        };
        let rest: Vec<MemberTool> =
            members.iter().copied().filter(|m| m.employee != employee).collect();
        let without = self.project(company, end, timeline_end, employee, &rest)?;
        let mut by_day: Vec<f64> =
            baseline.daily.iter().zip(&without.daily).map(|(a, b)| a - b).collect();
        for &(x, day, v) in &baseline.credits {
            if x == employee {
                by_day[day] -= v;
            }
        }
        let (baseline, without) = (&baseline.projection, &without.projection);
        let row = baseline.rows.iter().find(|r| r.employee == employee);
        let own = row.map_or(0.0, |r| r.value) - row.map_or(0.0, |r| r.training);
        let value = baseline.value - without.value - row.map_or(0.0, |r| r.training);
        let rows = |p: &Projection| -> Vec<MemberHappiness> {
            p.rows
                .iter()
                .map(|r| MemberHappiness { employee: r.employee, min_happiness: r.min_happiness })
                .collect()
        };
        Ok(Kept { value, own, with: rows(baseline), without: rows(without), by_day })
    }
}
