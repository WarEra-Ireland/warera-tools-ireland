//! The EmployeeCore rules: wage, Luck odds, trait values, card outcomes,
//! card values, pools and training outlooks. A camelCase name at the head
//! of a rule's doc (`cardValue`) is the rule's name in `EmployeeCore` when
//! the facade exposes it.
//!
//! Inputs arrive decoded with their defaults applied (model.rs), so every
//! rule reads the same employee and context. Locals are short: `e` the
//! employee, `ctx` the context, `c` the card.
//!
//! Money unit: points of production at the market value of a point (V);
//! see the header of js/employee-core.js.

use crate::cards::{Stat, numeric_cards};
use crate::cfg::{CFG, Rarity};
use crate::hourly::{HourlyEffects, StatArgument, has_hourly, hourly};
use crate::model::{Card, Code, Context, Energy, Held, Kind, Peer, RulesEmployee, Situation};
use crate::snapshot::Truthy;
use crate::sort::sort_numbers;
use crate::traits::{ArgumentKind, CONFLICTS, Polarity, Priced, Rule, TRAITS, Trait};
use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Deserialize, Serialize, Serializer};
use std::cell::{Cell, RefCell};
use std::convert::Infallible;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

// --- The wage and the working life ---

/// `workingDays`.
pub fn working_days(e: &RulesEmployee) -> f64 {
    e.retire_in_days.unwrap_or(CFG.retire_age - e.age).max(0.0)
}
pub fn hours_left(e: &RulesEmployee) -> f64 {
    working_days(e) * 24.0
}
/// `paidProduction`: the Production the wage is paid on, never below 1.
pub fn paid_production(e: &RulesEmployee) -> f64 {
    (e.production + if crate::cfg::trait_production_paid() { e.trait_production } else { 0.0 })
        .max(1.0)
}
/// Output points per hour before bonuses.
pub fn points_per_hour(e: &RulesEmployee) -> f64 {
    (e.production + e.trait_production + e.extra_production) / CFG.output_divisor
}
/// The paid points per hour.
pub fn paid_points_per_hour(e: &RulesEmployee) -> f64 {
    paid_production(e) / CFG.output_divisor
}
/// Hourly wage, in PP.
pub fn wage_pp(e: &RulesEmployee) -> f64 {
    paid_points_per_hour(e) * e.wage_expectation
}

/// Traits whose Production isn't paid: they compare the employee with coworkers.
fn unpaid_production(t: Trait) -> bool {
    matches!(t, Trait::Rival | Trait::Mentor)
}

/// `careerBonus`: the average bonus over the working days left.
pub fn career_bonus(e: &RulesEmployee, rate: f64) -> f64 {
    let days = working_days(e);
    let mut events = 0.0;
    for event in e.events.iter() {
        let share =
            if days != 0.0 { (event.hours_left.max(0.0) / (days * 24.0)).min(1.0) } else { 0.0 };
        events += event.delta / 100.0 * (share - 1.0);
    }
    let bonus = e.bonus + events;
    let room = (CFG.specialization_max - e.specialization).max(0.0);
    if days == 0.0 || room == 0.0 {
        return bonus;
    }
    let mut extra = 0.0;
    let mut k = 0.0;
    while k < days {
        extra += room.min(k * rate);
        k += 1.0;
    }
    bonus + extra / days / 100.0
}

/// `marginPerPoint`.
pub fn margin_per_point(e: &RulesEmployee, ctx: &Context) -> f64 {
    (1.0 + career_bonus(e, 1.0)) * ctx.sell_ratio - e.wage_expectation
}
/// `hourlyProfit`.
pub fn hourly_profit(e: &RulesEmployee, ctx: &Context) -> f64 {
    points_per_hour(e) * (1.0 + career_bonus(e, 1.0)) * ctx.sell_ratio
        - paid_points_per_hour(e) * e.wage_expectation
}

/// Happiness room below the cap; unknown happiness isn't capped.
fn happiness_room(happiness: Option<f64>) -> f64 {
    happiness.map_or(f64::INFINITY, |h| (CFG.happiness_max - h).max(0.0))
}
/// A gain of happiness, capped by the room left.
pub fn happiness_gain(n: f64, happiness: Option<f64>) -> f64 {
    if n > 0.0 { n.min(happiness_room(happiness)) } else { n }
}

/// `toolboxRate`.
pub fn toolbox_rate(luck: f64) -> f64 {
    (luck.max(0.0) * CFG.toolbox_chance_per_luck).min(CFG.max_toolbox_chance_per_hour)
}

/// Greedy/Modest, folded into the stored wage expectation.
pub fn wage_trait_multiplier(e: &RulesEmployee) -> f64 {
    if e.holds(Trait::Greedy) {
        1.2
    } else if e.holds(Trait::Modest) {
        0.85
    } else {
        1.0
    }
}
/// `canNegotiate`: the game applies Negotiation to the base expectation.
pub fn can_negotiate(e: &RulesEmployee, drop: f64) -> bool {
    let base = e.negotiation_expectation.unwrap_or(e.wage_expectation / wage_trait_multiplier(e));
    (1000.0 * (base - drop)).round() / 1000.0 >= CFG.wage_floor
}

/// Money per hour a card adds; None when not offered.
fn hourly_gain(e: &RulesEmployee, c: &Card, ctx: &Context) -> Option<f64> {
    let sell_ratio = ctx.sell_ratio;
    Some(match c.kind {
        Kind::Negotiation => {
            if !can_negotiate(e, c.drop) {
                return None;
            }
            paid_points_per_hour(e) * c.drop * wage_trait_multiplier(e)
        }
        Kind::Drill => match c.stat {
            Some(Stat::Production) => (c.delta / CFG.output_divisor) * margin_per_point(e, ctx),
            Some(Stat::Responsibility) => {
                let extra = happiness_gain(CFG.responsibility_happiness * c.delta, e.happiness);
                points_per_hour(e) * sell_ratio * extra * 0.01
            }
            Some(Stat::Luck) => {
                (toolbox_rate(e.luck + c.delta) - toolbox_rate(e.luck)) * ctx.toolbox_value
            }
            None => 0.0,
        },
        _ => 0.0,
    })
}

/// `energyOn`: what 10 energy earns elsewhere `day` days from now.
pub fn energy_on(energy: &Energy, day: f64) -> f64 {
    match energy {
        Energy::Number(value) => *value,
        Energy::List(list) => {
            if list.is_empty() {
                return 0.0;
            }
            let i = (day.floor().max(0.0) as usize).min(list.len() - 1);
            list[i]
        }
    }
}

/// `rarityOdds`, in `Rarity::ALL` order.
pub fn rarity_odds(luck: f64, management: f64) -> [f64; 5] {
    let w = &CFG.rarity_weights;
    let mut weights = [w.common, w.uncommon, w.rare, w.epic, w.legendary];
    let by_management = &CFG.management_shift;
    let by_luck = &CFG.luck_shift;
    let shifts = [
        (by_management.uncommon, by_luck.uncommon),
        (by_management.rare, by_luck.rare),
        (by_management.epic, by_luck.epic),
        (by_management.legendary, by_luck.legendary),
    ];
    let mut moved = 0.0;
    for (i, (per_management, per_luck)) in shifts.into_iter().enumerate() {
        let s = per_management * management.max(0.0) + per_luck * luck.max(0.0);
        weights[i + 1] += s;
        moved += s;
    }
    weights[0] = (weights[0] - moved).max(0.0);
    let total = weights.iter().fold(0.0, |a, w| a + w);
    weights.map(|w| w / total)
}

// --- Standing among coworkers ---

/// The situation's nationality fields among a set of coworkers.
#[derive(Clone, Copy)]
pub struct NationalitySituation {
    /// Whether any of them shares the nationality.
    pub same_nationality_coworkers: bool,
    /// How many other nationalities they have.
    pub other_nationalities: f64,
}

impl NationalitySituation {
    fn apply(self, s: &mut Situation) {
        s.same_nationality_coworkers = Some(self.same_nationality_coworkers);
        s.other_nationalities = self.other_nationalities;
    }
}

pub fn nationality_situation<'a>(
    nationality: &str,
    coworkers: impl Iterator<Item = &'a RulesEmployee> + Clone,
) -> NationalitySituation {
    let same = coworkers.clone().filter(|e| e.nationality.as_deref() == Some(nationality)).count();
    let mut others: Vec<&str> = Vec::new();
    for n in coworkers.filter_map(|e| e.nationality.as_deref()) {
        if n != nationality && !others.contains(&n) {
            others.push(n);
        }
    }
    NationalitySituation {
        same_nationality_coworkers: same > 0,
        other_nationalities: others.len() as f64,
    }
}

/// `productionStanding`: whether a coworker is stronger, whether one is
/// weaker, and how many are.
#[derive(Clone, Copy)]
pub struct ProductionStanding {
    pub stronger: bool,
    pub weaker: bool,
    pub weaker_count: f64,
}

pub fn production_standing(own: f64, peers: &[f64]) -> ProductionStanding {
    let weaker = peers.iter().filter(|&&p| p < own).count();
    ProductionStanding {
        stronger: peers.iter().any(|&p| p > own),
        weaker: weaker > 0,
        weaker_count: weaker as f64,
    }
}

/// A row of `peerProduction`: an employee's raw ordinary Production, and
/// whether they hold Rival and Mentor. Decoded from `{ production, rival,
/// mentor }`: the Production must be known (an input error otherwise), the
/// flags are read by truthiness.
#[derive(Clone, Copy, Deserialize)]
#[serde(try_from = "PeerRowInput")]
pub struct PeerRow {
    pub production: f64,
    pub rival: bool,
    pub mentor: bool,
}

#[derive(Deserialize)]
struct PeerRowInput {
    production: Option<f64>,
    #[serde(default)]
    rival: Truthy,
    #[serde(default)]
    mentor: Truthy,
}

impl TryFrom<PeerRowInput> for PeerRow {
    type Error = &'static str;
    fn try_from(input: PeerRowInput) -> Result<PeerRow, &'static str> {
        let production =
            input.production.filter(|p| p.is_finite()).ok_or("A row needs a known production.")?;
        Ok(PeerRow { production, rival: input.rival.0, mentor: input.mentor.0 })
    }
}

