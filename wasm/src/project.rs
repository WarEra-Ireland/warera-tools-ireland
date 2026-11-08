//! The planner's projection: what a company's roster earns, hour by hour,
//! over the horizon (`scene_of`, `effects`, `instant`, `trait_hours`,
//! `training_mean`, `profit_on`, `production_points_on`).
//!
//! Inputs are flat records: an employee (`EmployeeRecord`), a company
//! (`CompanyRecord`) and the members with their tools (`Call`). The records
//! are built once, when the `Snapshot` handle decodes (snapshot.rs); card
//! variants and career states are copies changed in the module. Strings
//! (ids, goods, countries, trait args) are interned: `intern` gives the id,
//! 0 standing for undefined and 1 for ''.
//!
//! Projections run in a workspace kept between calls, so nothing allocates
//! per hour (or, once the workspace has grown, per call). The hot path
//! gives totals only (`Projected`, kept in the workspace); rows for the UI
//! come from `instant` at hour 0.
//!
//! The order of the sums is part of the result: `instant`'s comments give it.

use crate::cfg::CFG;
use crate::hourly::{HourlyEffects, StatArgument, has_hourly, hourly};
use crate::model::Situation;
use crate::rules::{PeerRow, peer_production_into, rarity_odds, toolbox_rate};
use crate::traits::Trait::{self, *};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

/// Thresholds are evaluated exactly at event boundaries; this absorbs float
/// error from converting a fractional tenure into hours and back.
const EPS: f64 = 1e-9;

// --- Interned strings ---

struct Strings {
    id_by_text: HashMap<Rc<str>, u32>,
    /// By id: '' for both undefined (0) and '' (1), then the rest.
    text_by_id: Vec<Rc<str>>,
}

thread_local! {
    static STRINGS: RefCell<Strings> = RefCell::new(Strings {
        id_by_text: HashMap::new(),
        text_by_id: vec!["".into(), "".into()],
    });
    static PLACES: [Rc<str>; 3] = ["abroad".into(), "homeCore".into(), "home".into()];
}

/// A string's id: 1 for '', 2 and up for the rest (0 is undefined).
pub fn intern(s: &str) -> u32 {
    if s.is_empty() {
        return 1;
    }
    STRINGS.with(|t| {
        let mut t = t.borrow_mut();
        if let Some(&id) = t.id_by_text.get(s) {
            return id;
        }
        let text: Rc<str> = s.into();
        let id = t.text_by_id.len() as u32;
        t.text_by_id.push(text.clone());
        t.id_by_text.insert(text, id);
        id
    })
}

/// The string behind an id; None for undefined.
pub fn string(id: u32) -> Option<Rc<str>> {
    if id == 0 {
        return None;
    }
    STRINGS.with(|t| t.borrow().text_by_id.get(id as usize).cloned())
}
pub(crate) fn intern_optional(s: Option<&str>) -> u32 {
    s.map_or(0, intern)
}
/// Whether an interned string is set: neither missing (0) nor '' (1).
pub(crate) fn truthy_string(id: u32) -> bool {
    id > 1
}

// --- Records ---

/// The traits `instant` asks about (`flagsFor`), and the ones whose timing
/// adds boundaries (`traitHours`), as bits.
pub mod flag {
    pub const RIVAL: u32 = 1;
    pub const MENTOR: u32 = 1 << 1;
    pub const LUCKY_CHARM: u32 = 1 << 2;
    pub const JINX: u32 = 1 << 3;
    pub const TRAINER: u32 = 1 << 4;
    pub const SALVAGER: u32 = 1 << 5;
    pub const SCAVENGER: u32 = 1 << 6;
    pub const STOCKPILER: u32 = 1 << 7;
    pub const LOYAL: u32 = 1 << 8;
    pub const QUICK_STUDY: u32 = 1 << 9;
    pub const ANCHOR: u32 = 1 << 10;
    /// Whether `effects` has anything to do: a trait it handles itself or
    /// one with an hourly rule it doesn't skip.
    pub const HOURLY: u32 = 1 << 11;
    pub const RECRUITER: u32 = 1 << 12;
    pub const VETERAN: u32 = 1 << 13;
    pub const DIAMOND: u32 = 1 << 14;
    pub const BURNOUT: u32 = 1 << 15;
    pub const HABIT: u32 = 1 << 16;
    /// Late Bloomer, Early Bloomer or Worn Out: effects that step with age.
    pub const AGE: u32 = 1 << 17;
}
use flag::{
    AGE, ANCHOR, BURNOUT, DIAMOND, HABIT, HOURLY, JINX, LOYAL, LUCKY_CHARM, MENTOR, QUICK_STUDY,
    RECRUITER, RIVAL, SALVAGER, SCAVENGER, STOCKPILER, TRAINER, VETERAN,
};

/// Hourly rules `effects` leaves to `instant` (or that only value money).
/// Rival and Mentor are settled together there (`peer_production`).
fn skip_hourly(t: Trait) -> bool {
    matches!(t, Rival | Mentor | Loyal | Stockpiler | Anchor | Climber | LuckyCharm | Jinx)
}

/// A held trait: its id (None for a code the model doesn't know, which the
/// projection ignores), and its arg as an interned id and as text.
#[derive(Clone, Default)]
pub struct TraitRecord {
    pub id: Option<Trait>,
    pub arg: u32,
    pub arg_text: Option<Rc<str>>,
}

impl TraitRecord {
    pub(crate) fn new(id: Option<Trait>, arg: u32) -> TraitRecord {
        TraitRecord { id, arg, arg_text: if truthy_string(arg) { string(arg) } else { None } }
    }
}

/// A timed event: `delta` for `hours_left` more hours.
#[derive(Clone, Copy)]
pub struct TimedEvent {
    pub delta: f64,
    pub hours_left: f64,
}

/// An employee as the projection reads it. The numbers `validate` requires
/// (age, production, responsibility, wage, tenure, employed days) are NaN
/// when unknown, and no export projects an employee with one: they check
/// first (`check::numbers_known`). The others are typed (see snapshot.rs).
#[derive(Clone, Default)]
pub struct EmployeeRecord {
    pub id: u32,
    pub company: u32,
    pub age: f64,
    /// Days to retirement, when known (else from the age).
    pub retire_in_days: Option<f64>,
    pub production: f64,
    pub trait_production: f64,
    pub responsibility: f64,
    pub luck: f64,
    /// The Luck that training draws on, if not today's.
    pub training_base_luck: Option<f64>,
    pub training_luck: Option<f64>,
    /// Trainings left, when known: none are valued without.
    pub potential_left: Option<f64>,
    pub wage: f64,
    /// Climber's raise; 0 without one.
    pub climber_raise: f64,
    pub employed_days: f64,
    /// Hours since they last moved: infinite if they never did (or it isn't
    /// known).
    pub move_age_hours: f64,
    pub tenure: f64,
    pub female: bool,
    pub nationality: u32,
    /// The game's reported Luck and trainings a day, when it reports them.
    pub observed_luck: Option<f64>,
    pub observed_trainings_per_day: Option<f64>,
    pub traits: Vec<TraitRecord>,
    pub flags: u32,
    /// Happiness events: delta, hours left.
    pub happiness_events: Vec<TimedEvent>,
    /// Production events: delta %, hours left.
    pub production_events: Vec<TimedEvent>,
    /// A training's value at each rarity, in `Rarity::ALL` order; without
    /// them, training isn't valued.
    pub training_values: Option<[f64; 5]>,
}