impl PeerRow {
    /// An employee's row on `day`, in their situation.
    fn of(e: &RulesEmployee, situation: &Situation, day: f64) -> PeerRow {
        PeerRow {
            production: ordinary_production(e, situation, day),
            rival: e.holds(Trait::Rival),
            mentor: e.holds(Trait::Mentor),
        }
    }
    /// A known coworker's row: from their model, or their Production alone.
    fn of_peer(p: &Peer, day: f64) -> PeerRow {
        match &p.model {
            Some(m) => PeerRow::of(m, &situation_of(p), day),
            None => PeerRow { production: p.production, rival: false, mentor: false },
        }
    }
}

/// `peerProduction`: the comparisons are frozen, then every self and
/// teammate effect applies.
pub fn peer_production(rows: &[PeerRow]) -> Vec<f64> {
    let (mut basis, mut out) = (Vec::new(), Vec::new());
    peer_production_into(rows, &mut basis, &mut out);
    out
}
/// `peer_production` into `out`, with `basis` as scratch (no allocation once
/// they have grown).
pub fn peer_production_into(rows: &[PeerRow], basis: &mut Vec<f64>, out: &mut Vec<f64>) {
    basis.clear();
    basis.extend(rows.iter().map(|r| r.production.max(1.0)));
    out.clear();
    for (i, row) in rows.iter().enumerate() {
        let (mut stronger, mut weaker, mut mentors) = (false, false, 0.0);
        for j in 0..rows.len() {
            if j == i {
                continue;
            }
            if basis[j] > basis[i] {
                stronger = true;
                if rows[j].mentor {
                    mentors += 1.0;
                }
            } else if basis[j] < basis[i] {
                weaker = true;
            }
        }
        let rival =
            if row.rival && rows.len() > 1 { if stronger { 3.0 } else { -1.0 } } else { 0.0 };
        let mentor = if row.mentor && weaker { -1.0 } else { 0.0 };
        out.push((row.production + rival + mentor + 2.0 * mentors).max(1.0));
    }
}

thread_local! {
    static SHARED_DEFAULT_SITUATION: Rc<Situation> = Rc::new(Situation::default());
    static SHARED_DEFAULT_CONTEXT: Rc<Context> = Rc::new(Context::default());
}
/// `DEFAULT_SITUATION`, shared.
pub fn default_situation() -> Rc<Situation> {
    SHARED_DEFAULT_SITUATION.with(Rc::clone)
}
/// `DEFAULT_CONTEXT`, shared.
fn default_context() -> Rc<Context> {
    SHARED_DEFAULT_CONTEXT.with(Rc::clone)
}
fn situation_of(p: &Peer) -> Rc<Situation> {
    p.situation.clone().unwrap_or_else(default_situation)
}
fn is_active(p: &Peer, day: f64) -> bool {
    p.model.as_ref().is_none_or(|m| day < working_days(m))
}

/// The ordinary pass: only Production counts.
struct OrdinaryPass<'a> {
    situation: &'a Situation,
    production: f64,
    arg: Option<Rc<str>>,
    age: f64,
    tenure_days: f64,
    employed_days: f64,
    own_luck: f64,
}
impl HourlyEffects for OrdinaryPass<'_> {
    fn situation(&self) -> &Situation {
        self.situation
    }
    fn held(&self) -> bool {
        true
    }
    fn male_coworkers(&self) -> f64 {
        self.situation.coworkers - self.situation.female_coworkers
    }
    fn happiness_loss(&self) -> f64 {
        0.0
    }
    fn arg(&self) -> Option<&str> {
        self.arg.as_deref()
    }
    fn age(&self) -> f64 {
        self.age
    }
    fn tenure_days(&self) -> f64 {
        self.tenure_days
    }
    fn employed_days(&self) -> f64 {
        self.employed_days
    }
    fn own_luck(&self) -> f64 {
        self.own_luck
    }
    fn production(&mut self, delta: f64) -> f64 {
        self.production += delta;
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
    fn stat(&mut self, stat: StatArgument, delta: f64) -> f64 {
        if stat == StatArgument::Production { self.production(delta) } else { 0.0 }
    }
}

/// Production after the employee's ordinary traits
/// (not Rival or Mentor), unfloored, on day `day`.
pub fn ordinary_production(e: &RulesEmployee, situation: &Situation, day: f64) -> f64 {
    let patched;
    let s = match &situation.peers {
        Some(peers) => {
            let active: Vec<&Peer> = peers.iter().filter(|p| is_active(p, day)).collect();
            let mut with_peers = situation.clone();
            with_peers.coworkers = active.len() as f64;
            if let Some(nationality) = e.nationality.as_ref().or(situation.nationality.as_ref())
                && active.iter().all(|p| p.model.as_ref().is_some_and(|m| m.nationality.is_some()))
            {
                // Every active peer has a model here, so none is skipped.
                let models = active.iter().filter_map(|p| p.model.as_deref());
                nationality_situation(nationality, models).apply(&mut with_peers);
            }
            patched = with_peers;
            &patched
        }
        None => situation,
    };
    let mut x = OrdinaryPass {
        situation: s,
        production: e.production,
        arg: None,
        age: e.age + day,
        tenure_days: s.tenure_days + day + 1e-9,
        employed_days: s.employed_days + day,
        own_luck: e.luck,
    };
    for h in e.traits() {
        let Some(t) = h.code.known() else { continue };
        if unpaid_production(t) {
            continue;
        }
        x.arg = h.arg.clone();
        hourly(t, &mut x);
    }
    x.production
}

/// `comparisonProduction`: what Rival and Mentor compare.
pub fn comparison_production(e: &RulesEmployee, situation: &Situation, day: f64) -> f64 {
    ordinary_production(e, situation, day).max(1.0)
}

// --- Trait values ---

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Note {
    None,
    Unpriced,
    Partial,
}

/// The value of a trait with one of its possible arguments.
pub struct ArgumentOutcome {
    pub arg: Option<Rc<str>>,
    pub probability: f64,
    pub value: f64,
    pub wage_base: f64,
}

/// `traitValue`'s `{ value, outcomes, wageBase, note }`.
pub struct TraitResult {
    pub value: Option<f64>,
    pub outcomes: Vec<ArgumentOutcome>,
    pub wage_base: f64,
    pub note: Note,
}

impl TraitResult {
    fn flat(value: Option<f64>, note: Note) -> TraitResult {
        TraitResult { value, outcomes: Vec::new(), wage_base: 0.0, note }
    }
}

/// A day's patch of the situation from the known coworkers.
#[derive(Clone, Copy)]
struct SituationPatch {
    coworkers: f64,
    nationality: Option<NationalitySituation>,
    standing: ProductionStanding,
}
impl SituationPatch {
    fn apply(&self, s: &mut Situation) {
        s.coworkers = self.coworkers;
        if let Some(nationality) = self.nationality {
            nationality.apply(s);
        }
        s.stronger_coworker = self.standing.stronger;
        s.weaker_coworker = self.standing.weaker;
        s.weaker_count = self.standing.weaker_count;
    }
}
/// A stretch of days with the same ordinary Production and standing.
#[derive(Clone, Copy)]
struct Stretch {
    production_base: f64,
    /// What the known coworkers (`situation.peers`) make of it; None
    /// without them.
    peers: Option<PeerStretch>,
}
/// A stretch as the known coworkers make it.
#[derive(Clone, Copy)]
struct PeerStretch {
    /// The situation they give the day.
    patch: SituationPatch,
    /// The coworkers a team happiness effect reaches.
    happiness_recipients: f64,
    /// Rival's or Mentor's change to the roster's Production, settled with
    /// the day's standing.
    peer_production: Option<f64>,
}

/// The trait-value pass.
struct TraitValuePass<'a> {
    employee: &'a RulesEmployee,
    context: &'a Context,
    situation: Situation,
    held: bool,
    /// The career bonus.
    bonus: f64,
    sell_ratio: f64,
    points_per_hour: f64,
    coworker_base: f64,
    production_base: f64,
    happiness_recipients: f64,
    paid: bool,
    paid_today: f64,
    male_coworkers: f64,
    arg: Option<Rc<str>>,
    age: f64,
    tenure_days: f64,
    employed_days: f64,
}
impl TraitValuePass<'_> {
    fn gain(&self, n: f64, happiness: Option<f64>) -> f64 {
        if self.held { n } else { happiness_gain(n, happiness) }
    }
}
impl HourlyEffects for TraitValuePass<'_> {
    fn situation(&self) -> &Situation {
        &self.situation
    }
    fn held(&self) -> bool {
        self.held
    }
    fn male_coworkers(&self) -> f64 {
        self.male_coworkers
    }
    fn happiness_loss(&self) -> f64 {
        self.employee.happiness_loss
    }
    fn arg(&self) -> Option<&str> {
        self.arg.as_deref()
    }
    fn age(&self) -> f64 {
        self.age
    }
    fn tenure_days(&self) -> f64 {
        self.tenure_days
    }
    fn employed_days(&self) -> f64 {
        self.employed_days
    }
    fn own_luck(&self) -> f64 {
        self.employee.luck
    }
    // Production never drops below 1, so a loss only counts down to it.
    fn production(&mut self, delta: f64) -> f64 {
        let points = ((self.production_base + delta).max(1.0) - self.production_base.max(1.0))
            / CFG.output_divisor;
        if !self.paid {
            return points * (1.0 + self.bonus) * self.sell_ratio;
        }
        self.paid_today += points;
        points * ((1.0 + self.bonus) * self.sell_ratio - self.employee.wage_expectation)
    }
    fn engine(&mut self) -> f64 {
        self.situation.engine_daily_prod / 24.0
            * (1.0 + self.situation.engine_bonus)
            * self.sell_ratio
    }
    fn output_percent(&mut self, percent: f64) -> f64 {
        self.points_per_hour * percent / 100.0 * self.sell_ratio
    }
    fn happiness(&mut self, delta: f64) -> f64 {
        self.points_per_hour * self.sell_ratio * self.gain(delta, self.employee.happiness) / 100.0
    }
    fn responsibility(&mut self, delta: f64) -> f64 {
        self.points_per_hour
            * self.sell_ratio
            * self.gain(CFG.responsibility_happiness * delta, self.employee.happiness)
            / 100.0
    }
    fn luck(&mut self, delta: f64) -> f64 {
        let luck = self.employee.luck;
        (toolbox_rate(luck + delta) - toolbox_rate(luck)) * self.context.toolbox_value
    }
    fn toolboxes(&mut self, rate: f64) -> f64 {
        rate * self.context.toolbox_value
    }
    fn wage(&mut self, factor: f64) -> f64 {
        -paid_points_per_hour(self.employee) * self.employee.wage_expectation * factor
    }
    fn raise(&mut self, raises: f64) -> f64 {
        -paid_points_per_hour(self.employee) * 0.02 * raises * wage_trait_multiplier(self.employee)
    }
    fn team_happiness(&mut self, delta: f64) -> f64 {
        self.happiness_recipients
            * self.coworker_base
            * self.gain(delta, self.situation.coworker_happiness)
            / 100.0
    }
    fn team_production(&mut self, delta: f64) -> f64 {
        let n = if self.situation.peers.is_some() {
            self.situation.weaker_count
        } else if self.situation.weaker_coworker {
            1.0
        } else {
            0.0
        };
        n * delta / CFG.output_divisor * (1.0 + self.bonus) * self.sell_ratio
    }
    fn quick_study(&mut self) -> f64 {
        self.points_per_hour * (career_bonus(self.employee, 2.0) - self.bonus) * self.sell_ratio
    }
    fn stat(&mut self, stat: StatArgument, delta: f64) -> f64 {
        match stat {
            StatArgument::Production => self.production(delta),
            StatArgument::Responsibility => self.responsibility(delta),
            StatArgument::Other => self.luck(delta),
        }
    }
}

const STAT_ARGUMENTS: [&str; 3] = ["production", "responsibility", "luck"];

/// One argument a trait can take, and its chance.
struct ArgumentChance {
    arg: Option<Rc<str>>,
    probability: f64,
}

/// A trait's arguments: known ones stay; Diamond rolls each stat; a gained
/// Specialist takes the company's good, or a match if it is unknown.
fn trait_arguments(
    rule: &Rule,
    arg: Option<Rc<str>>,
    s: &Situation,
    held: bool,
) -> Vec<ArgumentChance> {
    if rule.arg == ArgumentKind::None || arg.is_some() {
        return vec![ArgumentChance { arg, probability: 1.0 }];
    }
    if rule.arg == ArgumentKind::Stat {
        return STAT_ARGUMENTS
            .iter()
            .map(|a| ArgumentChance { arg: Some(Rc::from(*a)), probability: 1.0 / 3.0 })
            .collect();
    }
    let good = if held { None } else { Some(s.product.clone().unwrap_or_else(|| "match".into())) };
    vec![ArgumentChance { arg: good, probability: 1.0 }]
}

/// For each working day, the first day of its stretch.
fn peer_steps(e: &RulesEmployee, situation: &Situation, days: usize) -> Vec<usize> {
    let mut decades = vec![e.age, situation.tenure_days + 1e-9];
    let mut retire = Vec::new();
    for p in situation.peers.iter().flat_map(|p| p.iter()) {
        let Some(m) = &p.model else { continue };
        retire.push(working_days(m));
        decades.push(m.age);
        decades.push(p.situation.as_ref().map_or(0.0, |x| x.tenure_days) + 1e-9);
        for q in p.situation.iter().flat_map(|x| x.peers.iter().flat_map(|q| q.iter())) {
            if let Some(model) = &q.model {
                retire.push(working_days(model));
            }
        }
    }
    let mut steps = vec![0; days];
    let mut start = 0;
    for (d, step) in steps.iter_mut().enumerate() {
        let df = d as f64;
        if d > 0
            && (decades
                .iter()
                .any(|&x| ((x + df) / 10.0).floor() != ((x + df - 1.0) / 10.0).floor())
                || retire.iter().any(|&a| (df < a) != (df - 1.0 < a)))
        {
            start = d;
        }
        *step = start;
    }
    steps
}

/// The stretch of day `day_index`, worked out on the stretch's first day.
fn day_state(
    t: Trait,
    e: &RulesEmployee,
    others: &RulesEmployee,
    situation: &mut Situation,
    day_index: usize,
    steps: &[usize],
    stretches: &mut [Option<Stretch>],
) -> Stretch {
    if let Some(stretch) = stretches[steps[day_index]] {
        return stretch;
    }
    let day = day_index as f64;
    let mut stretch =
        Stretch { production_base: ordinary_production(others, situation, day), peers: None };
    if let Some(peers) = situation.peers.clone() {
        let own = comparison_production(e, situation, day);
        let active: Vec<&Peer> = peers.iter().filter(|p| is_active(p, day)).collect();
        let productions: Vec<f64> = active
            .iter()
            .map(|p| match &p.model {
                Some(m) => comparison_production(m, &situation_of(p), day),
                None => p.production,
            })
            .collect();
        let happiness_recipients = if t == Trait::Comic
            && active.iter().all(|p| p.model.as_ref().is_some_and(|m| m.traits.is_some()))
        {
            (0..active.len())
                .filter(|&r| {
                    !(0..active.len()).any(|o| {
                        o != r && active[o].model.as_ref().is_some_and(|m| m.holds(Trait::Comic))
                    })
                })
                .count() as f64
        } else {
            active.len() as f64
        };
        let mut patch = SituationPatch {
            coworkers: productions.len() as f64,
            nationality: None,
            standing: production_standing(own, &productions),
        };
        if let Some(nationality) = e.nationality.clone().or_else(|| situation.nationality.clone())
            && active.iter().all(|p| p.model.as_ref().is_some_and(|m| m.nationality.is_some()))
        {
            // Every active peer has a model here, so none is skipped.
            let models = active.iter().filter_map(|p| p.model.as_deref());
            patch.nationality = Some(nationality_situation(&nationality, models));
        }
        let mut settled = None;
        if t == Trait::Rival || t == Trait::Mentor {
            // Settled with the day's standing in place, as the hourly pass sees it.
            let saved = situation.clone();
            patch.apply(situation);
            let subject = PeerRow::of(e, situation, day);
            let coworkers: Vec<PeerRow> = active.iter().map(|p| PeerRow::of_peer(p, day)).collect();
            let rows = |on: bool| {
                let own_row = if t == Trait::Rival {
                    PeerRow { rival: on, ..subject }
                } else {
                    PeerRow { mentor: on, ..subject }
                };
                let mut rows = vec![own_row];
                rows.extend_from_slice(&coworkers);
                rows
            };
            let without = peer_production(&rows(false));
            let with = peer_production(&rows(true));
            settled = Some(with.iter().zip(&without).fold(0.0, |v, (p, q)| v + p - q));
            *situation = saved;
        }
        stretch.peers = Some(PeerStretch { patch, happiness_recipients, peer_production: settled });
    }
    stretches[steps[day_index]] = Some(stretch);
    stretch
}

/// `traitValue`: the PP a trait adds over the working life; `held` prices
/// having it now (Rehab is minus that).
pub fn trait_value(
    code: &Code,
    e: &RulesEmployee,
    ctx: &Context,
    arg: Option<Rc<str>>,
    held: bool,
) -> TraitResult {
    let Some(t) = code.known() else {
        return TraitResult::flat(None, Note::None);
    };
    let rule = t.rule();
    if rule.priced == Priced::Unpriced {
        return TraitResult::flat(None, Note::Unpriced);
    }
    if t == Trait::Anchor {
        let loss = if e.happiness.unwrap_or(50.0) < 30.0 {
            -0.5 * points_per_hour(e) * ctx.sell_ratio * hours_left(e)
        } else {
            0.0
        };
        return TraitResult::flat(Some(loss), Note::Partial);
    }
    let mut situation = (*ctx.situation).clone();
    if rule.partner && !situation.coworker_ids.iter().any(|id| Some(&**id) == arg.as_deref()) {
        return TraitResult::flat(Some(0.0), Note::None);
    }
    if let Some(peers) = &situation.peers {
        let own = wage_pp(e);
        situation.better_paid =
            peers.iter().filter(|p| p.wage_pp.is_some_and(|w| w > own + 1e-9)).count() as f64;
    }
    let bonus = career_bonus(e, 1.0);
    let sell_ratio = ctx.sell_ratio;
    // A coworker's output before bonuses, the base their happiness scales.
    let coworker_base = match ctx.coworker_output {
        Some(o) => o / (1.0 + bonus),
        None => points_per_hour(e) * sell_ratio,
    };
    // Day by day over the whole days of the working life: a part day at
    // the end isn't counted.
    let n = working_days(e).floor() as usize;
    let steps = peer_steps(e, &situation, n);
    let others = match &e.traits {
        Some(ts) => e.with_traits(ts.iter().filter(|h| !h.code.is(t)).cloned().collect()),
        None => e.clone(),
    };
    let mut stretches: Vec<Option<Stretch>> = vec![None; n];
    let arguments = trait_arguments(rule, arg, &situation, held);
    let male_coworkers = (situation.coworkers - situation.female_coworkers).max(0.0);
    let happiness_recipients = situation.coworkers;
    let mut x = TraitValuePass {
        employee: e,
        context: ctx,
        situation,
        held,
        bonus,
        sell_ratio,
        points_per_hour: points_per_hour(e),
        coworker_base,
        production_base: e.production,
        happiness_recipients,
        paid: crate::cfg::trait_production_paid() && !unpaid_production(t),
        paid_today: 0.0,
        male_coworkers,
        arg: None,
        age: 0.0,
        tenure_days: 0.0,
        employed_days: 0.0,
    };
    let mut outcomes = Vec::with_capacity(arguments.len());
    for ArgumentChance { arg, probability } in arguments {
        let (mut total, mut wage_base) = (0.0, 0.0);
        x.arg = arg.clone();
        for day_index in 0..n {
            let stretch =
                day_state(t, e, &others, &mut x.situation, day_index, &steps, &mut stretches);
            x.production_base = stretch.production_base;
            if let Some(peers) = stretch.peers {
                x.happiness_recipients = peers.happiness_recipients;
                peers.patch.apply(&mut x.situation);
                if let Some(peer_production) = peers.peer_production {
                    total +=
                        peer_production / CFG.output_divisor * (1.0 + bonus) * sell_ratio * 24.0;
                    continue;
                }
            }
            let day = day_index as f64;
            x.age = e.age + day;
            x.tenure_days = x.situation.tenure_days + day;
            x.employed_days = x.situation.employed_days + day;
            x.paid_today = 0.0;
            total += hourly(t, &mut x) * 24.0;
            wage_base += x.paid_today * 24.0;
        }
        outcomes.push(ArgumentOutcome { arg, probability, value: total, wage_base });
    }
    let value = outcomes.iter().fold(0.0, |a, o| a + o.probability * o.value);
    let wage_base = outcomes.iter().fold(0.0, |a, o| a + o.probability * o.wage_base);
    if outcomes.len() <= 1 {
        outcomes.clear();
    }
    TraitResult { value: Some(value), outcomes, wage_base, note: Note::None }
}