impl EmployeeRecord {
    /// Fills in the flags from the traits.
    pub(crate) fn update_flags(&mut self) {
        let mut f = 0;
        for t in &self.traits {
            let Some(id) = t.id else { continue };
            f |= match id {
                Rival => RIVAL,
                Mentor => MENTOR,
                LuckyCharm => LUCKY_CHARM,
                Jinx => JINX,
                Trainer => TRAINER,
                Salvager => SALVAGER,
                Scavenger => SCAVENGER,
                Stockpiler => STOCKPILER,
                Loyal => LOYAL,
                QuickStudy => QUICK_STUDY,
                Anchor => ANCHOR,
                Recruiter => RECRUITER,
                Veteran => VETERAN,
                DiamondInTheRough => DIAMOND,
                Burnout => BURNOUT,
                CreatureOfHabit => HABIT,
                LateBloomer | EarlyBloomer | WornOut => AGE,
                _ => 0,
            };
            if !skip_hourly(id) && (id == CreatureOfHabit || id == Comic || has_hourly(id)) {
                f |= HOURLY;
            }
        }
        self.flags = f;
    }
}

/// `workingDays`.
pub fn working_days(e: &EmployeeRecord) -> f64 {
    e.retire_in_days.unwrap_or(CFG.retire_age - e.age).max(0.0)
}

/// The wage as reported, plus Climber raises to come.
pub fn wage_at(e: &EmployeeRecord, hour: f64) -> f64 {
    if e.climber_raise == 0.0 {
        return e.wage;
    }
    e.wage
        + e.climber_raise
            * (((e.employed_days + hour / 24.0 + EPS) / 7.0).floor()
                - ((e.employed_days + EPS) / 7.0).floor())
}

/// `paidProduction` of `{ production, traitProduction }`.
pub fn paid_production(production: f64, trait_production: f64) -> f64 {
    (production + if crate::cfg::trait_production_paid() { trait_production } else { 0.0 }).max(1.0)
}

/// The wage on `trait_production` own-trait Production.
fn paid_wage_at(e: &EmployeeRecord, hour: f64, trait_production: f64) -> f64 {
    wage_at(e, hour) * paid_production(e.production, trait_production)
        / paid_production(e.production, e.trait_production)
}

/// A company as the projection reads it. Its margin and tax are NaN when
/// unknown, and no export projects it then (`check::numbers_known`).
#[derive(Clone, Default)]
pub struct CompanyRecord {
    pub id: u32,
    pub product: u32,
    pub product_text: Option<Rc<str>>,
    pub item_type_text: Option<Rc<str>>,
    /// The tool type its good takes (`TOOL_OF[product]`), interned.
    pub tool_type: u32,
    pub margin: f64,
    pub disabled: bool,
    pub engine_daily_prod: f64,
    pub engine_bonus: f64,
    pub bonus: f64,
    pub tax: f64,
    pub country: u32,
    pub core_country: u32,
    /// Storage capacity, when known.
    pub storage: Option<f64>,
    pub full: bool,
    /// Re-tooled onto another good (`company.switch`).
    pub switched: bool,
    pub switch_cost: f64,
    /// What recruiting is worth with 0 to 3 Recruiters at work, when it is
    /// valued.
    pub recruitment: Option<[f64; 4]>,
}

/// A tool: its type (interned), bonus and hours left.
#[derive(Clone, Copy, Default)]
pub struct Tool {
    pub tool_type: u32,
    pub bonus: f64,
    pub hours: f64,
}

/// A timeline segment: a tool of `tool_type` and `bonus` held from hour
/// `from` until `to`. The timeline ends it, so the tool's hours aren't
/// kept.
#[derive(Clone, Copy)]
pub struct Segment {
    pub tool_type: u32,
    pub bonus: f64,
    pub from: f64,
    pub to: f64,
}

/// `count` entries from `start` of a list kept elsewhere.
#[derive(Clone, Copy, Default)]
pub struct IndexRange {
    pub start: usize,
    pub count: usize,
}
impl IndexRange {
    #[inline]
    pub fn indices(self) -> Range<usize> {
        self.start..self.start + self.count
    }
}

/// Where a member's employee record lives: among the session's employees
/// (`CallProjector::run`'s `snapshot`), or held by the caller.
#[derive(Clone, Copy)]
pub enum Who {
    Snapshot(usize),
    Held(usize),
}

#[derive(Clone, Copy)]
pub struct Member {
    pub who: Who,
    /// `e.specializations[company.product] || 0`.
    pub saved: f64,
    pub tool: Option<Tool>,
    /// Its timeline, a range of `Call::segments`; None when it has none.
    pub line: Option<IndexRange>,
}

/// One projection's inputs: the company, its members with their tools and
/// tool timelines, and the settings it reads.
#[derive(Default)]
pub struct Call {
    /// Hours projected: `s.hours ?? s.days * 24`.
    pub end: f64,
    pub training_quota: f64,
    pub management: f64,
    pub toolbox_value: f64,
    /// How many work at the company in the snapshot (`currentSize`).
    pub current_size: f64,
    pub company: CompanyRecord,
    pub members: Vec<Member>,
    pub segments: Vec<Segment>,
}

/// A call's inputs with the snapshot employees it refers to, and those its
/// caller holds.
struct View<'a> {
    call: &'a Call,
    snapshot: &'a [EmployeeRecord],
    held: &'a [HeldMember<'a>],
}
impl View<'_> {
    /// Member `i`'s employee.
    #[inline]
    fn employee(&self, i: usize) -> &EmployeeRecord {
        match self.call.members[i].who {
            Who::Snapshot(k) => &self.snapshot[k],
            Who::Held(k) => self.held[k].employee,
        }
    }
}

// --- One hour: effects and instant ---

/// What an employee's traits see of their coworkers (`scene`); fixed while
/// the roster is. `better_paid` and `has_tool` are set afresh each hour.
#[derive(Default)]
struct Scene {
    situation: Situation,
    male_coworkers: f64,
}

/// How an employee stands among a roster's other members (`scene`'s counts).
#[derive(Clone, Copy)]
pub struct Standing {
    pub coworkers: f64,
    pub female_coworkers: f64,
    pub same_nationality_coworkers: f64,
    pub other_nationalities: f64,
}