fn is_negative(code: Option<&Code>) -> bool {
    code.and_then(Code::known).is_some_and(|t| t.rule().polarity == Polarity::Negative)
}
/// `conflicts(a, b)`.
fn conflicts(a: &Code, b: Trait) -> bool {
    a.known().is_some_and(|a| CONFLICTS[a as usize].has(b))
}

pub const ALL_POLARITIES: [Polarity; 3] = [Polarity::Positive, Polarity::Mixed, Polarity::Negative];

/// `eligibleTraits`: traits a Habit (positive) or Wild Card (any) could give.
pub fn eligible_traits(held: &[Code], gender: Option<&str>, polarities: &[Polarity]) -> Vec<Trait> {
    TRAITS
        .iter()
        .copied()
        .filter(|&t| {
            let r = t.rule();
            !r.partner
                && polarities.contains(&r.polarity)
                && !held.iter().any(|h| h.is(t))
                && !held.iter().any(|h| conflicts(h, t))
                && r.gender.is_none_or(|g| Some(gender_name(g)) == gender)
        })
        .collect()
}
pub fn gender_name(g: crate::traits::Gender) -> &'static str {
    match g {
        crate::traits::Gender::Male => "male",
        crate::traits::Gender::Female => "female",
    }
}
/// `wildCardRisk`: the share of a Wild Card's traits that are negative.
pub fn wild_card_risk(held: &[Code], gender: Option<&str>) -> Option<f64> {
    let pool = eligible_traits(held, gender, &ALL_POLARITIES);
    if pool.is_empty() {
        return None;
    }
    Some(
        pool.iter().filter(|t| t.rule().polarity == Polarity::Negative).count() as f64
            / pool.len() as f64,
    )
}
fn codes_of(held: &[Held]) -> Vec<Code> {
    held.iter().map(|h| h.code.clone()).collect()
}

// --- Card outcomes ---

/// A trait after a card: one the employee held (by index), or a new one.
#[derive(Clone)]
pub enum OutcomeTrait {
    Held(usize),
    New { trait_id: Trait, arg: Option<Rc<str>> },
}

/// A field a card set (by its name on the facade's employee), and its new
/// value.
pub struct FieldChange {
    pub name: &'static str,
    pub value: f64,
}

/// One resolved outcome of a card: the employee after it, their traits by
/// origin, and the fields it set, in the order the card sets them.
pub struct Outcome {
    pub probability: f64,
    pub arg: Option<Rc<str>>,
    pub next: RulesEmployee,
    pub traits: Option<Vec<OutcomeTrait>>,
    pub set: Vec<FieldChange>,
}

/// The traits a card leaves, before its stat (one roll of its gains).
#[derive(Clone)]
struct TraitRoll {
    probability: f64,
    traits: Vec<OutcomeTrait>,
    arg: Option<Rc<str>>,
}

fn resolve_traits(traits: &[OutcomeTrait], held: &[Held]) -> Vec<Held> {
    traits
        .iter()
        .map(|item| match item {
            OutcomeTrait::Held(i) => held[*i].clone(),
            OutcomeTrait::New { trait_id, arg } => {
                Held { code: Code::Known(*trait_id), arg: arg.clone() }
            }
        })
        .collect()
}
fn outcome_trait_is(item: &OutcomeTrait, held: &[Held], t: Trait) -> bool {
    match item {
        OutcomeTrait::Held(i) => held[*i].code.is(t),
        OutcomeTrait::New { trait_id, .. } => *trait_id == t,
    }
}

/// `cardOutcomes`: each roll applies all of a card's changes together. The
/// wage follows paid Production; wageExpectation (per paid point) stays,
/// but for Greedy, Modest and Negotiation.
pub fn card_outcomes(e: &RulesEmployee, c: &Card, ctx: &Context) -> Vec<Outcome> {
    match c.kind {
        Kind::Reroll => return Vec::new(),
        Kind::SecondWind => {
            let gain = c.gain;
            if !(gain.is_finite() && gain.fract() == 0.0) || gain <= 0.0 {
                return Vec::new();
            }
            if let Some(potential_max) = e.potential_max
                && potential_max + gain > CFG.potential_max_cap
            {
                return Vec::new();
            }
            let mut next = e.clone();
            let left = e.potential_left + gain;
            next.potential_left = left;
            let mut set = vec![FieldChange { name: "potentialLeft", value: left }];
            if let Some(potential_max) = e.potential_max {
                next.potential_max = Some(potential_max + gain);
                set.push(FieldChange { name: "potentialMax", value: potential_max + gain });
            }
            return vec![Outcome { probability: 1.0, arg: None, next, traits: None, set }];
        }
        _ => {}
    }
    let situation = &*ctx.situation;
    let held = e.traits();
    if c.kind == Kind::Rehab && !is_negative(c.code.as_ref()) {
        return Vec::new();
    }
    let gain: Vec<Option<Code>> = match c.kind {
        Kind::Habit => vec![c.code.clone()],
        Kind::HabitPair => c.codes.iter().flat_map(|cs| cs.iter().cloned().map(Some)).collect(),
        Kind::Mentoring => vec![c.to.clone()],
        _ => Vec::new(),
    };
    let remove: Vec<Code> = match c.kind {
        Kind::Rehab | Kind::RemoveTrait | Kind::Mentoring => c.code.iter().cloned().collect(),
        Kind::RehabAll => {
            held.iter().filter(|h| is_negative(Some(&h.code))).map(|h| h.code.clone()).collect()
        }
        _ => Vec::new(),
    };
    let kept = (0..held.len())
        .filter(|&i| !remove.contains(&held[i].code))
        .map(OutcomeTrait::Held)
        .collect();
    let mut rolls = vec![TraitRoll { probability: 1.0, traits: kept, arg: None }];
    let add = |before: Vec<TraitRoll>, code: Option<&Code>| -> Vec<TraitRoll> {
        before
            .into_iter()
            .flat_map(|roll| {
                let Some(t) = code.and_then(Code::known) else {
                    return vec![roll];
                };
                if roll.traits.iter().any(|item| outcome_trait_is(item, held, t)) {
                    return vec![roll];
                }
                trait_arguments(t.rule(), c.arg.clone(), situation, /* held */ false)
                    .into_iter()
                    .map(|ArgumentChance { arg, probability }| {
                        let mut traits = roll.traits.clone();
                        traits.push(OutcomeTrait::New { trait_id: t, arg: arg.clone() });
                        TraitRoll {
                            probability: roll.probability * probability,
                            arg: Some(arg.unwrap_or_else(|| t.code().into())),
                            traits,
                        }
                    })
                    .collect()
            })
            .collect()
    };
    for code in &gain {
        rolls = add(rolls, code.as_ref());
    }
    if c.kind == Kind::WildCard {
        let pool = eligible_traits(&codes_of(held), situation.gender.as_deref(), &ALL_POLARITIES);
        let n = pool.len() as f64;
        rolls = pool
            .iter()
            .flat_map(|&t| {
                add(rolls.clone(), Some(&Code::Known(t)))
                    .into_iter()
                    .map(|roll| TraitRoll { probability: roll.probability / n, ..roll })
                    .collect::<Vec<_>>()
            })
            .collect();
    }
    // The flat Production the employee's ordinary traits give today.
    let own_production = |traits: Vec<Held>| {
        ordinary_production(&e.with_traits(traits), situation, 0.0) - e.production
    };
    let held_production = own_production(held.to_vec());
    let stats: Vec<Option<Stat>> =
        if c.kind == Kind::WildCard { Stat::ALL.map(Some).to_vec() } else { vec![c.stat] };
    let mut outcomes = Vec::new();
    for roll in &rolls {
        let traits = resolve_traits(&roll.traits, held);
        let own = own_production(traits.clone());
        for &stat in &stats {
            let mut next = e.with_traits(traits.clone());
            let mut set = Vec::new();
            let delta = if c.kind == Kind::WildCard {
                CFG.wild_card_stat_gain
            } else if c.kind == Kind::Drill {
                c.delta
            } else {
                0.0
            };
            if delta != 0.0
                && let Some(stat) = stat
            {
                let value = e.stat(stat) + delta;
                next.set_stat(stat, value);
                set.push(FieldChange { name: stat.name(), value });
            }
            let trait_production = e.trait_production + own - held_production;
            next.trait_production = trait_production;
            set.push(FieldChange { name: "traitProduction", value: trait_production });
            let paid_ratio = paid_production(&next) / paid_production(e);
            let mut factor = 1.0;
            for (t, multiplier) in [(Trait::Greedy, 1.2), (Trait::Modest, 0.85)] {
                let had = e.holds(t);
                let has = traits.iter().any(|h| h.code.is(t));
                if !had && has {
                    factor *= multiplier;
                }
                if had && !has {
                    factor /= multiplier;
                }
            }
            let raise_factor = factor * paid_ratio;
            let wage_expectation = e.wage_expectation;
            // Negotiation lowers the expectation, never below 0: one already
            // at 0 has nothing left to lower.
            if c.kind == Kind::Negotiation && wage_expectation > 0.0 {
                factor *= (wage_expectation - c.drop * wage_trait_multiplier(e)).max(0.0)
                    / wage_expectation;
            }
            if let Some(wage) = e.wage {
                let wage = wage * factor * paid_ratio;
                next.wage = Some(wage);
                set.push(FieldChange { name: "wage", value: wage });
            }
            next.wage_expectation = wage_expectation * factor;
            set.push(FieldChange { name: "wageExpectation", value: wage_expectation * factor });
            if c.kind == Kind::Negotiation
                && let Some(negotiation_expectation) = e.negotiation_expectation
            {
                let value = (1000.0 * (negotiation_expectation - c.drop)).round() / 1000.0;
                next.negotiation_expectation = Some(value);
                set.push(FieldChange { name: "negotiationExpectation", value });
            }
            let climbs = traits.iter().any(|h| h.code.is(Trait::Climber));
            let wage_trait = if traits.iter().any(|h| h.code.is(Trait::Greedy)) {
                1.2
            } else if traits.iter().any(|h| h.code.is(Trait::Modest)) {
                0.85
            } else {
                1.0
            };
            let climber_raise = match e.climber_raise {
                _ if !climbs => 0.0,
                Some(raise) => raise * raise_factor,
                None => {
                    paid_production(&next) / 4.0 * ctx.pp_value.unwrap_or(1.0) * 0.02 * wage_trait
                }
            };
            next.climber_raise = Some(climber_raise).filter(|&raise| raise != 0.0);
            set.push(FieldChange { name: "climberRaise", value: climber_raise });
            outcomes.push(Outcome {
                probability: roll.probability / if c.kind == Kind::WildCard { 3.0 } else { 1.0 },
                arg: roll.arg.clone(),
                next,
                traits: Some(roll.traits.clone()),
                set,
            });
        }
    }
    outcomes
}