/// Member `i`'s standing among `roster`.
fn standing(view: &View, roster: &[usize], i: usize) -> Standing {
    standing_by(roster.len(), |k| view.employee(roster[k]), view.employee(i))
}
/// The standing of `e` among the roster's `n` employees, `at(k)` the k-th.
fn standing_by<'a>(
    n: usize,
    at: impl Fn(usize) -> &'a EmployeeRecord,
    e: &EmployeeRecord,
) -> Standing {
    let (mut others, mut female, mut same, mut other) = (0.0, 0.0, 0.0, 0.0);
    for k in 0..n {
        let x = at(k);
        if x.id == e.id {
            continue;
        }
        others += 1.0;
        if x.female {
            female += 1.0;
        }
        if x.nationality == e.nationality {
            same += 1.0;
        }
        let nationality = x.nationality;
        if truthy_string(nationality)
            && nationality != e.nationality
            && !(0..k).any(|p| {
                let y = at(p);
                y.id != e.id && y.nationality == nationality
            })
        {
            other += 1.0;
        }
    }
    Standing {
        coworkers: others,
        female_coworkers: female,
        same_nationality_coworkers: same,
        other_nationalities: other,
    }
}

/// The situation `scene` builds for an employee among a roster at a
/// company: the training model's context.
pub struct TrainingScene {
    pub standing: Standing,
    /// 0 abroad, 1 homeCore, 2 home (see `place_name`).
    pub place: usize,
    pub home_core: bool,
    pub small_storage: bool,
}

/// The training scene of `e` among `roster` at `company`.
pub fn scene_of(
    company: &CompanyRecord,
    roster: &[&EmployeeRecord],
    e: &EmployeeRecord,
) -> TrainingScene {
    let standing = standing_by(roster.len(), |k| roster[k], e);
    let (place, home_core) = location(company, e.nationality);
    TrainingScene { standing, place, home_core, small_storage: small_storage(company) }
}

/// Whether the company's storage holds 2 or less.
fn small_storage(company: &CompanyRecord) -> bool {
    company.storage.is_some_and(|storage| storage <= 2.0)
}

/// `PLACES[i]`: abroad, homeCore, home.
pub fn place_name(i: usize) -> Rc<str> {
    PLACES.with(|p| p[i].clone())
}

/// `locationSituation`: (place 0 abroad / 1 homeCore / 2 home, homeCore).
fn location(company: &CompanyRecord, nationality: u32) -> (usize, bool) {
    let place = if company.country != nationality {
        0
    } else if company.core_country == nationality {
        1
    } else {
        2
    };
    (place, company.core_country == nationality)
}

fn build_scene(view: &View, roster: &[usize], i: usize, scene: &mut Scene) {
    let co = &view.call.company;
    let counts = standing(view, roster, i);
    let (place, home_core) = location(co, view.employee(i).nationality);
    let s = &mut scene.situation;
    s.coworkers = counts.coworkers;
    s.female_coworkers = counts.female_coworkers;
    s.same_nationality_coworkers = Some(counts.same_nationality_coworkers > 0.0);
    s.other_nationalities = counts.other_nationalities;
    s.place = Some(PLACES.with(|p| p[place].clone()));
    s.home_core = Some(home_core);
    s.item_type = co.item_type_text.clone();
    s.product = co.product_text.clone();
    s.income_tax = co.tax;
    s.small_storage = small_storage(co);
    s.storage_full = co.full;
    scene.male_coworkers = counts.coworkers - counts.female_coworkers;
}

/// One employee's trait effects this hour: physical effects collected, not
/// money. Team effects go to the coworkers in `instant`.
#[derive(Clone, Copy, Default)]
struct RowEffects {
    engine: f64,
    production: f64,
    responsibility: f64,
    luck: f64,
    bonus: f64,
    team_production: f64,
    /// A Comic's boost to coworkers (0: none).
    comic: f64,
    /// Ranges of `HappinessEffects::own` and `team`.
    happiness: IndexRange,
    team_happiness: IndexRange,
}

/// The `x` the hourly rules are handed in `effects`: what they read of the
/// employee and their scene, and where their effects go.
struct EffectCollector<'a> {
    situation: &'a Situation,
    male_coworkers: f64,
    age: f64,
    tenure: f64,
    own_luck: f64,
    arg: Option<&'a str>,
    /// Engine output an hour, for Talks to Machines.
    engine_per_hour: f64,
    effects: &'a mut RowEffects,
    happiness: &'a mut Vec<f64>,
    team_happiness: &'a mut Vec<f64>,
    /// Comics don't stack: their team happiness is kept apart.
    comic: bool,
}

impl HourlyEffects for EffectCollector<'_> {
    fn situation(&self) -> &Situation {
        self.situation
    }
    fn held(&self) -> bool {
        true
    }
    fn male_coworkers(&self) -> f64 {
        self.male_coworkers
    }
    // `effects` leaves Loyal and Climber, the rules that read these two, to
    // `instant` (`skip_hourly`): it halves the losses and pays the raises
    // (`wage_at`).
    fn happiness_loss(&self) -> f64 {
        unreachable!()
    }
    fn arg(&self) -> Option<&str> {
        self.arg
    }
    fn age(&self) -> f64 {
        self.age
    }
    fn tenure_days(&self) -> f64 {
        self.tenure
    }
    fn employed_days(&self) -> f64 {
        unreachable!()
    }
    fn own_luck(&self) -> f64 {
        self.own_luck
    }
    fn production(&mut self, d: f64) -> f64 {
        self.effects.production += d;
        0.0
    }
    fn output_percent(&mut self, p: f64) -> f64 {
        self.effects.bonus += p;
        0.0
    }
    fn happiness(&mut self, h: f64) -> f64 {
        self.happiness.push(h);
        0.0
    }
    fn responsibility(&mut self, d: f64) -> f64 {
        self.effects.responsibility += d;
        0.0
    }
    fn luck(&mut self, d: f64) -> f64 {
        self.effects.luck += d;
        0.0
    }
    fn toolboxes(&mut self, _: f64) -> f64 {
        0.0
    }
    fn wage(&mut self, _: f64) -> f64 {
        0.0
    }
    fn raise(&mut self, _: f64) -> f64 {
        0.0
    }
    fn team_happiness(&mut self, h: f64) -> f64 {
        if self.comic {
            self.effects.comic = h
        } else {
            self.team_happiness.push(h)
        }
        0.0
    }
    fn team_production(&mut self, d: f64) -> f64 {
        self.effects.team_production += d;
        0.0
    }
    fn engine(&mut self) -> f64 {
        self.effects.engine += self.engine_per_hour;
        0.0
    }
    fn quick_study(&mut self) -> f64 {
        0.0
    }
    fn stat(&mut self, stat: StatArgument, k: f64) -> f64 {
        match stat {
            StatArgument::Production => self.production(k),
            StatArgument::Responsibility => self.responsibility(k),
            StatArgument::Other => self.luck(k),
        }
    }
}