// --- Card values ---

/// A gained trait's value, kept in the memo.
struct GainedValue {
    trait_id: Trait,
    value: Option<f64>,
}

/// A training's value at one depth, kept in the memo.
struct ValueAtDepth {
    depth: f64,
    value: f64,
}

/// Work shared by the cards of one pool (same employee and context).
/// Everything here is pure, so a handle keeps one for its life.
#[derive(Default)]
pub struct Memo {
    gained_traits: RefCell<Vec<GainedValue>>,
    /// Second Wind's value of a training, by depth.
    second_wind: RefCell<Vec<ValueAtDepth>>,
    luck_pool: RefCell<Option<Rc<Pool>>>,
}

fn gained_trait(code: &Code, e: &RulesEmployee, ctx: &Context, memo: Option<&Memo>) -> Option<f64> {
    let t = code.known();
    if let (Some(m), Some(t)) = (memo, t)
        && let Some(value) =
            m.gained_traits.borrow().iter().find(|x| x.trait_id == t).map(|x| x.value)
    {
        return value;
    }
    let value = trait_value(code, e, ctx, None, /* held */ false).value;
    if let (Some(m), Some(t)) = (memo, t) {
        m.gained_traits.borrow_mut().push(GainedValue { trait_id: t, value });
    }
    value
}

/// `cardValue`: a card's value over the working life; None if not offered.
pub fn card_value(
    e: &RulesEmployee,
    c: &Card,
    ctx: &Context,
    depth: f64,
    memo: &Memo,
) -> Option<f64> {
    match c.kind {
        Kind::Reroll => {
            return Some(model_only(training_outlook(e, ctx, &Price::Model, depth, memo)).value);
        }
        Kind::SecondWind => {
            return Some(model_only(second_wind_value(e, c.gain, ctx, depth, &Price::Model, memo)));
        }
        _ => {}
    }
    let mut value = match trait_card_value(e, c, ctx, Some(memo)) {
        None => hourly_gain(e, c, ctx).map(|h| h * hours_left(e)),
        Some(v) => v,
    }?;
    if c.kind == Kind::Drill && c.stat == Some(Stat::Luck) {
        value += future_luck_value(e, c.delta, ctx, memo);
    }
    Some(match after_card(e, c) {
        Some(next) => value + peer_shift(e, &next, ctx),
        None => value,
    })
}

const PEER_TRAITS: [Trait; 4] = [Trait::Rival, Trait::Mentor, Trait::PrimaDonna, Trait::Envious];
fn is_peer_trait(code: &Code) -> bool {
    code.known().is_some_and(|t| PEER_TRAITS.contains(&t))
}
/// An unpriced value (None) counts as 0 in a sum.
fn null_as_zero(value: Option<f64>) -> f64 {
    value.unwrap_or(0.0)
}

/// The employee after a card, if it changes Production, the
/// wage or the traits.
fn after_card(e: &RulesEmployee, c: &Card) -> Option<RulesEmployee> {
    if c.kind == Kind::WildCard {
        return None;
    }
    let outcome = card_outcomes(e, c, &default_context()).into_iter().next()?;
    let same_traits = match (&outcome.traits, &e.traits) {
        (None, _) => true,
        (Some(traits), Some(held)) => {
            traits.len() == held.len()
                && traits
                    .iter()
                    .enumerate()
                    .all(|(i, item)| matches!(item, OutcomeTrait::Held(j) if *j == i))
        }
        (Some(_), None) => false,
    };
    if outcome.next.production == e.production
        && outcome.next.wage_expectation == e.wage_expectation
        && same_traits
    {
        return None;
    }
    Some(outcome.next)
}

/// What going from `e` to `after` does to the standing traits,
/// the employee's own and each coworker's.
fn peer_shift(e: &RulesEmployee, after: &RulesEmployee, ctx: &Context) -> f64 {
    let mut total = 0.0;
    for t in after.traits().iter().filter(|t| is_peer_trait(&t.code)) {
        total +=
            null_as_zero(trait_value(&t.code, after, ctx, t.arg.clone(), /* held */ true).value)
                - null_as_zero(trait_value(&t.code, e, ctx, t.arg.clone(), /* held */ true).value);
    }
    let Some(models) = &ctx.situation.coworker_models else {
        return total;
    };
    let me = Peer {
        production: comparison_production(after, &ctx.situation, 0.0),
        wage_pp: Some(wage_pp(after)),
        model: Some(Rc::new(after.clone())),
        situation: Some(ctx.situation.clone()),
        is_self: true,
    };
    for coworker in models.iter() {
        let theirs: Vec<&Held> =
            coworker.employee.traits().iter().filter(|t| is_peer_trait(&t.code)).collect();
        if theirs.is_empty() {
            continue;
        }
        let mut moved_situation = (*coworker.context.situation).clone();
        moved_situation.peers = Some(
            coworker
                .context
                .situation
                .peers
                .iter()
                .flat_map(|p| p.iter())
                .map(|p| if p.is_self { me.clone() } else { p.clone() })
                .collect(),
        );
        let moved = Context { situation: Rc::new(moved_situation), ..(*coworker.context).clone() };
        for t in theirs {
            total += null_as_zero(
                trait_value(
                    &t.code,
                    &coworker.employee,
                    &moved,
                    t.arg.clone(),
                    /* held */ true,
                )
                .value,
            ) - null_as_zero(
                trait_value(
                    &t.code,
                    &coworker.employee,
                    &coworker.context,
                    t.arg.clone(),
                    /* held */ true,
                )
                .value,
            );
        }
    }
    total
}

/// `secondWindValue`: each extra training is priced like any training, made
/// that many days later, net of what its energy earns elsewhere. With a
/// `price` callback, the training is priced by it (and not kept in the
/// memo).
pub fn second_wind_value<E>(
    e: &RulesEmployee,
    gain: f64,
    ctx: &Context,
    depth: f64,
    price: &Price<E>,
    memo: &Memo,
) -> Result<f64, E> {
    price_with(price, |quote| second_wind_quoted(e, gain, ctx, depth, quote, memo))
}
fn second_wind_quoted(
    e: &RulesEmployee,
    gain: f64,
    ctx: &Context,
    depth: f64,
    price: &Quote,
    memo: &Memo,
) -> Result<f64, Stopped> {
    if depth <= 0.0 {
        return Ok(0.0);
    }
    let days = working_days(e);
    if days == 0.0 {
        return Ok(0.0);
    }
    let known = if price.is_given() {
        None
    } else {
        memo.second_wind.borrow().iter().find(|x| x.depth == depth).map(|x| x.value)
    };
    let per_training = match known {
        Some(v) => v,
        None => {
            let v = outlook_quoted(e, ctx, price, depth - 1.0, memo)?.value;
            if !price.is_given() {
                memo.second_wind.borrow_mut().push(ValueAtDepth { depth, value: v });
            }
            v
        }
    };
    let mut total = 0.0;
    let mut j = 1.0;
    while j <= gain {
        let until = (e.potential_left + j) / e.trainings_per_day;
        total += (per_training * (days - until).max(0.0) / days - energy_on(&ctx.energy, until))
            .max(0.0);
        j += 1.0;
    }
    Ok(total)
}

/// `futureLuckValue`: extra Luck changes the rarity of the remaining draws.
pub fn future_luck_value(e: &RulesEmployee, delta: f64, ctx: &Context, memo: &Memo) -> f64 {
    if !ctx.future_training || delta == 0.0 {
        return 0.0;
    }
    let days = working_days(e);
    let count = e.potential_left.max(0.0);
    if days <= 0.0 || count == 0.0 {
        return 0.0;
    }
    let known = memo.luck_pool.borrow().clone();
    let pool = match known {
        Some(p) => p,
        None => {
            // Trait values don't depend on futureTraining, so the memo's carry over.
            let no_future = Context { future_training: false, ..ctx.clone() };
            let mut pool = model_only(card_pool(e, &no_future, &Price::Model, 0.0, memo));
            pool.0[1].retain(|c| c.card.kind != Kind::Reroll);
            let pool = Rc::new(pool);
            *memo.luck_pool.borrow_mut() = Some(pool.clone());
            pool
        }
    };
    let management = ctx.management;
    let luck = e.luck;
    let gain =
        reroll_value(&pool, luck + delta, management) - reroll_value(&pool, luck, management);
    let mut total = 0.0;
    let mut k = 1.0;
    while k <= count {
        total += gain * (days - k / e.trainings_per_day).max(0.0) / days;
        k += 1.0;
    }
    total
}

/// A trait card's value; None for a card that isn't one.
fn trait_card_value(
    e: &RulesEmployee,
    c: &Card,
    ctx: &Context,
    memo: Option<&Memo>,
) -> Option<Option<f64>> {
    let held = e.traits();
    let gained = |code: &Code| gained_trait(code, e, ctx, memo);
    let having = |code: &Code| {
        let arg = held.iter().find(|h| h.code == *code).and_then(|h| h.arg.clone());
        trait_value(code, e, ctx, arg, /* held */ true).value
    };
    Some(match c.kind {
        Kind::Habit => c.code.as_ref().and_then(gained),
        Kind::Rehab | Kind::RemoveTrait => {
            let Some(code) = &c.code else {
                return Some(None);
            };
            if c.kind == Kind::Rehab && !is_negative(Some(code)) {
                return Some(None);
            }
            having(code).map(|x| -x)
        }
        Kind::Mentoring => {
            // One held trait moved up its ladder: the next step, valued
            // without the trait it replaces, less the held trait.
            let (Some(code), Some(to)) = (&c.code, &c.to) else {
                return Some(None);
            };
            let from = having(code);
            let to = trait_value(
                to,
                &e.with_traits(held.iter().filter(|h| h.code != *code).cloned().collect()),
                ctx,
                None,
                false,
            )
            .value;
            match (from, to) {
                (Some(f), Some(t)) => Some(t - f),
                _ => None,
            }
        }
        Kind::HabitPair => {
            let values: Vec<Option<f64>> =
                c.codes.iter().flat_map(|cs| cs.iter()).map(gained).collect();
            match values[..] {
                [Some(a), Some(b)] => Some(a + b),
                _ => None,
            }
        }
        Kind::RehabAll => {
            Some(held.iter().filter(|h| is_negative(Some(&h.code))).fold(0.0, |a, h| {
                a - trait_value(&h.code, e, ctx, h.arg.clone(), /* held */ true)
                    .value
                    .unwrap_or(0.0)
            }))
        }
        Kind::WildCard => {
            // A random eligible trait, good or bad (unpriced ones count as 0),
            // and +2 to a random stat.
            let pool =
                eligible_traits(&codes_of(held), ctx.situation.gender.as_deref(), &ALL_POLARITIES);
            let traits = pool.iter().fold(0.0, |a, &t| a + gained(&Code::Known(t)).unwrap_or(0.0))
                / if pool.is_empty() { 1.0 } else { pool.len() as f64 };
            let fresh = Memo::default();
            let stats = Stat::ALL.iter().fold(0.0, |a, &stat| {
                a + null_as_zero(card_value(
                    e,
                    &Card::drill(stat, CFG.wild_card_stat_gain),
                    ctx,
                    1.0,
                    memo.unwrap_or(&fresh),
                ))
            }) / 3.0;
            Some(traits + stats)
        }
        _ => return None,
    })
}