/// Whether a coworker on the roster is `arg` (a partner trait's employee).
fn partner(view: &View, roster: &[usize], own: u32, arg: u32) -> bool {
    roster.iter().any(|&j| {
        let x = view.employee(j).id;
        x != own && x == arg
    })
}

/// The happiness effects `effects` collected, each member's in its
/// `RowEffects` ranges.
#[derive(Default)]
struct HappinessEffects {
    own: Vec<f64>,
    team: Vec<f64>,
}

/// Member `i`'s effects at `hour`, its happiness effects appended to
/// `happiness`.
fn effects(
    view: &View,
    roster: &[usize],
    i: usize,
    hour: f64,
    held: bool,
    scene: &mut Scene,
    happiness: &mut HappinessEffects,
) -> RowEffects {
    let e = view.employee(i);
    let co = &view.call.company;
    let mut out = RowEffects {
        happiness: IndexRange { start: happiness.own.len(), count: 0 },
        team_happiness: IndexRange { start: happiness.team.len(), count: 0 },
        ..RowEffects::default()
    };
    let moved = e.company != co.id;
    // Tenure is continuous: Veteran, Diamond and Burnout switch at the exact
    // hour, which project adds as a boundary. Age, for Early Bloomer, Late
    // Bloomer and Worn Out, steps at the daily boundaries.
    let tenure = (if moved { 0.0 } else { e.tenure }) + hour / 24.0 + EPS;
    if e.flags & HOURLY == 0 || e.traits.is_empty() {
        return out;
    }
    // Pay as reported: a move's change to own-trait Production isn't in it.
    let own = wage_at(e, hour) + 1e-9;
    let mut better_paid = 0.0;
    for &j in roster {
        let x = view.employee(j);
        if x.id != e.id && wage_at(x, hour) > own {
            better_paid += 1.0;
        }
    }
    scene.situation.better_paid = better_paid;
    scene.situation.has_tool = held;
    let age = e.age + (hour / 24.0).floor();
    let engine = co.engine_daily_prod / 24.0 * (1.0 + co.engine_bonus);
    for t in &e.traits {
        let Some(id) = t.id else { continue };
        if skip_hourly(id) {
            continue;
        }
        if id == CreatureOfHabit {
            if (if moved { hour } else { hour + e.move_age_hours }) < 72.0 - 1e-6 {
                out.bonus -= 30.0;
            }
            continue;
        }
        let comic = id == Comic;
        if !comic && (!has_hourly(id) || id.rule().partner && !partner(view, roster, e.id, t.arg)) {
            continue;
        }
        let mut x = EffectCollector {
            situation: &scene.situation,
            male_coworkers: scene.male_coworkers,
            age,
            tenure,
            own_luck: e.luck,
            arg: if comic { None } else { t.arg_text.as_deref() },
            engine_per_hour: engine,
            effects: &mut out,
            happiness: &mut happiness.own,
            team_happiness: &mut happiness.team,
            comic,
        };
        hourly(id, &mut x);
    }
    out.happiness.count = happiness.own.len() - out.happiness.start;
    out.team_happiness.count = happiness.team.len() - out.team_happiness.start;
    out
}

/// An `instant` row: a working member's figures at an hour. The planner
/// adds id, company, tool and `parts.company` (`planner::TotalsRow`).
#[derive(Clone, Copy, Default)]
pub struct Row {
    /// The member's index in the call.
    pub member: usize,
    /// Where the tool they work with comes from, if they work with one.
    pub tool: Option<ToolSource>,
    pub luck: f64,
    pub learning_luck: f64,
    pub toolboxes: f64,
    pub loot: f64,
    pub training_rate: f64,
    pub trainings_per_day: f64,
    pub production: f64,
    pub responsibility: f64,
    pub happiness: f64,
    pub specialization: f64,
    pub bonus: f64,
    /// The bonus's parts from traits, events, the tool and own-trait
    /// Production.
    pub traits: f64,
    pub events: f64,
    pub tool_bonus: f64,
    pub trait_production: f64,
    pub output: f64,
    pub engine_output: f64,
    pub wage: f64,
    pub profit: f64,
}

/// What `profitOn` needs to price a row on a later day of its stretch.
#[derive(Clone, Copy, Default)]
struct ProfitTerms {
    engine: f64,
    production: f64,
    /// The company's, the traits' and the events' bonus: every bonus that
    /// comes before specialization.
    base_bonus: f64,
    happiness: f64,
    tool_bonus: f64,
    anchor_bonus: f64,
    saved: f64,
    loot: f64,
    /// Specialization gained a day.
    specialization_rate: f64,
    wage: f64,
}

/// A row's profit on a later day of the same stretch, where only
/// specialization moves: instant's arithmetic in the same order.
#[inline]
fn profit_on(terms: &ProfitTerms, day: f64, margin: f64) -> f64 {
    terms.production / 4.0
        * (1.0
            + (terms.base_bonus
                + (terms.saved + day * terms.specialization_rate).min(20.0)
                + terms.happiness
                - 50.0
                + terms.tool_bonus
                + terms.anchor_bonus)
                / 100.0)
            .max(0.0)
        * margin
        + terms.engine * margin
        - terms.wage
        + terms.loot
}
/// The production points behind `profit_on`: its output and engine terms
/// (`ppOn`).
#[inline]
fn production_points_on(terms: &ProfitTerms, day: f64) -> f64 {
    terms.production / 4.0
        * (1.0
            + (terms.base_bonus
                + (terms.saved + day * terms.specialization_rate).min(20.0)
                + terms.happiness
                - 50.0
                + terms.tool_bonus
                + terms.anchor_bonus)
                / 100.0)
            .max(0.0)
        + terms.engine
}

/// Where the tool a member works with comes from.
#[derive(Clone, Copy, PartialEq)]
pub enum ToolSource {
    /// The tool they hold from hour 0.
    Held,
    /// Their timeline's segment at this index.
    Line(usize),
}

/// The tool a member works with at an hour, and where it comes from.
#[derive(Clone, Copy)]
struct ActiveTool {
    source: ToolSource,
    tool_type: u32,
    bonus: f64,
}

/// A member's totals over a projection.
#[derive(Clone, Copy)]
pub struct MemberTotals {
    /// What they add to the company's value.
    pub value: f64,
    /// The part of it training adds.
    pub training: f64,
    /// Their lowest happiness at work (100 if they never work).
    pub min_happiness: f64,
}

impl MemberTotals {
    const NONE: MemberTotals = MemberTotals { value: 0.0, training: 0.0, min_happiness: 100.0 };
}

/// A member of a re-tooled company, as repricing it reads them.
#[derive(Clone, Copy)]
pub struct RetoolMember {
    /// Specialization days saved on the good.
    pub saved: f64,
    /// Specialization days gained a day.
    pub rate: f64,
}

/// What repricing a re-tooled company on another good of its class needs
/// (the planner's `Env::value`).
#[derive(Clone, Default)]
pub struct Retooling {
    /// Whether every bonus before specialization stayed above -100%: output
    /// then moves linearly with specialization.
    pub linear: bool,
    /// By member, in the call's order.
    pub members: Vec<RetoolMember>,
    days: usize,
    /// By member, `days` entries each (a repeated id's in its last member).
    base_output: Vec<f64>,
}

impl Retooling {
    /// Member `i`'s Production / 4 x hours worked on each day.
    pub fn base_output(&self, i: usize) -> &[f64] {
        &self.base_output[i * self.days..(i + 1) * self.days]
    }
}

/// A projection's result, kept in its workspace: the lists are reused
/// between calls.
#[derive(Default)]
pub struct Projected {
    /// The company's value over the hours.
    pub value: f64,
    /// Production points made (output and engine) over the hours, for price
    /// exposure.
    pub production_points: f64,
    /// The value by day (`day_count` days).
    pub daily: Vec<f64>,
    /// The training values in `daily`: `(slot, day, value)`, the member by
    /// place in the call (the last of a repeated id).
    pub credits: Vec<(usize, usize, f64)>,
    /// By member, in the call's order. Members with one id share the last
    /// one's totals.
    pub members: Vec<MemberTotals>,
    retooled: bool,
    retooling: Retooling,
}

impl Projected {
    /// A re-tooled company's terms for repricing; None for one that isn't.
    pub fn retooling(&self) -> Option<&Retooling> {
        self.retooled.then_some(&self.retooling)
    }
}

/// The workspace, kept between calls.
#[derive(Default)]
struct Workspace {
    /// The members working at the hour `instant` last ran for.
    roster: Vec<usize>,
    /// The roster the scenes were built for, while `scenes_valid`.
    scene_roster: Vec<usize>,
    scenes_valid: bool,
    /// By member index.
    scenes: Vec<Scene>,
    /// By roster place: own effects, and the tool worked with if it fits
    /// the company.
    effects: Vec<RowEffects>,
    active_tools: Vec<Option<ActiveTool>>,
    happiness: HappinessEffects,
    /// By roster place: `peer_production_into`'s rows (Production before
    /// coworkers, Rival, Mentor), its scratch and its results.
    peer_rows: Vec<PeerRow>,
    peer_basis: Vec<f64>,
    productions: Vec<f64>,
    /// `instant`'s rows, and what pricing each on a later day needs.
    rows: Vec<Row>,
    profit_terms: Vec<ProfitTerms>,
    /// The hours at which effects are worked out afresh.
    boundaries: Vec<f64>,
    /// Per member, where their totals are kept: the last member with their id.
    totals_slot: Vec<usize>,
    /// By slot: the totals, and the trainings made so far.
    slot_totals: Vec<MemberTotals>,
    progress: Vec<f64>,
    /// The last projection's result.
    result: Projected,
}

/// The tool a member holds at `hour`: their timeline's, or the one tool
/// held from hour 0 until it runs out.
fn tool_at(call: &Call, member: &Member, hour: f64) -> Option<ActiveTool> {
    match member.line {
        None => member.tool.filter(|t| hour < t.hours).map(|t| ActiveTool {
            source: ToolSource::Held,
            tool_type: t.tool_type,
            bonus: t.bonus,
        }),
        Some(line) => call.segments[line.indices()]
            .iter()
            .enumerate()
            .find(|(_, x)| x.from <= hour && hour < x.to)
            .map(|(k, x)| ActiveTool {
                source: ToolSource::Line(k),
                tool_type: x.tool_type,
                bonus: x.bonus,
            }),
    }
}