/// A Wild Card outcome: a trait and a stat, priced apart.
pub struct WildCardOutcome {
    pub probability: f64,
    pub value: f64,
    pub trait_id: Trait,
    /// The trait can't be priced (its value counts as 0).
    pub unpriced: bool,
}

/// `wildCardOutcomes`.
pub fn wild_card_outcomes(e: &RulesEmployee, ctx: &Context, memo: &Memo) -> Vec<WildCardOutcome> {
    let pool =
        eligible_traits(&codes_of(e.traits()), ctx.situation.gender.as_deref(), &ALL_POLARITIES);
    let stats: Vec<f64> = Stat::ALL
        .iter()
        .map(|&stat| {
            null_as_zero(card_value(e, &Card::drill(stat, CFG.wild_card_stat_gain), ctx, 1.0, memo))
        })
        .collect();
    let n = pool.len() as f64;
    pool.iter()
        .flat_map(|&t| {
            let value = trait_value(&Code::Known(t), e, ctx, None, /* held */ false).value;
            stats
                .iter()
                .map(move |&stat_value| WildCardOutcome {
                    probability: 1.0 / (3.0 * n),
                    value: value.unwrap_or(0.0) + stat_value,
                    trait_id: t,
                    unpriced: value.is_none(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

// --- Pools and outlooks ---

/// A card's price: the model's own, or one given: `price(card)`, a number,
/// None to leave the card out, or why it failed (`E`). The JS callback
/// (`js_quote`) and the module's own prices (the career's pool, card
/// pricing's Reroll) are given ones.
pub enum Price<'a, E> {
    Model,
    Given(&'a dyn Fn(&Card) -> Result<Option<f64>, E>),
}

// `Function.prototype.call`. The Rust names here also name the glue's
// import shims, so renaming them changes js/wasm/employee_model.js.
#[wasm_bindgen]
extern "C" {
    /// A JS function.
    #[wasm_bindgen(js_name = Function)]
    pub type JsFn;
    #[wasm_bindgen(method, catch, js_name = call)]
    fn call1(this: &JsFn, this_arg: &JsValue, a: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = call)]
    fn call3(
        this: &JsFn,
        this_arg: &JsValue,
        a: &JsValue,
        b: &JsValue,
        c: &JsValue,
    ) -> Result<JsValue, JsValue>;
}

/// A JS value as JS arithmetic reads it (`null` -> 0, `undefined` -> NaN).
pub fn js_number(v: &JsValue) -> f64 {
    if let Some(x) = v.as_f64() {
        x
    } else if v.is_null() {
        0.0
    } else if let Some(b) = v.as_bool() {
        if b { 1.0 } else { 0.0 }
    } else {
        f64::NAN
    }
}
/// `f(a, b, c)` for a JS function, read as a number.
pub fn call_js_function(f: &JsValue, a: f64, b: f64, c: &str) -> Result<f64, JsValue> {
    let r = f.unchecked_ref::<JsFn>().call3(
        &JsValue::UNDEFINED,
        &a.into(),
        &b.into(),
        &JsValue::from_str(c),
    )?;
    Ok(js_number(&r))
}

/// The JS `price` callback's price of `c`: a number, or None for null (or
/// anything else); what it throws is the failure.
pub fn js_quote(price: &JsValue, c: &Card) -> Result<Option<f64>, JsValue> {
    let r = price.unchecked_ref::<JsFn>().call1(&JsValue::UNDEFINED, &crate::io::to_js(c)?)?;
    Ok(r.as_f64())
}

/// A price as the priced rules' bodies take it, whatever its failure: a
/// given price that fails stops the body (`Stopped`), and `price_with`
/// returns why. So each body is one function, not a copy per failure type
/// (~4 KB each).
enum Quote<'a> {
    Model,
    Given(&'a dyn Fn(&Card) -> Result<Option<f64>, Stopped>),
}
/// A given price failed: `price_with` holds why.
struct Stopped;

impl Quote<'_> {
    /// Whether a price is given.
    fn is_given(&self) -> bool {
        matches!(self, Quote::Given(_))
    }
    /// The given price of `c`; None from the model's own.
    fn quote(&self, c: &Card) -> Result<Option<f64>, Stopped> {
        match self {
            Quote::Model => Ok(None),
            Quote::Given(f) => f(c),
        }
    }
}

/// `body` priced by `price`: what it returns, or the given price's failure
/// that stopped it.
fn price_with<E, T>(
    price: &Price<E>,
    body: impl FnOnce(&Quote) -> Result<T, Stopped>,
) -> Result<T, E> {
    let failure = Cell::new(None);
    let given;
    let quote = match price {
        Price::Model => Quote::Model,
        Price::Given(f) => {
            given = |c: &Card| {
                f(c).map_err(|why| {
                    failure.set(Some(why));
                    Stopped
                })
            };
            Quote::Given(&given)
        }
    };
    body(&quote).map_err(|Stopped| failure.take().expect("a given price stops only when it fails"))
}
/// What a price that can't fail gives: the model's own, or a given one
/// that never fails.
pub fn model_only<T>(r: Result<T, Infallible>) -> T {
    let Ok(v) = r;
    v
}

#[derive(Clone, PartialEq)]
pub struct PoolCard {
    pub card: Card,
    pub value: f64,
}
impl Serialize for PoolCard {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        self.card.entries(&mut map)?;
        map.serialize_entry("value", &self.value)?;
        map.end()
    }
}
/// The card pool by rarity, in `Rarity::ALL` order.
#[derive(Clone, Default, PartialEq)]
pub struct Pool(pub [Vec<PoolCard>; 5]);
impl Serialize for Pool {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(5))?;
        for (rarity, cards) in Rarity::ALL.iter().zip(&self.0) {
            map.serialize_entry(rarity.code(), cards)?;
        }
        map.end()
    }
}
impl Pool {
    fn values(&self, rarity_index: usize) -> Vec<f64> {
        self.0[rarity_index].iter().map(|c| c.value).collect()
    }
}

/// `cardPool`: every card a training could deal this employee now, priced.
pub fn card_pool<E>(
    e: &RulesEmployee,
    ctx: &Context,
    price: &Price<E>,
    depth: f64,
    memo: &Memo,
) -> Result<Pool, E> {
    price_with(price, |quote| pool_quoted(e, ctx, quote, depth, memo))
}
fn pool_quoted(
    e: &RulesEmployee,
    ctx: &Context,
    price: &Quote,
    depth: f64,
    memo: &Memo,
) -> Result<Pool, Stopped> {
    let held = e.traits();
    let codes = codes_of(held);
    let value = |c: &Card| -> Result<f64, Stopped> {
        Ok(null_as_zero(if price.is_given() {
            price.quote(c)?
        } else {
            card_value(e, c, ctx, depth, memo)
        }))
    };
    // Each gained trait's value, priced once.
    let mut trait_values: Vec<(Trait, f64)> = Vec::new();
    let mut gained_value = |t: Trait| -> Result<f64, Stopped> {
        if let Some(&(_, v)) = trait_values.iter().find(|&&(known, _)| known == t) {
            return Ok(v);
        }
        let code = Code::Known(t);
        let v = null_as_zero(if price.is_given() {
            price.quote(&Card::with_code(Kind::Habit, code))?
        } else {
            gained_trait(&code, e, ctx, Some(memo))
        });
        trait_values.push((t, v));
        Ok(v)
    };
    let mut pool = Pool::default();
    for (rarity_index, &rarity) in Rarity::ALL.iter().enumerate() {
        for c in numeric_cards(rarity) {
            let card = Card::from(c);
            if card.kind == Kind::SecondWind
                && let Some(potential_max) = e.potential_max
                && potential_max + card.gain > CFG.potential_max_cap
            {
                continue;
            }
            let v = if price.is_given() {
                price.quote(&card)?
            } else {
                card_value(e, &card, ctx, depth, memo)
            };
            if let Some(v) = v {
                pool.0[rarity_index].push(PoolCard { card, value: v });
            }
        }
    }
    // By rarity index: 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary.
    let negatives: Vec<&Held> = held.iter().filter(|h| is_negative(Some(&h.code))).collect();
    for h in &negatives {
        let card = Card::with_code(Kind::Rehab, h.code.clone());
        let v = value(&card)?;
        pool.0[2].push(PoolCard { card, value: v });
    }
    if negatives.len() >= 2 {
        let card = Card::new(Kind::RehabAll);
        let v = value(&card)?;
        pool.0[4].push(PoolCard { card, value: v });
    }
    let positives = eligible_traits(&codes, ctx.situation.gender.as_deref(), &[Polarity::Positive]);
    for &t in &positives {
        let v = gained_value(t)?;
        pool.0[3].push(PoolCard { card: Card::with_code(Kind::Habit, Code::Known(t)), value: v });
    }
    for i in 0..positives.len() {
        for j in i + 1..positives.len() {
            let (a, b) = (positives[i], positives[j]);
            if CONFLICTS[a as usize].has(b) {
                continue;
            }
            let card = Card {
                codes: Some(Rc::from([Code::Known(a), Code::Known(b)])),
                ..Card::new(Kind::HabitPair)
            };
            let v = match price.quote(&card)? {
                Some(v) if price.is_given() => v,
                _ => gained_value(a)? + gained_value(b)?,
            };
            pool.0[4].push(PoolCard { card, value: v });
        }
    }
    if !eligible_traits(&codes, ctx.situation.gender.as_deref(), &ALL_POLARITIES).is_empty() {
        let card = Card::new(Kind::WildCard);
        let v = value(&card)?;
        pool.0[2].push(PoolCard { card, value: v });
    }
    let reroll = reroll_value(&pool, e.luck, ctx.management);
    pool.0[1].push(PoolCard { card: Card::new(Kind::Reroll), value: reroll });
    Ok(pool)
}

/// `choose(n, k)`: the binomial coefficient.
fn choose(n: f64, k: f64) -> f64 {
    let mut v = 1.0;
    let mut i = 0.0;
    while i < k {
        v *= (n - i) / (i + 1.0);
        i += 1.0;
    }
    v
}

/// Reroll's value: on each interval between Uncommon card values,
/// E[new hand] = a + bR; hands holding Reroll take max(R, best of the rest).
pub fn reroll_value(pool: &Pool, luck: f64, management: f64) -> f64 {
    let odds = rarity_odds(luck, management);
    let k = CFG.hand_size;
    let open: Vec<usize> =
        (0..5).filter(|&r| (pool.0[r].len() + usize::from(r == 1)) as f64 >= k).collect();
    let norm = open.iter().fold(0.0, |s, &r| s + odds[r]);
    if norm == 0.0 {
        return 0.0;
    }
    let p = if open.contains(&1) { odds[1] / norm } else { 0.0 };
    let mut vals = pool.values(1);
    sort_numbers(&mut vals);
    let n = (vals.len() + 1) as f64;
    let mut a = open
        .iter()
        .filter(|&&r| r != 1)
        .fold(0.0, |s, &r| s + odds[r] / norm * expected_max(&pool.values(r), k))
        + p * (n - k) / n * expected_max(&vals, k);
    let skip = (k - 2.0) as usize;
    // (value, chance it is the best of the rest of a hand holding Reroll).
    let maxima: Vec<(f64, f64)> = vals
        .get(skip..)
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(j, &value)| (value, p * choose(j as f64 + k - 2.0, k - 2.0) / choose(n, k)))
        .collect();
    a += maxima.iter().fold(0.0, |s, &(value, chance)| s + chance * value);
    let mut b = 0.0;
    for &(value, chance) in &maxima {
        let v = a / (1.0 - b);
        if v <= value {
            return v;
        }
        a -= chance * value;
        b += chance;
    }
    // Every hand holds Reroll (Uncommon alone, 3 cards): rerolling gains
    // nothing, and the hand is worth its best card.
    match maxima.last() {
        Some(&(best, _)) if b >= 1.0 - 1e-12 => best,
        _ => a / (1.0 - b),
    }
}