impl Workspace {
    /// `instant`: every working member's row at `hour`, into `rows` and
    /// `profit_terms`.
    fn instant(&mut self, view: &View, hour: f64) {
        let call = view.call;
        let co = &call.company;
        self.roster.clear();
        for i in 0..call.members.len() {
            if hour < working_days(view.employee(i)) * 24.0 {
                self.roster.push(i);
            }
        }
        if !self.scenes_valid || self.scene_roster != self.roster {
            while self.scenes.len() < call.members.len() {
                self.scenes.push(Scene::default());
            }
            for &i in &self.roster {
                build_scene(view, &self.roster, i, &mut self.scenes[i]);
            }
            self.scene_roster.clone_from(&self.roster);
            self.scenes_valid = true;
        }
        let n = self.roster.len();
        self.effects.clear();
        self.active_tools.clear();
        self.happiness.own.clear();
        self.happiness.team.clear();
        for r in 0..n {
            let i = self.roster[r];
            let held = tool_at(call, &call.members[i], hour);
            let own = effects(
                view,
                &self.roster,
                i,
                hour,
                held.is_some(),
                &mut self.scenes[i],
                &mut self.happiness,
            );
            self.effects.push(own);
            self.active_tools.push(held.filter(|active| active.tool_type == co.tool_type));
        }
        self.peer_rows.clear();
        for r in 0..n {
            let e = view.employee(self.roster[r]);
            self.peer_rows.push(PeerRow {
                production: e.production + self.effects[r].production,
                rival: e.flags & RIVAL != 0,
                mentor: e.flags & MENTOR != 0,
            });
        }
        peer_production_into(&self.peer_rows, &mut self.peer_basis, &mut self.productions);
        let intact = n as f64 == call.current_size
            && self.roster.iter().all(|&i| view.employee(i).company == co.id);
        let day = (hour / 24.0).floor();
        let toolbox_value = call.toolbox_value;
        let quota = call.training_quota;
        self.rows.clear();
        self.profit_terms.clear();
        for r in 0..n {
            let i = self.roster[r];
            let e = view.employee(i);
            let fx = self.effects[r];
            let flags = e.flags;
            // Sums run in the order the effects were once collected in: own
            // effects, the first coworker Comic, then coworkers in roster order.
            let (mut comic, mut coworker_luck, mut trainers) = (None, 0.0, 0.0);
            for o in 0..n {
                let x = view.employee(self.roster[o]);
                if x.id == e.id {
                    continue;
                }
                if comic.is_none() && self.effects[o].comic != 0.0 {
                    comic = Some(self.effects[o].comic);
                }
                coworker_luck = coworker_luck + if x.flags & LUCKY_CHARM != 0 { 3.0 } else { 0.0 }
                    - if x.flags & JINX != 0 { 2.0 } else { 0.0 };
                if x.flags & TRAINER != 0 {
                    trainers += 1.0;
                }
            }
            let production = self.productions[r];
            // The game's coworker Luck and training allowance lag roster and trait
            // changes, by a rule snapshots do not reveal. Its reported values stand
            // while the roster is the reported one; changed rosters use the model.
            let (observed_luck, observed_trainings) =
                if intact { (e.observed_luck, e.observed_trainings_per_day) } else { (None, None) };
            // A card's own Luck gain moves the reported total with it. Training
            // leaves that gain out (the page values it with its own forecast),
            // so training Luck never depends on the employee's own Luck.
            let base_luck = e.training_base_luck.unwrap_or(e.luck);
            let (luck, learning_luck) = match observed_luck {
                Some(observed) => (observed + e.luck - base_luck, observed),
                None => (
                    (e.luck + fx.luck + coworker_luck).max(1.0),
                    (base_luck + fx.luck + coworker_luck).max(1.0),
                ),
            };
            let mut toolboxes = if co.full && flags & SALVAGER == 0 {
                0.0
            } else {
                toolbox_rate(luck) * if flags & SCAVENGER != 0 { 2.0 } else { 1.0 }
            };
            let mut loot = toolboxes * toolbox_value;
            let trainings_per_day = observed_trainings.unwrap_or(1.0 + 2.0 * trainers);
            let mut training_rate = quota.min(trainings_per_day);
            let responsibility = (e.responsibility + fx.responsibility).max(1.0);
            // Responsibility adds 3 happiness a point; Loyal halves every loss.
            let loss = if flags & LOYAL != 0 { 0.5 } else { 1.0 };
            let mut felt = 0.0;
            let mut feel = |h: f64| felt += h * if h < 0.0 { loss } else { 1.0 };
            for &h in &self.happiness.own[fx.happiness.indices()] {
                feel(h);
            }
            if let Some(c) = comic {
                feel(c);
            }
            for o in 0..n {
                if view.employee(self.roster[o]).id == e.id {
                    continue;
                }
                for &h in &self.happiness.team[self.effects[o].team_happiness.indices()] {
                    feel(h);
                }
            }
            feel(-co.tax);
            if co.full && flags & STOCKPILER == 0 {
                feel(-10.0);
            }
            for event in &e.happiness_events {
                if hour < event.hours_left {
                    feel(event.delta);
                }
            }
            let mood =
                (50.0 + CFG.responsibility_happiness * responsibility + felt).clamp(0.0, 100.0);
            let saved = call.members[i].saved;
            let rate = if flags & QUICK_STUDY != 0 { 2.0 } else { 1.0 };
            let specialization = (saved + day * rate).min(20.0);
            let anchor = if flags & ANCHOR != 0 && mood < 30.0 { -50.0 } else { 0.0 };
            let mut events = 0.0;
            for event in &e.production_events {
                events += if hour < event.hours_left { event.delta } else { 0.0 };
            }
            let active = self.active_tools[r];
            let tool_bonus = active.map_or(0.0, |active| active.bonus);
            let bonus =
                co.bonus + fx.bonus + events + specialization + mood - 50.0 + tool_bonus + anchor;
            // A disabled company's employees don't work, train or get paid there
            // (nor age: they leave only by moving, and then start working).
            let off = co.disabled;
            let output = if off { 0.0 } else { production / 4.0 * (1.0 + bonus / 100.0).max(0.0) };
            // Current pay already includes Greedy, Modest and past Climber raises.
            let wage = if off { 0.0 } else { paid_wage_at(e, hour, fx.production) };
            let engine = if off { 0.0 } else { fx.engine };
            if off {
                toolboxes = 0.0;
                loot = 0.0;
                training_rate = 0.0;
            }
            self.rows.push(Row {
                member: i,
                tool: active.map(|active| active.source),
                luck,
                learning_luck,
                toolboxes,
                loot,
                training_rate,
                trainings_per_day,
                production,
                responsibility,
                happiness: mood,
                specialization,
                bonus,
                traits: fx.bonus + anchor,
                events,
                tool_bonus,
                trait_production: production - e.production,
                output,
                engine_output: engine,
                wage,
                profit: (output + engine) * co.margin - wage + loot,
            });
            self.profit_terms.push(ProfitTerms {
                engine,
                production: if off { 0.0 } else { production },
                base_bonus: co.bonus + fx.bonus + events,
                happiness: mood,
                tool_bonus,
                anchor_bonus: anchor,
                saved,
                loot,
                specialization_rate: rate,
                wage,
            });
        }
    }
}

// --- The horizon: projectCompany ---

/// Hours at which an employee's trait conditions or wage change.
fn trait_hours(e: &EmployeeRecord, moved: bool, end: f64, mut push: impl FnMut(f64)) {
    let base = if moved { 0.0 } else { e.tenure };
    let mut tenure_days = |days: f64| push((days - base) * 24.0);
    if e.flags & VETERAN != 0 {
        tenure_days(30.0);
    }
    if e.flags & DIAMOND != 0 {
        for d in [10.0, 20.0, 30.0, 40.0] {
            tenure_days(d);
        }
    }
    if e.flags & BURNOUT != 0 {
        for d in [20.0, 40.0, 60.0] {
            tenure_days(d);
        }
    }
    if e.flags & HABIT != 0 {
        push(if moved { 72.0 } else { 72.0 - e.move_age_hours });
    }
    if e.climber_raise != 0.0 {
        let mut k = (e.employed_days / 7.0).floor() + 1.0;
        while (7.0 * k - e.employed_days) * 24.0 < end {
            push((7.0 * k - e.employed_days) * 24.0);
            k += 1.0;
        }
    }
}

/// A training's expected value at this Luck, from its value at each
/// rarity.
fn training_mean(values: &[f64; 5], luck: f64, management: f64) -> f64 {
    let mut n = 0.0;
    for (v, p) in values.iter().zip(rarity_odds(luck, management)) {
        n += v * p;
    }
    n
}

/// The days a projection over `end` hours reports: at least one, and a
/// part day shorter than `EPS` days at the end counts in the day before.
pub fn day_count(end: f64) -> usize {
    (end / 24.0 - EPS).ceil().max(1.0) as usize
}

/// Adds a boundary unless it is already there. Boundaries are finite: the
/// period's end and hours within it.
fn add_hour(hours: &mut Vec<f64>, h: f64) {
    debug_assert!(h.is_finite());
    if !hours.contains(&h) {
        hours.push(h);
    }
}

impl Workspace {
    /// Projects the call over its hours, into `result`.
    fn project(&mut self, view: &View) {
        let call = view.call;
        let co = &call.company;
        let n = call.members.len();
        let end = call.end;
        let span = end / 24.0;
        // The caller checks that `end` is a finite number of hours from 0.
        let day_count = day_count(end);
        let days = day_count as f64;
        // Effects are worked out afresh only where something other than
        // specialization can change; days in between reuse them (profit_on).
        self.boundaries.clear();
        self.boundaries.push(0.0);
        add_hour(&mut self.boundaries, end);
        for i in 0..n {
            let e = view.employee(i);
            let member = &call.members[i];
            let moved = e.company != co.id;
            let boundaries = &mut self.boundaries;
            if let Some(line) = member.line {
                for x in &call.segments[line.indices()] {
                    if x.from > 0.0 {
                        add_hour(boundaries, x.from);
                    }
                    if x.to < end {
                        add_hour(boundaries, x.to);
                    }
                }
            }
            let mut within = |h: f64| {
                if h > 0.0 && h < end {
                    add_hour(boundaries, h)
                }
            };
            if member.line.is_none()
                && let Some(t) = member.tool
            {
                within(t.hours);
            }
            within(working_days(e) * 24.0);
            for event in &e.happiness_events {
                within(event.hours_left);
            }
            for event in &e.production_events {
                within(event.hours_left);
            }
            trait_hours(e, moved, end, &mut within);
            if e.flags & AGE != 0 {
                let mut d = 1.0;
                while d < days {
                    if ((e.age + d) / 10.0).floor() != ((e.age + d - 1.0) / 10.0).floor() {
                        add_hour(boundaries, d * 24.0);
                    }
                    d += 1.0;
                }
            }
        }
        self.boundaries.sort_by(f64::total_cmp);
        // Per member, by their place in the call (the last of a repeated id).
        self.totals_slot.clear();
        for i in 0..n {
            let id = view.employee(i).id;
            self.totals_slot.push((0..n).rev().find(|&j| view.employee(j).id == id).unwrap_or(i));
        }
        self.slot_totals.clear();
        self.slot_totals.resize(n, MemberTotals::NONE);
        self.progress.clear();
        self.progress.resize(n, 0.0);
        self.result.daily.clear();
        self.result.daily.resize(day_count, 0.0);
        self.result.credits.clear();
        // A re-tooled company also keeps what repricing it on another good of
        // its class needs (`Retooling`).
        let switched = co.switched;
        let mut linear = true;
        if switched {
            let retooling = &mut self.result.retooling;
            retooling.days = day_count;
            retooling.base_output.clear();
            retooling.base_output.resize(n * day_count, 0.0);
        }
        // pp: production points made (output + engine) x hours, for price exposure.
        let (mut value, mut pp) = (0.0, 0.0);
        let quota = call.training_quota;
        let management = call.management;
        for b in 0..self.boundaries.len().saturating_sub(1) {
            let (hour_from, hour_to) = (self.boundaries[b], self.boundaries[b + 1]);
            self.instant(view, hour_from);
            let row_count = self.rows.len();
            if quota > 0.0 {
                for r in 0..row_count {
                    let row = self.rows[r];
                    let slot = self.totals_slot[row.member];
                    let e = view.employee(slot);
                    let days_left = working_days(e);
                    let (Some(potential_left), Some(values)) =
                        (e.potential_left.filter(|&left| left > 0.0), &e.training_values)
                    else {
                        continue;
                    };
                    let (from, to) = (hour_from / 24.0, hour_to / 24.0);
                    let before = self.progress[slot];
                    let after = potential_left.min(before + row.training_rate * (to - from));
                    if row.training_rate == quota.min(1.0)
                        && Some(row.learning_luck) == e.training_luck
                        && (before - potential_left.min(from * row.training_rate)).abs() < 1e-9
                    {
                        self.progress[slot] = after;
                        continue;
                    }
                    let mean = training_mean(values, row.learning_luck.max(1.0), management);
                    let base_mean = training_mean(
                        values,
                        e.training_luck.unwrap_or(row.learning_luck),
                        management,
                    );
                    let mut credit = |at: f64, amount: f64| {
                        let benefit = amount * (days_left.min(span) - at).max(0.0) / days_left;
                        if benefit == 0.0 {
                            return;
                        }
                        value += benefit;
                        let day = (days - 1.0).min(at.floor()) as usize;
                        self.result.daily[day] += benefit;
                        self.result.credits.push((slot, day, benefit));
                        let totals = &mut self.slot_totals[slot];
                        totals.value += benefit;
                        totals.training += benefit;
                    };
                    let mut k = (before + 1e-9).floor() + 1.0;
                    while k <= (after + 1e-9).floor() {
                        credit(from + (k - before) / row.training_rate, mean);
                        k += 1.0;
                    }
                    // Numeric Luck drills use the separate future-hand forecast;
                    // this changes only trait and coworker effects. The page
                    // values own potential, so add only the difference from the
                    // observed Luck and one-training-per-day baseline.
                    let base_rate = quota.min(1.0);
                    let mut k = (potential_left.min(from * base_rate) + 1e-9).floor() + 1.0;
                    while k <= (potential_left.min(to * base_rate) + 1e-9).floor() {
                        credit(k / base_rate, -base_mean);
                        k += 1.0;
                    }
                    self.progress[slot] = after;
                }
            }
            let mut h = hour_from;
            let start = (h / 24.0).floor();
            while h < hour_to {
                let day = (h / 24.0).floor();
                let next = hour_to.min((day + 1.0) * 24.0);
                // A part day past the last counts in it (`day_count`).
                let d = (day as usize).min(day_count - 1);
                for r in 0..row_count {
                    let row = &self.rows[r];
                    let terms = &self.profit_terms[r];
                    let slot = self.totals_slot[row.member];
                    let gain =
                        (if day == start { row.profit } else { profit_on(terms, day, co.margin) })
                            * (next - h);
                    pp += (if day == start {
                        row.output + row.engine_output
                    } else {
                        production_points_on(terms, day)
                    }) * (next - h);
                    if switched {
                        self.result.retooling.base_output[slot * day_count + d] +=
                            terms.production / 4.0 * (next - h);
                        if 1.0
                            + (terms.base_bonus + terms.happiness - 50.0
                                + terms.tool_bonus
                                + terms.anchor_bonus)
                                / 100.0
                            < 0.0
                        {
                            linear = false;
                        }
                    }
                    value += gain;
                    self.result.daily[d] += gain;
                    let totals = &mut self.slot_totals[slot];
                    totals.value += gain;
                    if row.happiness < totals.min_happiness {
                        totals.min_happiness = row.happiness;
                    }
                }
                h = next;
            }
        }
        if let Some(values) = co.recruitment.filter(|_| !co.disabled) {
            let recruiter = |i: usize| {
                let e = view.employee(i);
                e.flags & RECRUITER != 0 && working_days(e) > 0.0
            };
            let count = (0..n).filter(|&i| recruiter(i)).count();
            let benefit = values[count.min(3)] - values[0];
            value += benefit;
            self.result.daily[0] += benefit;
            for i in (0..n).filter(|&i| recruiter(i)) {
                self.slot_totals[self.totals_slot[i]].value += benefit / count as f64;
            }
        }
        // A company re-tooled onto another good pays the switch once, at hour 0.
        let cost = co.switch_cost;
        if cost != 0.0 {
            value -= cost;
            self.result.daily[0] -= cost;
        }

        let result = &mut self.result;
        result.value = value;
        result.production_points = pp;
        result.members.clear();
        result.members.extend(self.totals_slot.iter().map(|&s| self.slot_totals[s]));
        result.retooled = switched;
        if switched {
            let retooling = &mut result.retooling;
            retooling.linear = linear;
            retooling.members.clear();
            retooling.members.extend((0..n).map(|i| RetoolMember {
                saved: call.members[i].saved,
                rate: if view.employee(i).flags & QUICK_STUDY != 0 { 2.0 } else { 1.0 },
            }));
        }
    }
}