/// The expected best of k cards dealt from vals.
pub fn expected_max(vals: &[f64], k: f64) -> f64 {
    let mut v = vals.to_vec();
    sort_numbers(&mut v);
    let n = v.len() as f64;
    if v.is_empty() {
        return 0.0;
    }
    if n <= k {
        return v[v.len() - 1];
    }
    let mut w = 1.0;
    let mut i = 0.0;
    while i < k {
        w *= (k - i) / (n - i);
        i += 1.0;
    }
    let mut total = 0.0;
    let mut i = k - 1.0;
    while i < n {
        total += w * v[i as usize];
        w *= (i + 1.0) / (i + 2.0 - k);
        i += 1.0;
    }
    total
}

/// One rarity of `trainingOutlook`: its chance, its pool's size and the
/// expected best of a hand of it.
pub struct RarityOutlook {
    pub rarity: Rarity,
    pub probability: f64,
    pub cards: usize,
    pub value: f64,
}
pub struct Outlook {
    pub value: f64,
    pub rarities: Vec<RarityOutlook>,
}
impl Serialize for RarityOutlook {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_struct("RarityOutlook", 4)?;
        m.serialize_field("rarity", self.rarity.code())?;
        m.serialize_field("p", &self.probability)?;
        m.serialize_field("cards", &self.cards)?;
        m.serialize_field("value", &self.value)?;
        m.end()
    }
}
impl Serialize for Outlook {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_struct("Outlook", 2)?;
        m.serialize_field("value", &self.value)?;
        m.serialize_field("rarities", &self.rarities)?;
        m.end()
    }
}

/// `trainingOutlook`: the rarity roll (among rarities with a full hand),
/// then the best of the hand dealt.
pub fn training_outlook<E>(
    e: &RulesEmployee,
    ctx: &Context,
    price: &Price<E>,
    depth: f64,
    memo: &Memo,
) -> Result<Outlook, E> {
    price_with(price, |quote| outlook_quoted(e, ctx, quote, depth, memo))
}
fn outlook_quoted(
    e: &RulesEmployee,
    ctx: &Context,
    price: &Quote,
    depth: f64,
    memo: &Memo,
) -> Result<Outlook, Stopped> {
    let pool = pool_quoted(e, ctx, price, depth, memo)?;
    let odds = rarity_odds(e.luck, ctx.management);
    let open: Vec<usize> = (0..5).filter(|&r| pool.0[r].len() as f64 >= CFG.hand_size).collect();
    // The odds of the rarities with a hand to deal; 1 when none has (no rows).
    let open_odds = open.iter().fold(0.0, |a, &r| a + odds[r]);
    let norm = if open_odds == 0.0 { 1.0 } else { open_odds };
    let rarities: Vec<RarityOutlook> = open
        .iter()
        .map(|&r| RarityOutlook {
            rarity: Rarity::ALL[r],
            probability: odds[r] / norm,
            cards: pool.0[r].len(),
            value: expected_max(&pool.values(r), CFG.hand_size),
        })
        .collect();
    Ok(Outlook { value: rarities.iter().fold(0.0, |a, x| a + x.probability * x.value), rarities })
}

fn expected_best_of_hand(vals: &[f64], k: usize) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    if vals.len() <= k {
        return vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    }
    fn pick(
        vals: &[f64],
        k: usize,
        start: usize,
        chosen: &mut Vec<f64>,
        sum: &mut f64,
        n: &mut f64,
    ) {
        if chosen.len() == k {
            *sum += chosen.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            *n += 1.0;
            return;
        }
        for i in start..vals.len() {
            chosen.push(vals[i]);
            pick(vals, k, i + 1, chosen, sum, n);
            chosen.pop();
        }
    }
    let (mut sum, mut n) = (0.0, 0.0);
    pick(vals, k, 0, &mut Vec::with_capacity(k), &mut sum, &mut n);
    sum / n
}

/// `expectedTrainingValue`: a rarity roll, then the best of a random hand of
/// that rarity's numeric cards (exact over all hands).
pub fn expected_training_value<E>(
    e: &RulesEmployee,
    ctx: &Context,
    depth: f64,
    price: &Price<E>,
    memo: &Memo,
) -> Result<f64, E> {
    price_with(price, |quote| expected_training_quoted(e, ctx, depth, quote, memo))
}
fn expected_training_quoted(
    e: &RulesEmployee,
    ctx: &Context,
    depth: f64,
    price: &Quote,
    memo: &Memo,
) -> Result<f64, Stopped> {
    let odds = rarity_odds(e.luck, ctx.management);
    let mut total = 0.0;
    for (rarity_index, &rarity) in Rarity::ALL.iter().enumerate() {
        let mut vals = Vec::new();
        for c in numeric_cards(rarity) {
            let card = Card::from(c);
            let v = if price.is_given() {
                price.quote(&card)?
            } else {
                card_value(e, &card, ctx, depth, memo)
            };
            if let Some(v) = v {
                vals.push(v);
            }
        }
        total += odds[rarity_index] * expected_best_of_hand(&vals, CFG.hand_size as usize);
    }
    Ok(total)
}

// --- Hiring and the potential ---

/// A trait that can roll at hire: its chance, value and wage base.
pub struct RolledTrait {
    pub trait_id: Trait,
    pub probability: f64,
    pub value: f64,
    pub wage_base: f64,
}

/// Each trait that can roll for this gender.
pub fn rolled_traits(e: &RulesEmployee, ctx: &Context, gender: &str) -> Vec<RolledTrait> {
    let held = codes_of(e.traits());
    let rollable: Vec<Trait> = TRAITS
        .iter()
        .copied()
        .filter(|&t| {
            let r = t.rule();
            r.weight > 0
                && r.gender.is_none_or(|g| gender_name(g) == gender)
                && !held.iter().any(|h| h.is(t))
                && !held.iter().any(|h| conflicts(h, t))
        })
        .collect();
    let gendered_context = ctx.with_gender(gender);
    let weights = rollable.iter().fold(0.0, |a, t| a + f64::from(t.rule().weight));
    rollable
        .into_iter()
        .map(|t| {
            let result = if t.rule().partner {
                None
            } else {
                Some(trait_value(
                    &Code::Known(t),
                    e,
                    &gendered_context,
                    None,
                    /* held */ false,
                ))
            };
            RolledTrait {
                trait_id: t,
                probability: f64::from(t.rule().weight) / weights,
                value: result.as_ref().and_then(|r| r.value).unwrap_or(0.0),
                wage_base: result.map_or(0.0, |r| r.wage_base),
            }
        })
        .collect()
}
/// `rolledTraitValue`: the average value of one trait rolled at hire.
pub fn rolled_trait_value(e: &RulesEmployee, ctx: &Context, genders: &[String]) -> f64 {
    let n = genders.len() as f64;
    genders.iter().fold(0.0, |a, g| {
        a + rolled_traits(e, ctx, g).iter().fold(0.0, |b, t| b + t.probability * t.value) / n
    })
}
/// The paid flat Production a trait gained at hire gives
/// on day one (0 unless CFG.traitProductionPaid).
pub fn hire_production(t: Trait, age: f64, situation: &Situation) -> f64 {
    if !crate::cfg::trait_production_paid()
        || !has_hourly(t)
        || t.rule().partner
        || unpaid_production(t)
    {
        return 0.0;
    }
    let arg = trait_arguments(t.rule(), None, situation, /* held */ false).swap_remove(0).arg;
    let e = RulesEmployee {
        age,
        production: 0.0,
        traits: Some(Rc::from([Held { code: Code::Known(t), arg }])),
        nationality: situation.nationality.clone(),
        ..RulesEmployee::default()
    };
    ordinary_production(&e, situation, 0.0)
}