// --- Entry points ---

/// A member the caller holds: the employee, `specializations[product] || 0`
/// and the tool held from hour 0.
pub struct HeldMember<'a> {
    pub employee: &'a EmployeeRecord,
    pub saved: f64,
    pub tool: Option<Tool>,
}

/// An employee's training figures in an `instant` row.
#[derive(Clone, Copy)]
pub struct TrainingRow {
    pub trainings_per_day: f64,
    pub luck: f64,
}

/// Projections of one company over employees the caller holds (the career's
/// states), with a workspace of its own: no encoding and no copies.
#[derive(Default)]
pub struct DirectProjector {
    call: Call,
    workspace: Workspace,
}

impl DirectProjector {
    /// `management` and `toolbox_value` as `+s.management` and
    /// `+s.toolboxValue`; `current_size` as `currentSize`; training is off.
    pub fn new(
        company: CompanyRecord,
        management: f64,
        toolbox_value: f64,
        current_size: f64,
    ) -> DirectProjector {
        let call = Call {
            training_quota: 0.0,
            management,
            toolbox_value,
            current_size,
            company,
            ..Call::default()
        };
        DirectProjector { call, ..DirectProjector::default() }
    }
    pub fn company(&self) -> &CompanyRecord {
        &self.call.company
    }
    fn load(&mut self, end: f64, members: &[HeldMember]) {
        self.call.end = end;
        self.call.members.clear();
        for (k, m) in members.iter().enumerate() {
            self.call.members.push(Member {
                who: Who::Held(k),
                saved: m.saved,
                tool: m.tool,
                line: None,
            });
        }
        self.workspace.scenes_valid = false;
    }
    /// The company's value over `end` hours.
    pub fn value(&mut self, end: f64, members: &[HeldMember]) -> f64 {
        self.load(end, members);
        let view = View { call: &self.call, snapshot: &[], held: members };
        self.workspace.project(&view);
        self.workspace.result.value
    }
    /// The first `instant` row at hour 0 of the employee with id `id`.
    pub fn row(&mut self, members: &[HeldMember], id: u32) -> Option<TrainingRow> {
        self.load(24.0, members);
        let view = View { call: &self.call, snapshot: &[], held: members };
        self.workspace.instant(&view, 0.0);
        self.workspace
            .rows
            .iter()
            .find(|r| view.employee(r.member).id == id)
            .map(|r| TrainingRow { trainings_per_day: r.trainings_per_day, luck: r.luck })
    }
}

/// Projections of calls the caller builds in `call` (members in a decoded
/// snapshot, `Who::Snapshot`, or held, `Who::Held`, with tool timelines),
/// with a workspace of their own: card pricing and retention (pricing.rs)
/// and the planner.
#[derive(Default)]
pub struct CallProjector {
    pub call: Call,
    workspace: Workspace,
}

impl CallProjector {
    /// The call projected over its hours.
    pub fn run(&mut self, snapshot: &[EmployeeRecord], held: &[HeldMember]) -> &Projected {
        self.workspace.scenes_valid = false;
        let view = View { call: &self.call, snapshot, held };
        self.workspace.project(&view);
        &self.workspace.result
    }
    /// `instant` at `hour` over the call: a row per member working then.
    pub fn rows(&mut self, snapshot: &[EmployeeRecord], held: &[HeldMember], hour: f64) -> &[Row] {
        self.workspace.scenes_valid = false;
        self.workspace.instant(&View { call: &self.call, snapshot, held }, hour);
        &self.workspace.rows
    }
}

/// Own-trait Production that depends on the good: Specialist on its good,
/// Craftsman and Laborer by item type (`goodProduction`).
pub fn good_production_of(e: &EmployeeRecord, product: u32, item_type: u32) -> f64 {
    /// The `x` the hourly rules are handed: only Production is kept. The
    /// three rules run read only the good, its item type and the arg.
    struct ProductionCollector<'a> {
        situation: &'a Situation,
        arg: Option<&'a str>,
        production: f64,
    }
    impl HourlyEffects for ProductionCollector<'_> {
        fn situation(&self) -> &Situation {
            self.situation
        }
        fn held(&self) -> bool {
            true
        }
        fn male_coworkers(&self) -> f64 {
            unreachable!()
        }
        fn happiness_loss(&self) -> f64 {
            unreachable!()
        }
        fn arg(&self) -> Option<&str> {
            self.arg
        }
        fn age(&self) -> f64 {
            unreachable!()
        }
        fn tenure_days(&self) -> f64 {
            unreachable!()
        }
        fn employed_days(&self) -> f64 {
            unreachable!()
        }
        fn own_luck(&self) -> f64 {
            unreachable!()
        }
        fn production(&mut self, d: f64) -> f64 {
            self.production += d;
            0.0
        }
        fn output_percent(&mut self, _: f64) -> f64 {
            0.0
        }
        fn happiness(&mut self, _: f64) -> f64 {
            0.0
        }
        fn responsibility(&mut self, _: f64) -> f64 {
            0.0
        }
        fn luck(&mut self, _: f64) -> f64 {
            0.0
        }
        fn toolboxes(&mut self, _: f64) -> f64 {
            0.0
        }
        fn wage(&mut self, _: f64) -> f64 {
            0.0
        }
        fn raise(&mut self, _: f64) -> f64 {
            0.0
        }
        fn team_happiness(&mut self, _: f64) -> f64 {
            0.0
        }
        fn team_production(&mut self, _: f64) -> f64 {
            0.0
        }
        fn engine(&mut self) -> f64 {
            0.0
        }
        fn quick_study(&mut self) -> f64 {
            0.0
        }
        fn stat(&mut self, _: StatArgument, _: f64) -> f64 {
            0.0
        }
    }
    let situation = Situation {
        product: string(product),
        item_type: string(item_type),
        ..Situation::default()
    };
    let mut x = ProductionCollector { situation: &situation, arg: None, production: 0.0 };
    for t in &e.traits {
        if let Some(id @ (Specialist | Craftsman | Laborer)) = t.id {
            x.arg = t.arg_text.as_deref();
            hourly(id, &mut x);
        }
    }
    x.production
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interning() {
        assert_eq!(intern(""), 1);
        let a = intern("grain");
        assert!(a > 1);
        assert_eq!(intern("grain"), a);
        assert_eq!(string(a).as_deref(), Some("grain"));
        assert_eq!(string(0), None);
    }

    #[test]
    fn part_days() {
        assert_eq!(day_count(0.0), 1);
        assert_eq!(day_count(168.0), 7);
        assert_eq!(day_count(168.0 + 1e-11), 7);
        assert_eq!(day_count(168.5), 8);
    }

    #[test]
    fn boundaries_once() {
        let mut h = vec![0.0];
        add_hour(&mut h, 24.0);
        add_hour(&mut h, 24.0);
        add_hour(&mut h, -0.0);
        assert_eq!(h, vec![0.0, 24.0]);
    }
}