/// `potentialValue`: the trainings a potential holds, net of what the same
/// energy earns elsewhere (`alternative`).
pub fn potential_value(
    e: &RulesEmployee,
    ctx: &Context,
    potential: f64,
    alternative: f64,
    training_value: Option<f64>,
    memo: &Memo,
) -> f64 {
    let days = working_days(e);
    if days == 0.0 || potential == 0.0 {
        return 0.0;
    }
    let per_training = match training_value {
        Some(v) => v,
        None => model_only(training_outlook(e, ctx, &Price::Model, 1.0, memo)).value,
    };
    let mut total = 0.0;
    let mut k = 0.0;
    while k < potential {
        total += (per_training * (days - k / e.trainings_per_day).max(0.0) / days - alternative)
            .max(0.0);
        k += 1.0;
    }
    total
}

// --- The game's card profit ---

/// What Rival and Mentor (the employee's and the coworkers') add to the
/// employee's Production today.
fn peer_self_production(e: &RulesEmployee, s: &Situation) -> f64 {
    let Some(peers) = s.peers.as_ref().filter(|p| !p.is_empty()) else {
        return 0.0;
    };
    let mut rows = vec![PeerRow::of(e, s, 0.0)];
    for p in peers.iter() {
        rows.push(PeerRow::of_peer(p, 0.0));
    }
    peer_production(&rows)[0] - rows[0].production.max(1.0)
}

/// Today's output pass (`traitOutputToday`).
struct TodayOutputPass<'a> {
    employee: &'a RulesEmployee,
    situation: &'a Situation,
    held: bool,
    margin: f64,
    production: f64,
    output: f64,
    arg: Option<Rc<str>>,
}
impl TodayOutputPass<'_> {
    fn gain(&self, n: f64) -> f64 {
        if self.held { n } else { happiness_gain(n, self.employee.happiness) }
    }
}
impl HourlyEffects for TodayOutputPass<'_> {
    fn situation(&self) -> &Situation {
        self.situation
    }
    fn held(&self) -> bool {
        self.held
    }
    fn male_coworkers(&self) -> f64 {
        (self.situation.coworkers - self.situation.female_coworkers).max(0.0)
    }
    fn happiness_loss(&self) -> f64 {
        self.employee.happiness_loss
    }
    fn arg(&self) -> Option<&str> {
        self.arg.as_deref()
    }
    fn age(&self) -> f64 {
        self.employee.age
    }
    fn tenure_days(&self) -> f64 {
        self.situation.tenure_days
    }
    fn employed_days(&self) -> f64 {
        self.situation.employed_days
    }
    fn own_luck(&self) -> f64 {
        self.employee.luck
    }
    fn production(&mut self, delta: f64) -> f64 {
        ((self.production + delta).max(1.0) - self.production.max(1.0)) / CFG.output_divisor
            * (1.0 + self.employee.bonus)
            * self.margin
    }
    fn output_percent(&mut self, percent: f64) -> f64 {
        self.output * percent / 100.0 * self.margin
    }
    fn happiness(&mut self, delta: f64) -> f64 {
        self.output * self.gain(delta) / 100.0 * self.margin
    }
    fn responsibility(&mut self, delta: f64) -> f64 {
        self.output * self.gain(CFG.responsibility_happiness * delta) / 100.0 * self.margin
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
    fn stat(&mut self, stat: StatArgument, delta: f64) -> f64 {
        match stat {
            StatArgument::Production => self.production(delta),
            StatArgument::Responsibility => self.responsibility(delta),
            StatArgument::Other => 0.0,
        }
    }
}

/// `traitOutputToday`: what a held trait adds to this employee's own output
/// per hour today, in money at `margin` per PP.
fn trait_output_today(
    t: &Held,
    e: &RulesEmployee,
    situation: &Situation,
    margin: f64,
    held: bool,
) -> f64 {
    let Some(known) = t.code.known().filter(|&k| has_hourly(k)) else {
        return 0.0;
    };
    let others = e.with_traits(e.traits().iter().filter(|x| x.code != t.code).cloned().collect());
    let production = ordinary_production(&others, situation, 0.0);
    let mut x = TodayOutputPass {
        employee: e,
        situation,
        held,
        margin,
        production,
        output: points_per_hour(e),
        arg: t.arg.clone(),
    };
    hourly(known, &mut x)
}

/// `gameDailyProfit`: the card's daily profit as the game shows it, at the
/// game's `margin` for the good; None without a margin above 0.
pub fn game_daily_profit(
    e: &RulesEmployee,
    c: &Card,
    context: &Context,
    margin: Option<f64>,
    pp_value: Option<f64>,
) -> Option<f64> {
    let game_trait = matches!(
        c.kind,
        Kind::Habit | Kind::HabitPair | Kind::Rehab | Kind::RehabAll | Kind::Mentoring
    );
    let margin = margin.filter(|&margin| margin > 0.0)?;
    if !(game_trait || matches!(c.kind, Kind::Drill | Kind::Negotiation | Kind::SecondWind)) {
        return None;
    }
    // Without a wage, the pay is the wage expectation at the PP's value. A
    // card keeps a known wage known (`card_outcomes`).
    let pp_value = match (e.wage, pp_value.filter(|&v| v > 0.0)) {
        (None, None) => return None,
        (_, pp_value) => pp_value,
    };
    if c.kind == Kind::Negotiation && !can_negotiate(e, c.drop) {
        return None;
    }
    let wage = |x: &RulesEmployee| match (x.wage, pp_value) {
        (Some(wage), _) => wage,
        (None, Some(pp_value)) => paid_points_per_hour(x) * x.wage_expectation * pp_value,
        (None, None) => unreachable!("without a wage, the PP value is known"),
    };
    let situation = &*context.situation;
    let bonus = e.bonus;
    let peer_money = |next: &RulesEmployee| {
        (peer_self_production(next, situation) - peer_self_production(e, situation))
            / CFG.output_divisor
            * (1.0 + bonus)
            * margin
    };
    if game_trait {
        let outcomes = card_outcomes(e, c, context);
        if outcomes.is_empty() {
            return None;
        }
        let before = e.traits();
        // With the coworkers known, peerMoney prices Rival and Mentor instead.
        let own = |t: &Held| {
            !(situation.peers.is_some() && t.code.known().is_some_and(unpaid_production))
        };
        return Some(outcomes.iter().fold(0.0, |sum, o| {
            let after = o.next.traits();
            let mut money = peer_money(&o.next);
            for t in after {
                if !before.iter().any(|b| b.code == t.code) && own(t) {
                    money +=
                        trait_output_today(t, &o.next, situation, margin, /* held */ false);
                }
            }
            for t in before {
                if !after.iter().any(|a| a.code == t.code) && own(t) {
                    money -= trait_output_today(t, e, situation, margin, /* held */ true);
                }
            }
            sum + o.probability * 24.0 * (money - (wage(&o.next) - wage(e)))
        }));
    }
    let mut output = 0.0;
    if c.kind == Kind::Drill && c.stat == Some(Stat::Production) {
        output = c.delta / CFG.output_divisor * (1.0 + bonus);
    }
    if c.kind == Kind::Drill && c.stat == Some(Stat::Responsibility) {
        output = points_per_hour(e)
            * happiness_gain(CFG.responsibility_happiness * c.delta, e.happiness)
            * 0.01;
    }
    let outcomes = card_outcomes(e, c, context);
    let next = outcomes.first().map_or(e, |o| &o.next);
    Some(24.0 * (output * margin + peer_money(next) - (wage(next) - wage(e))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(production: f64, rival: bool, mentor: bool) -> PeerRow {
        PeerRow { production, rival, mentor }
    }

    // `trait_value` sums a priced trait's hourly effect: every one but Anchor,
    // which it values apart, has an hourly rule.
    #[test]
    fn priced_traits_have_hourly_rules() {
        for &t in TRAITS {
            if t.rule().priced != Priced::Unpriced && t != Trait::Anchor {
                assert!(has_hourly(t));
            }
        }
    }

    #[test]
    fn odds_without_luck_or_management_are_the_weights() {
        let odds = rarity_odds(0.0, 0.0);
        assert_eq!(odds, [0.55, 0.25, 0.13, 0.05, 0.02]);
        let shifted = rarity_odds(10.0, 3.0);
        assert!((shifted.iter().sum::<f64>() - 1.0).abs() < 1e-12 && shifted[0] < 0.55);
    }

    #[test]
    fn peer_effects_use_the_frozen_comparison() {
        let plain = peer_production(&[
            row(10.0, false, false),
            row(12.0, false, false),
            row(8.0, false, false),
        ]);
        assert_eq!(plain, vec![10.0, 12.0, 8.0]);
        // Rival with a stronger coworker +3, Mentor -1 with a weaker one and
        // +2 to each weaker coworker.
        let peers = peer_production(&[
            row(10.0, true, false),
            row(12.0, false, true),
            row(8.0, false, false),
        ]);
        assert_eq!(peers, vec![15.0, 11.0, 10.0]);
        assert_eq!(peer_production(&[row(5.0, false, true)]), vec![5.0]);
    }

    #[test]
    fn second_wind_stays_within_the_potential_cap() {
        let wind = |gain| Card { gain, ..Card::new(Kind::SecondWind) };
        let e = RulesEmployee { potential_max: Some(13.0), ..RulesEmployee::default() };
        assert!(card_outcomes(&e, &wind(3.0), &Context::default()).is_empty());
        let o = card_outcomes(&e, &wind(2.0), &Context::default());
        let set: Vec<(&str, f64)> = o[0].set.iter().map(|c| (c.name, c.value)).collect();
        assert_eq!(set, vec![("potentialLeft", 5.0), ("potentialMax", 15.0)]);
        assert!(card_outcomes(&e, &wind(1.5), &Context::default()).is_empty());
    }

    #[test]
    fn a_production_drill_moves_the_wage_with_paid_production() {
        let e = RulesEmployee { wage: Some(0.75), ..RulesEmployee::default() };
        let o = card_outcomes(&e, &Card::drill(Stat::Production, 1.0), &Context::default());
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].next.production, 4.0);
        assert_eq!(o[0].next.wage, Some(1.0));
        assert_eq!(o[0].next.wage_expectation, 1.0);
    }

    #[test]
    fn a_fractional_working_life_counts_its_whole_days() {
        let patriot = |retire_in_days| {
            let e = RulesEmployee { retire_in_days: Some(retire_in_days), ..Default::default() };
            trait_value(&Code::Known(Trait::Patriot), &e, &Context::default(), None, false).value
        };
        assert_eq!(patriot(2.5), patriot(2.0));
        assert!(patriot(2.0).is_some_and(|v| v > 0.0));
    }
}
