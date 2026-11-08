//! The career simulation: `EmployeeCareer.batch` (the paired-career
//! engine) and `EmployeePlanner.careerOptions` (its rules), in one place so
//! no step crosses back to JS.
//!
//! Every card in the live hand, plus taking nothing, is one arm; each
//! sampled career runs every arm on the same random numbers. The subject's
//! company is projected a step at a time (project.rs, `DirectProjector`),
//! and card outcomes, pools and odds come from the rules (rules.rs).
//!
//! Career states are records: the projection's `EmployeeRecord` and the
//! rules' `RulesEmployee` side by side, shifted (`shifted`) and changed by
//! card outcomes (`after`). What one state works out once is kept on it;
//! what states with one signature (`State::signature`) share is kept for
//! the states used most recently (`STATES_KEPT`), and states with equal
//! card pools share one. All of it is pure, so caching changes only the
//! counters, and a `Model` keeps its caches across batches.

use crate::cache::Recent;
use crate::cfg::{CFG, Rarity};
use crate::check;
use crate::model::{Card, Code, Context, Energy, Kind, ProductionEvent, RulesEmployee, Situation};
use crate::planner::{Env, Plan};
use crate::project::{
    self, CompanyRecord, DirectProjector, EmployeeRecord, HeldMember, TimedEvent, Tool,
    TrainingRow, TraitRecord,
};
use crate::rules::{self, FieldChange, Memo, Outcome, OutcomeTrait, Pool, Price};
use crate::snapshot::Snapshot;
use crate::traits::Trait;
use serde::{Deserialize, Serialize};
use std::cell::{Cell, OnceCell};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::rc::{Rc, Weak};

pub const VERSION: f64 = 5.0;
/// A new hand from Reroll costs no potential; this caps a run of them.
pub const MAX_REROLLS: u32 = 8;
/// The tolerance on times in days: a time this near a whole day is on it.
const EPSILON: f64 = 1e-9;
/// Signatures whose shared values are kept (`cache::Recent`): with the
/// pools they hold, about 40 MB at most over 6,144 careers, and a
/// thousand careers of one subject fit without working anything out twice.
const STATES_KEPT: usize = 100_000;
/// Elapsed times whose shifted coworkers are kept: a few per day of a
/// working life. Shifting them again is cheap.
const PEERS_KEPT: usize = 2_000;

// --- Random numbers ---

/// One round of the integer hash behind `random_from_int32s`.
#[inline]
fn mix(x: i32, n: i32) -> i32 {
    let x = (x ^ n).wrapping_mul(0x45d9f3b);
    x ^ (x as u32 >> 16) as i32
}
/// `random(seed, pair, step, purpose)` on int32s.
#[inline]
pub fn random_from_int32s(seed: i32, pair: i32, step: i32, purpose: i32) -> f64 {
    let x = mix(mix(mix(seed, pair), step), purpose).wrapping_mul(0x45d9f3b);
    let x = x ^ (x as u32 >> 16) as i32;
    (x as u32) as f64 / 4294967296.0
}
/// `x` rounded when it is within `EPSILON` of a whole number.
fn snap(x: f64) -> f64 {
    if (x - x.round()).abs() < EPSILON { x.round() } else { x }
}

// --- Hashing ---

/// A hasher that passes a `u64` key through: the keys are hashes already.
#[derive(Default)]
struct IdentityHasher {
    hash: u64,
}
impl Hasher for IdentityHasher {
    fn finish(&self) -> u64 {
        self.hash
    }
    fn write(&mut self, _: &[u8]) {
        unreachable!()
    }
    fn write_u64(&mut self, n: u64) {
        self.hash = n;
    }
}
/// A map keyed by a hash made already (a state's signature).
type ByHash = BuildHasherDefault<IdentityHasher>;

/// murmur3's 64-bit finalizer (`fmix64`).
#[inline]
fn murmur_finalize(mut x: u64) -> u64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    x ^ x >> 33
}

/// A 64-bit structural hash of a state's fields, in order. Two different
/// states share one with odds of about n² / 2^65 for n states: under 1e-8
/// for the million a long session might see.
struct KeyHasher {
    hash: u64,
}
impl KeyHasher {
    fn new() -> KeyHasher {
        KeyHasher { hash: 0xcbf2_9ce4_8422_2325 }
    }
    /// Each word through the murmur3 finalizer first: float bits differ in
    /// few, structured places, which a plain xor-multiply lets collide.
    #[inline]
    fn write_word(&mut self, x: u64) {
        self.hash = (self.hash.rotate_left(29) ^ murmur_finalize(x ^ self.hash))
            .wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    #[inline]
    fn write_number(&mut self, x: f64) {
        self.write_word(x.to_bits());
    }
    #[inline]
    fn write_option(&mut self, x: Option<f64>) {
        match x {
            None => self.write_word(0),
            Some(x) => {
                self.write_word(1);
                self.write_number(x);
            }
        }
    }
    fn write_string(&mut self, s: &str) {
        self.write_word(s.len() as u64);
        for b in s.bytes() {
            self.write_word(b as u64);
        }
    }
    fn write_code(&mut self, code: &Code) {
        match code {
            Code::Known(t) => self.write_word(1 + *t as u64),
            Code::Unknown(s) => {
                self.write_word(0);
                self.write_string(s);
            }
        }
    }
    fn write_optional_code(&mut self, code: Option<&Code>) {
        match code {
            None => self.write_word(u64::MAX),
            Some(code) => self.write_code(code),
        }
    }
    /// Every field of a card.
    fn write_card(&mut self, card: &Card) {
        self.write_word(card.kind as u64);
        self.write_word(card.stat.map_or(0, |s| 1 + s as u64));
        self.write_number(card.delta);
        self.write_number(card.drop);
        self.write_number(card.gain);
        self.write_optional_code(card.code.as_ref());
        match &card.codes {
            None => self.write_word(u64::MAX),
            Some(codes) => {
                self.write_word(codes.len() as u64);
                for code in codes.iter() {
                    self.write_code(code);
                }
            }
        }
        self.write_optional_code(card.to.as_ref());
        match &card.arg {
            None => self.write_word(u64::MAX),
            Some(arg) => self.write_string(arg),
        }
    }
}

/// A card's structural hash: what its value is kept under in a state.
fn card_key(card: &Card) -> u64 {
    let mut hasher = KeyHasher::new();
    hasher.write_card(card);
    hasher.hash
}

/// A card with its `card_key`.
#[derive(Clone)]
struct KeyedCard {
    card: Card,
    key: u64,
}
impl KeyedCard {
    fn new(card: Card) -> KeyedCard {
        let key = card_key(&card);
        KeyedCard { card, key }
    }
}

/// What a pool card's values are kept under: its own key, and for a Habit
/// pair each habit's (`Model::estimate` counts the pair as the two alone).
struct CardKeys {
    key: u64,
    habits: Vec<KeyedCard>,
}
impl CardKeys {
    fn of(card: &Card) -> CardKeys {
        let habits = if card.kind == Kind::HabitPair {
            card.codes
                .iter()
                .flat_map(|codes| codes.iter())
                .map(|code| KeyedCard::new(Card::with_code(Kind::Habit, code.clone())))
                .collect()
        } else {
            Vec::new()
        };
        CardKeys { key: card_key(card), habits }
    }
}

/// A card pool with its cards' keys, worked out once per distinct pool.
struct KeyedPool {
    cards: Pool,
    /// By rarity and place, as `cards`.
    keys: [Vec<CardKeys>; 5],
}
impl KeyedPool {
    fn new(cards: Pool) -> KeyedPool {
        let keys =
            std::array::from_fn(|r| cards.0[r].iter().map(|x| CardKeys::of(&x.card)).collect());
        KeyedPool { cards, keys }
    }
}

/// A quick hash of a pool (each card's kind, stat, numbers, code and
/// value), to find an equal pool to share: equality is checked after.
fn pool_key(pool: &Pool) -> u64 {
    let mut hash: u64 = 0;
    let mut add = |x: u64| hash = (hash.rotate_left(5) ^ x).wrapping_mul(0x517c_c1b7_2722_0a95);
    for cards in &pool.0 {
        add(cards.len() as u64);
        for pooled in cards {
            let card = &pooled.card;
            let code = match &card.code {
                Some(Code::Known(t)) => 1 + *t as u64,
                Some(Code::Unknown(_)) => 0xffff,
                None => 0,
            };
            add(card.kind as u64 | card.stat.map_or(0, |s| 1 + s as u64) << 8 | code << 16);
            add(card.delta.to_bits()
                ^ card.drop.to_bits().rotate_left(21)
                ^ card.gain.to_bits().rotate_left(42));
            add(pooled.value.to_bits());
        }
    }
    hash
}

// --- Career states ---

/// A career state: the employee as the projection reads it (`record`) and
/// as the rules read it (`employee`, before `model` adds wageExpectation),
/// the saved specialization on the company's good if they have one, and
/// the days elapsed. The cells keep what is worked out once per state.
#[derive(Clone)]
struct State {
    record: EmployeeRecord,
    employee: RulesEmployee,
    specialization: Option<f64>,
    elapsed: f64,
    /// `signature()`, once made.
    cached_signature: Cell<Option<u64>>,
    /// `Model::model` of this state.
    model: OnceCell<Rc<RulesEmployee>>,
    /// `Model::context` of this state.
    context: OnceCell<Rc<Context>>,
}

impl State {
    fn new(
        record: EmployeeRecord,
        employee: RulesEmployee,
        specialization: Option<f64>,
        elapsed: f64,
    ) -> State {
        State {
            record,
            employee,
            specialization,
            elapsed,
            cached_signature: Cell::new(None),
            model: OnceCell::new(),
            context: OnceCell::new(),
        }
    }
    /// What tells states apart: the days elapsed and everything a card can
    /// change (production, responsibility, Luck, traits, wage, negotiation
    /// expectation, Climber raise, trait Production, potential max), hashed
    /// (`KeyHasher`). The rest of the record follows from the subject and
    /// the days elapsed. Potential left is left out, an approximation: it
    /// reaches a day's projection only through training values, once it runs
    /// out within the day. With it, the capture careers came out bit for bit
    /// the same for 4-11% more projections.
    fn signature(&self) -> u64 {
        if let Some(signature) = self.cached_signature.get() {
            return signature;
        }
        let employee = &self.employee;
        let mut hasher = KeyHasher::new();
        hasher.write_number(self.elapsed);
        hasher.write_number(employee.production);
        hasher.write_number(employee.responsibility);
        hasher.write_number(employee.luck);
        let traits = employee.traits();
        hasher.write_word(traits.len() as u64);
        for held in traits {
            hasher.write_code(&held.code);
            match &held.arg {
                None => hasher.write_word(0),
                Some(arg) => {
                    hasher.write_word(1);
                    hasher.write_string(arg);
                }
            }
        }
        hasher.write_option(employee.wage);
        hasher.write_option(employee.negotiation_expectation);
        hasher.write_option(employee.climber_raise);
        hasher.write_number(employee.trait_production);
        hasher.write_option(employee.potential_max);
        self.cached_signature.set(Some(hasher.hash));
        hasher.hash
    }
    /// The state after a training: one potential fewer, the rest the same.
    /// Only a state with potential left trains.
    fn trained(&self) -> State {
        let left = self.record.potential_left.map(|left| left - 1.0);
        let mut record = self.record.clone();
        record.potential_left = left;
        let mut employee = self.employee.clone();
        if let Some(left) = left {
            employee.potential_left = left;
        }
        State {
            record,
            employee,
            specialization: self.specialization,
            elapsed: self.elapsed,
            cached_signature: self.cached_signature.clone(),
            model: OnceCell::new(),
            context: self.context.clone(),
        }
    }
}

fn has_trait(record: &EmployeeRecord, wanted: Trait) -> bool {
    record.traits.iter().any(|x| x.id == Some(wanted))
}

/// `shifted(e, days)` on the projection's record: older, nearer retirement,
/// the wage with Climber raises, specialization on the good, events counted
/// down. Returns the saved specialization after.
fn shift_record(
    record: &mut EmployeeRecord,
    specialization: Option<f64>,
    days: f64,
) -> Option<f64> {
    let retire = (project::working_days(record) - days).max(0.0);
    let wage = project::wage_at(record, days * 24.0);
    record.age += days;
    record.retire_in_days = Some(retire);
    record.tenure += days;
    record.employed_days += days;
    record.move_age_hours += days * 24.0;
    record.wage = wage;
    let hours = days * 24.0;
    record.happiness_events.retain_mut(|x| {
        x.hours_left -= hours;
        x.hours_left > 0.0
    });
    record.production_events.retain_mut(|x| {
        x.hours_left -= hours;
        x.hours_left > 0.0
    });
    specialization.map(|n| {
        (n + days * if has_trait(record, Trait::QuickStudy) { 2.0 } else { 1.0 }).min(20.0)
    })
}

/// `shifted` on a career state (its rules record too).
fn shifted(state: &State, days: f64, to: f64) -> State {
    let mut record = state.record.clone();
    let employed = record.employed_days;
    let climbs = has_trait(&record, Trait::Climber);
    let specialization = shift_record(&mut record, state.specialization, days);
    let mut employee = state.employee.clone();
    employee.age = record.age;
    employee.retire_in_days = record.retire_in_days;
    employee.wage = Some(record.wage);
    if let Some(expectation) = employee.negotiation_expectation {
        let raise = if climbs {
            0.02 * (((employed + days + EPSILON) / 7.0).floor()
                - ((employed + EPSILON) / 7.0).floor())
        } else {
            0.0
        };
        employee.negotiation_expectation = Some(expectation + raise);
    }
    employee.events = record
        .production_events
        .iter()
        .map(|x| ProductionEvent { delta: x.delta, hours_left: x.hours_left })
        .collect();
    State::new(record, employee, specialization, to)
}

/// The employee after an outcome of a card taken in `state`.
fn after(state: &State, outcome: &Outcome) -> State {
    let mut record = state.record.clone();
    if let Some(items) = &outcome.traits {
        record.traits = items
            .iter()
            .map(|item| match item {
                OutcomeTrait::Held(i) => state.record.traits[*i].clone(),
                OutcomeTrait::New { trait_id, arg } => {
                    TraitRecord::new(Some(*trait_id), arg.as_deref().map_or(0, project::intern))
                }
            })
            .collect();
        record.update_flags();
    }
    for &FieldChange { name, value } in &outcome.set {
        match name {
            "production" => record.production = value,
            "responsibility" => record.responsibility = value,
            "luck" => {
                record.luck = value;
            }
            "traitProduction" => record.trait_production = value,
            "wage" => record.wage = value,
            "climberRaise" => record.climber_raise = value,
            "potentialLeft" => record.potential_left = Some(value),
            _ => {}
        }
    }
    State::new(record, outcome.next.clone(), state.specialization, state.elapsed)
}

// --- The rules (careerOptions) ---

/// A coworker as encoded: the record, saved specialization (if they have
/// the good), and their tool.
struct Peer {
    record: EmployeeRecord,
    specialization: Option<f64>,
    tool: Option<Tool>,
}

/// A coworker shifted to an elapsed time, as the projection holds them.
struct ShiftedPeer {
    record: EmployeeRecord,
    /// The saved specialization on the good, 0 without it.
    saved: f64,
    tool: Option<Tool>,
}

/// The coworkers at one elapsed time: shifted, with the situation they make.
struct PeersAt {
    peers: Vec<ShiftedPeer>,
    situation: Situation,
}

/// A rarity a hand can be dealt from, with its odds among those.
#[derive(Clone, Copy)]
struct RarityOdds {
    rarity: usize,
    probability: f64,
}

/// A step's profit, kept under the step's length in days.
struct StepProfit {
    days: f64,
    profit: f64,
}

/// A card's `lasting` value, under its `card_key`.
struct CardValue {
    key: u64,
    value: Option<f64>,
}

/// What states with one signature share, each worked out once it's asked
/// for. Every step reads the first two; only states that decide read the rest.
#[derive(Default)]
struct StateValues {
    training_row: Option<Option<TrainingRow>>,
    step_profits: Vec<StepProfit>,
    decision: Option<Box<DecisionValues>>,
}

#[derive(Default)]
struct DecisionValues {
    base: Option<f64>,
    card_pool: Option<Rc<KeyedPool>>,
    rarity_odds: Option<Rc<[RarityOdds]>>,
    card_values: Vec<CardValue>,
    fresh_hand: Option<f64>,
    reference: Option<f64>,
}

/// A card's place in a pool: its rarity and its index there.
#[derive(Clone, Copy)]
struct PoolPlace {
    rarity: usize,
    index: usize,
}

/// A dealt hand: the pool it came from and the cards' places in it.
struct Hand {
    pool: Rc<KeyedPool>,
    cards: Vec<PoolPlace>,
}

/// A career's subject as `careerOptions` hands it over: `{ employee,
/// energyValue, hand }`. `employee` is the subject as the rules read them
/// (model.rs); `energyValue` what 10 energy earns elsewhere, a number or a
/// list by day, decoded as a context's (unknown is 0); `hand` a card or
/// null per slot.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub employee: RulesEmployee,
    pub energy_value: Option<Energy>,
    pub hand: Vec<Option<Card>>,
}

/// The work a career model has done: `{ projections, pools }`.
#[derive(Serialize)]
pub struct Metrics {
    pub projections: f64,
    pub pools: f64,
}

/// How far a batch has got: `{ completed, decisions, candidates,
/// transitions }`.
#[derive(Serialize)]
pub struct Progress {
    pub completed: f64,
    pub decisions: f64,
    pub candidates: f64,
    pub transitions: f64,
}

/// The rules of one employee's careers (`careerOptions`): the subject, the
/// coworkers and the hand's arms, with the caches the states share.
pub struct Model {
    /// The PP's money value.
    pp_value: f64,
    pub horizon: f64,
    energy: Energy,
    /// The company's management, for the rarity odds.
    management: f64,
    projector: DirectProjector,
    gender: Option<Rc<str>>,
    subject: State,
    tool: Option<Tool>,
    peers: Vec<Peer>,
    pub arms: Vec<Option<Card>>,
    pub slots: Vec<u32>,
    pub skipped: Vec<u32>,
    /// By signature: what the states share, across batches.
    shared: Recent<u64, StateValues, ByHash>,
    /// By the elapsed time's bits.
    peers_at: Recent<u64, Rc<PeersAt>>,
    /// The pools kept states hold, by `pool_key`: states with equal pools
    /// share one.
    pools_seen: HashMap<u64, Vec<Weak<KeyedPool>>, ByHash>,
    /// The cards `reference` prices: a +1 drill of each stat, then a 5%
    /// Negotiation.
    reference_cards: Rc<[KeyedCard]>,
    pub projections: f64,
    pub pools: f64,
}

impl Model {
    /// The careers of employee `subject` of `snapshot` (`careerOptions`'s
    /// one-company snapshot): only their company is projected, the subject
    /// with the coworkers there. The subject's training base Luck is today's
    /// Luck; their company's recruiting is left out. `input`: their rules,
    /// energy and hand (see `Subject`).
    pub fn new(snapshot: &Snapshot, subject: usize, input: Subject) -> Result<Model, &'static str> {
        let Subject { employee, energy_value, hand } = input;
        let e = &snapshot.employees[subject];
        let horizon = project::working_days(&e.record);
        if !horizon.is_finite() {
            return Err("Working days left are required.");
        }
        if !check::numbers_known(&Env::new(Plan::new(snapshot))) {
            return Err(check::UNKNOWN_NUMBERS);
        }
        let energy = energy_value.unwrap_or(Energy::Number(0.0));
        let company_place = snapshot.first_company(e.record.company);
        let mut company = company_place
            .map_or_else(CompanyRecord::default, |c| snapshot.companies[c].record.clone());
        company.recruitment = None;
        let company_id = company_place.map(|c| snapshot.companies[c].record.id);
        let roster: Vec<usize> = (0..snapshot.employees.len())
            .filter(|&x| Some(snapshot.employees[x].record.company) == company_id)
            .collect();
        let member = |x: usize| {
            let peer = &snapshot.employees[x];
            let tool = snapshot.first_tool(peer.equipped).filter(|_| peer.equipped != 0);
            Peer {
                record: peer.record.clone(),
                specialization: company
                    .product_text
                    .as_ref()
                    .and_then(|_| peer.saved_days(company.product)),
                tool: tool.map(|t| snapshot.tools[t].tool),
            }
        };
        let mut first = member(subject);
        first.record.training_base_luck = Some(first.record.luck);
        let peers: Vec<Peer> = roster
            .iter()
            .copied()
            .filter(|&x| snapshot.employees[x].record.id != e.record.id)
            .map(member)
            .collect();
        let pp_value = snapshot.pp_value.ok_or("The PP value is required.")?;
        let (management, toolbox_value) = (snapshot.management, snapshot.toolbox_value);
        let roster_size = roster.len() as f64;
        let gender = e.gender.clone();
        let mut model = Model {
            pp_value,
            horizon,
            energy,
            management,
            projector: DirectProjector::new(company, management, toolbox_value, roster_size),
            gender: gender.filter(|g| !g.is_empty()),
            subject: State::new(first.record, employee, first.specialization, 0.0),
            tool: first.tool,
            peers,
            arms: vec![None],
            slots: Vec::new(),
            skipped: Vec::new(),
            shared: Recent::new(STATES_KEPT),
            peers_at: Recent::new(PEERS_KEPT),
            pools_seen: HashMap::default(),
            reference_cards: crate::cards::Stat::ALL
                .into_iter()
                .map(|stat| Card::drill(stat, 1.0))
                .chain([Card { drop: 0.05, ..Card::new(Kind::Negotiation) }])
                .map(KeyedCard::new)
                .collect(),
            projections: 0.0,
            pools: 0.0,
        };
        let subject = model.subject.clone();
        for (slot, card) in hand.into_iter().enumerate() {
            let takeable = card.as_ref().is_some_and(|c| {
                c.kind == Kind::Reroll
                    || !model.capped(&subject, c) && !model.outcomes(&subject, c).is_empty()
            });
            if takeable {
                model.arms.push(card);
                model.slots.push(slot as u32);
            } else {
                model.skipped.push(slot as u32);
            }
        }
        Ok(model)
    }

    pub fn metrics(&self) -> Metrics {
        Metrics { projections: self.projections, pools: self.pools }
    }

    pub fn energy_cost(&self, time: f64) -> f64 {
        rules::energy_on(&self.energy, time)
    }

    /// The coworkers shifted to `elapsed`, and the situation among them.
    fn peers_at(&mut self, elapsed: f64) -> Rc<PeersAt> {
        let key = elapsed.to_bits();
        if let Some(cached) = self.peers_at.get(&key) {
            return cached;
        }
        let peers: Vec<ShiftedPeer> = self
            .peers
            .iter()
            .map(|peer| {
                let mut record = peer.record.clone();
                let specialization = shift_record(&mut record, peer.specialization, elapsed);
                let tool =
                    peer.tool.map(|t| Tool { hours: (t.hours - elapsed * 24.0).max(0.0), ..t });
                ShiftedPeer { record, saved: specialization.unwrap_or(0.0), tool }
            })
            .collect();
        // The training model's situation: `scene` among the working roster.
        let roster: Vec<&EmployeeRecord> = peers
            .iter()
            .map(|x| &x.record)
            .filter(|record| project::working_days(record) > 0.0)
            .collect();
        let company = &self.projector.company();
        let scene = project::scene_of(company, &roster, &self.subject.record);
        let nonempty = |s: &Option<Rc<str>>| s.clone().filter(|x| !x.is_empty());
        let situation = Situation {
            coworkers: scene.standing.coworkers,
            female_coworkers: scene.standing.female_coworkers,
            same_nationality_coworkers: Some(scene.standing.same_nationality_coworkers != 0.0),
            other_nationalities: scene.standing.other_nationalities,
            place: Some(project::place_name(scene.place)),
            home_core: Some(scene.home_core),
            item_type: nonempty(&company.item_type_text),
            product: nonempty(&company.product_text),
            income_tax: company.tax,
            small_storage: scene.small_storage,
            storage_full: company.full,
            gender: self.gender.clone(),
            coworker_ids: self
                .peers
                .iter()
                .filter(|x| project::working_days(&x.record) > elapsed)
                .filter_map(|x| project::string(x.record.id))
                .collect(),
            ..Situation::default()
        };
        drop(roster);
        let shifted = Rc::new(PeersAt { peers, situation });
        self.peers_at.insert(key, shifted.clone());
        shifted
    }

    /// The state and its coworkers then, with their tools.
    fn members<'a>(&self, state: &'a State, peers_at: &'a PeersAt) -> Vec<HeldMember<'a>> {
        let mut members = Vec::with_capacity(peers_at.peers.len() + 1);
        let tool =
            self.tool.map(|t| Tool { hours: (t.hours - state.elapsed * 24.0).max(0.0), ..t });
        members.push(HeldMember {
            employee: &state.record,
            saved: state.specialization.unwrap_or(0.0),
            tool,
        });
        for peer in &peers_at.peers {
            members.push(HeldMember { employee: &peer.record, saved: peer.saved, tool: peer.tool });
        }
        members
    }

    /// `project(e, days)`: a day's (or `days`') company profit, in PP.
    fn project(&mut self, state: &State, days: f64) -> f64 {
        self.projections += 1.0;
        let peers_at = self.peers_at(state.elapsed);
        let members = self.members(state, &peers_at);
        self.projector.value(days * 24.0, &members) / self.pp_value
    }

    /// The context the rules price the state in.
    fn context(&mut self, state: &State) -> Rc<Context> {
        if let Some(context) = state.context.get() {
            return context.clone();
        }
        let peers_at = self.peers_at(state.elapsed);
        let mut situation = peers_at.situation.clone();
        situation.tenure_days = state.record.tenure;
        situation.employed_days = state.record.employed_days;
        let context = Rc::new(Context {
            pp_value: Some(self.pp_value),
            situation: Rc::new(situation),
            ..Context::default()
        });
        let _ = state.context.set(context.clone());
        context
    }

    /// The state as the rules read it: wage per paid point, which cards move.
    fn model(&self, state: &State) -> Rc<RulesEmployee> {
        state
            .model
            .get_or_init(|| {
                let employee = &state.employee;
                let wage_expectation = match employee.wage {
                    Some(wage) => wage / (rules::paid_production(employee) / 4.0 * self.pp_value),
                    None => employee.wage_expectation,
                };
                Rc::new(RulesEmployee { wage_expectation, ..employee.clone() })
            })
            .clone()
    }

    fn outcomes(&mut self, state: &State, card: &Card) -> Vec<Outcome> {
        let model = self.model(state);
        let context = self.context(state);
        rules::card_outcomes(&model, card, &context)
    }

    /// What the states with this one's signature share.
    fn shared(&mut self, state: &State) -> &mut StateValues {
        self.shared.get_or_insert_with(state.signature(), StateValues::default)
    }
    /// What the deciding states with this one's signature share.
    fn decision(&mut self, state: &State) -> &mut DecisionValues {
        self.shared(state).decision.get_or_insert_with(Box::default)
    }

    /// A day's company profit in the state.
    fn base(&mut self, state: &State) -> f64 {
        if let Some(value) = self.decision(state).base {
            return value;
        }
        let value = self.project(state, 1.0);
        self.decision(state).base = Some(value);
        value
    }

    /// The state's `instant` row at hour 0 (trainings a day, Luck).
    fn training_row(&mut self, state: &State) -> Option<TrainingRow> {
        if let Some(row) = self.shared(state).training_row {
            return row;
        }
        let peers_at = self.peers_at(state.elapsed);
        let members = self.members(state, &peers_at);
        let row = self.projector.row(&members, state.record.id);
        self.shared(state).training_row = Some(row);
        row
    }
    /// Trainings a day: Trainer coworkers add some; the game's reported
    /// allowance stands while the roster is the reported one.
    fn training_rate(&mut self, state: &State) -> f64 {
        self.training_row(state).map_or(1.0, |row| row.trainings_per_day)
    }

    /// The cards a hand can be dealt, by rarity.
    fn card_pool(&mut self, state: &State) -> Rc<KeyedPool> {
        if let Some(pool) = &self.decision(state).card_pool {
            return pool.clone();
        }
        self.pools += 1.0;
        let model = self.model(state);
        let context = self.context(state);
        let price = |card: &Card| {
            Ok(if card.kind == Kind::Negotiation && !rules::can_negotiate(&model, card.drop) {
                None
            } else {
                Some(0.0)
            })
        };
        let pool = rules::model_only(rules::card_pool(
            &model,
            &context,
            &Price::Given(&price),
            1.0,
            &Memo::default(),
        ));
        let seen = self.pools_seen.entry(pool_key(&pool)).or_default();
        seen.retain(|x| x.strong_count() > 0);
        let pool = match seen.iter().filter_map(Weak::upgrade).find(|x| x.cards == pool) {
            Some(x) => x,
            None => {
                let pool = Rc::new(KeyedPool::new(pool));
                seen.push(Rc::downgrade(&pool));
                pool
            }
        };
        self.decision(state).card_pool = Some(pool.clone());
        pool
    }

    /// The rarities a hand can be dealt from, with their odds.
    fn rarity_odds(&mut self, state: &State) -> Rc<[RarityOdds]> {
        if let Some(odds) = &self.decision(state).rarity_odds {
            return odds.clone();
        }
        let pool = self.card_pool(state);
        let luck = self.training_row(state).map_or(state.record.luck, |row| row.luck);
        let all = rules::rarity_odds(luck, self.management);
        let open: Vec<usize> = (0..Rarity::ALL.len())
            .filter(|&r| pool.cards.0[r].len() as f64 >= CFG.hand_size)
            .collect();
        let total = open.iter().fold(0.0, |sum, &r| sum + all[r]);
        let odds: Rc<[RarityOdds]> = open
            .iter()
            .map(|&rarity| RarityOdds { rarity, probability: all[rarity] / total })
            .collect();
        self.decision(state).rarity_odds = Some(odds.clone());
        odds
    }

    /// Career PP of a card taken now against taking nothing: a day's change
    /// in company profit over the working days left, kept under the card's
    /// `key`. None if it can't be taken.
    fn lasting(&mut self, state: &State, card: &Card, key: u64) -> Option<f64> {
        if let Some(cached) = self.decision(state).card_values.iter().find(|x| x.key == key) {
            return cached.value;
        }
        let outcomes = self.outcomes(state, card);
        let value = if outcomes.is_empty() {
            None
        } else {
            let mut sum = 0.0;
            for outcome in &outcomes {
                let next = after(state, outcome);
                sum += outcome.probability * self.project(&next, 1.0);
            }
            Some((sum - self.base(state)) * project::working_days(&state.record))
        };
        self.decision(state).card_values.push(CardValue { key, value });
        value
    }

    /// A fresh hand's card, Reroll left out and Second Wind at 0. Two new
    /// habits count as the sum of each alone.
    fn estimate(&mut self, state: &State, card: &Card, keys: &CardKeys) -> f64 {
        match card.kind {
            Kind::SecondWind => 0.0,
            Kind::HabitPair => {
                let mut sum = 0.0;
                for habit in &keys.habits {
                    sum += self.lasting(state, &habit.card, habit.key).unwrap_or(0.0);
                }
                sum
            }
            _ => self.lasting(state, card, keys.key).unwrap_or(0.0),
        }
    }

    /// A fresh hand's expected best card.
    fn fresh_hand(&mut self, state: &State) -> f64 {
        if let Some(value) = self.decision(state).fresh_hand {
            return value;
        }
        let pool = self.card_pool(state);
        let odds = self.rarity_odds(state);
        let mut sum = 0.0;
        for &RarityOdds { rarity, probability } in odds.iter() {
            let mut values = Vec::with_capacity(pool.cards.0[rarity].len());
            for (pooled, keys) in pool.cards.0[rarity].iter().zip(&pool.keys[rarity]) {
                if pooled.card.kind == Kind::Reroll {
                    continue;
                }
                values.push(self.estimate(state, &pooled.card, keys));
            }
            sum += probability * rules::expected_max(&values, CFG.hand_size);
        }
        self.decision(state).fresh_hand = Some(sum);
        sum
    }

    /// An ordinary hand's typical best card: the best +1 drill, or a 5%
    /// Negotiation where it can be taken.
    fn reference(&mut self, state: &State) -> f64 {
        if let Some(value) = self.decision(state).reference {
            return value;
        }
        let cards = self.reference_cards.clone();
        let (negotiation, drills) =
            cards.split_last().expect("the reference ends with its Negotiation");
        let mut value: f64 = 0.0;
        for drill in drills {
            value = value.max(self.lasting(state, &drill.card, drill.key).unwrap_or(0.0));
        }
        let model = self.model(state);
        value = value.max(if rules::can_negotiate(&model, negotiation.card.drop) {
            self.lasting(state, &negotiation.card, negotiation.key).unwrap_or(0.0)
        } else {
            0.0
        });
        self.decision(state).reference = Some(value);
        value
    }

    /// Whether a training is worth its energy: an ordinary hand's typical
    /// best card earns more, or the average hand's best card does (an
    /// employee whose +1 cards earn little can still hold a hand that pays).
    fn worth_training(&mut self, state: &State, cost: f64) -> bool {
        self.reference(state) > cost || self.fresh_hand(state) > cost
    }

    /// A Second Wind that would take potentialMax past the cap.
    fn capped(&self, state: &State, card: &Card) -> bool {
        card.kind == Kind::SecondWind
            && state
                .employee
                .potential_max
                .is_none_or(|potential_max| potential_max + card.gain > CFG.potential_max_cap)
    }

    /// Second Wind: each extra training comes after the potential already
    /// left, so it is worth a fresh hand discounted to the working days then
    /// remaining, less what its energy would earn that day.
    fn second_wind_value(&mut self, state: &State, card: &Card, time: f64) -> f64 {
        let days = project::working_days(&state.record);
        let rate = self.training_rate(state);
        // A hand is dealt only with potential left.
        let Some(left) = state.record.potential_left else { return 0.0 };
        if days <= 0.0 || rate <= 0.0 {
            return 0.0;
        }
        let fresh = self.fresh_hand(state);
        let mut total = 0.0;
        let mut j = 1.0;
        while j <= card.gain {
            let until = (left + j) / rate;
            total +=
                (fresh * (days - until).max(0.0) / days - self.energy_cost(time + until)).max(0.0);
            j += 1.0;
        }
        total
    }

    /// The policy's score of a card in a hand (its value kept under `key`);
    /// None if it can't be taken.
    fn score(&mut self, state: &State, card: &Card, key: u64, time: f64) -> Option<f64> {
        if card.kind == Kind::Reroll {
            return Some(self.fresh_hand(state));
        }
        if self.capped(state, card) {
            return None;
        }
        if card.kind == Kind::SecondWind {
            return Some(self.second_wind_value(state, card, time));
        }
        self.lasting(state, card, key)
    }

    /// The outcome `draw` picks: the last one takes what rounding leaves.
    fn pick(&mut self, state: &State, card: &Card, draw: f64) -> Result<Outcome, &'static str> {
        let mut options = self.outcomes(state, card);
        let mut remaining = draw;
        for (i, outcome) in options.iter().enumerate() {
            remaining -= outcome.probability;
            if remaining < 0.0 {
                return Ok(options.swap_remove(i));
            }
        }
        options.pop().ok_or("Ineligible career card.")
    }
    fn apply(&mut self, state: &State, card: &Card, draw: f64) -> Result<State, &'static str> {
        let outcome = self.pick(state, card, draw)?;
        Ok(after(state, &outcome))
    }

    /// `next(e, time)`.
    fn next(&mut self, state: &State, time: f64) -> f64 {
        let rate = self.training_rate(state);
        if rate > 0.0 { time + 1.0 / rate } else { f64::INFINITY }
    }

    /// `advance(e, from, to)`: the state at `to` and the profit on the
    /// way, `from < to` (both finite: the engine steps within the horizon).
    fn advance(&mut self, state: &State, from: f64, to: f64) -> (State, f64) {
        let days = to - from;
        let cached = self.shared(state).step_profits.iter().find(|x| x.days == days);
        let profit = match cached {
            Some(cached) => cached.profit,
            None => {
                let profit = self.project(state, days);
                self.shared(state).step_profits.push(StepProfit { days, profit });
                profit
            }
        };
        (shifted(state, days, to), profit)
    }

    /// The cards dealt: a rarity by its odds, then `handSize` cards from it.
    fn hand(&mut self, state: &State, random: impl Fn(i32) -> f64) -> Hand {
        let pool = self.card_pool(state);
        let odds = self.rarity_odds(state);
        if odds.is_empty() {
            return Hand { pool, cards: Vec::new() };
        }
        let mut roll = random(0);
        let mut rarity = odds[odds.len() - 1].rarity;
        for option in odds.iter() {
            roll -= option.probability;
            if roll < 0.0 {
                rarity = option.rarity;
                break;
            }
        }
        let mut left: Vec<usize> = (0..pool.cards.0[rarity].len()).collect();
        let mut cards = Vec::with_capacity(CFG.hand_size as usize);
        let mut i = 0;
        while (i as f64) < CFG.hand_size {
            let at = (random(i + 1) * left.len() as f64).floor() as usize;
            if at < left.len() {
                cards.push(PoolPlace { rarity, index: left.remove(at) });
            }
            i += 1;
        }
        Hand { pool, cards }
    }
}

// --- The engine (EmployeeCareer.batch) ---

/// Running means and co-moments of every arm's career total, plus summed
/// cumulative profit by day for the chart. Mergeable (Chan et al.). Crosses
/// as `{ n, mean, m2, curve }`.
#[derive(Serialize, Deserialize)]
pub struct Stats {
    /// Careers sampled.
    #[serde(rename = "n")]
    pub count: f64,
    /// Per arm, the mean career total.
    pub mean: Vec<f64>,
    /// Per pair of arms, the summed products of their totals' deviations
    /// from the means: the second central co-moments, not yet divided.
    pub m2: Vec<Vec<f64>>,
    /// Per arm, the cumulative profit by day, summed over careers.
    pub curve: Vec<Vec<f64>>,
}

impl Stats {
    fn new(arms: usize, days: usize) -> Stats {
        Stats {
            count: 0.0,
            mean: vec![0.0; arms],
            m2: vec![vec![0.0; arms]; arms],
            curve: vec![vec![0.0; days]; arms],
        }
    }
    fn add(&mut self, totals: &[f64], paths: &[Vec<f64>]) {
        self.count += 1.0;
        let count = self.count;
        let before: Vec<f64> = totals.iter().zip(&self.mean).map(|(x, m)| x - m).collect();
        for (mean, deviation) in self.mean.iter_mut().zip(&before) {
            *mean += deviation / count;
        }
        for (row, deviation) in self.m2.iter_mut().zip(&before) {
            for ((m2, total), mean) in row.iter_mut().zip(totals).zip(&self.mean) {
                *m2 += deviation * (total - mean);
            }
        }
        for (curve, path) in self.curve.iter_mut().zip(paths) {
            for (c, &x) in curve.iter_mut().zip(path) {
                *c += x;
            }
        }
    }
}

/// `merge(a, b)` for two non-empty batches.
pub fn merge(a: &Stats, b: &Stats) -> Result<Stats, &'static str> {
    if a.mean.len() != b.mean.len()
        || a.curve.first().map(Vec::len) != b.curve.first().map(Vec::len)
    {
        return Err("Incompatible career batches");
    }
    let count = a.count + b.count;
    let d: Vec<f64> = b.mean.iter().zip(&a.mean).map(|(x, y)| x - y).collect();
    Ok(Stats {
        count,
        mean: a.mean.iter().enumerate().map(|(i, m)| m + d[i] * b.count / count).collect(),
        m2: a
            .m2
            .iter()
            .enumerate()
            .map(|(i, row)| {
                row.iter()
                    .enumerate()
                    .map(|(j, v)| v + b.m2[i][j] + d[i] * d[j] * a.count * b.count / count)
                    .collect()
            })
            .collect(),
        curve: a
            .curve
            .iter()
            .enumerate()
            .map(|(i, row)| row.iter().enumerate().map(|(t, v)| v + b.curve[i][t]).collect())
            .collect(),
    })
}

/// `careerCompare`'s result for arms i and j.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// Arm i's mean less arm j's.
    pub mean: f64,
    /// The difference's standard error; None (null) below 2 samples.
    pub standard_error: Option<f64>,
}

/// `compare(s, i, j)`: from the sample count, the two arms' means and the
/// co-moments `m2[i][i]`, `m2[j][j]` and `m2[i][j]`.
pub fn compare(
    count: f64,
    mean_i: f64,
    mean_j: f64,
    m2_ii: f64,
    m2_jj: f64,
    m2_ij: f64,
) -> Comparison {
    let mean = mean_i - mean_j;
    if count < 2.0 {
        return Comparison { mean, standard_error: None };
    }
    let variance = ((m2_ii + m2_jj - 2.0 * m2_ij) / (count - 1.0)).max(0.0);
    Comparison { mean, standard_error: Some((variance / count).sqrt()) }
}

/// One arm of one sampled career, in progress.
struct ArmCareer {
    state: State,
    time: f64,
    total: f64,
    step: i32,
    path: Vec<f64>,
}

/// A batch of sampled careers, run a few transitions at a time (`step`).
pub struct Batch {
    seed: i32,
    /// The first pair.
    pub start: f64,
    /// The pair after the last.
    end_pair: f64,
    /// The pair being run.
    current_pair: f64,
    /// The arm being run (an index into `Model::arms`).
    current_arm: usize,
    /// That arm's career, kept between `step` calls.
    arm_career: Option<ArmCareer>,
    /// The working days the careers run for.
    horizon: f64,
    /// The chart's days.
    days: usize,
    /// The current pair's totals and paths, by arm so far.
    totals: Vec<f64>,
    paths: Vec<Vec<f64>>,
    pub stats: Stats,
    pub decisions: f64,
    pub candidates: f64,
    pub transitions: f64,
    pub rerolls: f64,
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

impl Batch {
    pub fn new(model: &Model, seed: f64, start: f64, count: f64) -> Result<Batch, &'static str> {
        if !is_integer(count)
            || count < 1.0
            || !is_integer(seed)
            || !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&seed)
            || !is_integer(start)
            || start < 0.0
        {
            return Err("Invalid batch");
        }
        let horizon = model.horizon;
        let days = (horizon - EPSILON).ceil() as usize;
        Ok(Batch {
            seed: seed as i32,
            start,
            end_pair: start + count,
            current_pair: start,
            current_arm: 0,
            arm_career: None,
            horizon,
            days,
            totals: Vec::new(),
            paths: Vec::new(),
            stats: Stats::new(model.arms.len(), days),
            decisions: 0.0,
            candidates: 0.0,
            transitions: 0.0,
            rerolls: 0.0,
        })
    }

    pub fn completed(&self) -> f64 {
        self.current_pair - self.start
    }

    /// How far the batch has got.
    pub fn progress(&self) -> Progress {
        Progress {
            completed: self.completed(),
            decisions: self.decisions,
            candidates: self.candidates,
            transitions: self.transitions,
        }
    }

    #[inline]
    fn random(&self, step: i32, purpose: i32) -> f64 {
        random_from_int32s(self.seed, self.current_pair as i64 as i32, step, purpose)
    }

    /// Picks from a hand: the highest score, a Reroll worth more redraws.
    fn decide(
        &mut self,
        model: &mut Model,
        state: State,
        time: f64,
        step: i32,
        first_roll: u32,
    ) -> Result<State, &'static str> {
        self.decisions += 1.0;
        let mut roll = first_roll;
        loop {
            let hand = model.hand(&state, |purpose| self.random(step, 10 * roll as i32 + purpose));
            let mut best: Option<&Card> = None;
            let mut value = f64::NEG_INFINITY;
            for place in &hand.cards {
                let card = &hand.pool.cards.0[place.rarity][place.index].card;
                if card.kind == Kind::Reroll && roll >= MAX_REROLLS {
                    continue;
                }
                let key = hand.pool.keys[place.rarity][place.index].key;
                let Some(score) = model.score(&state, card, key, time) else {
                    continue;
                };
                if !score.is_finite() {
                    return Err("Non-finite policy score");
                }
                self.candidates += 1.0;
                if score > value {
                    value = score;
                    best = Some(card);
                }
            }
            let Some(best) = best else { return Ok(state) };
            if best.kind == Kind::Reroll {
                self.rerolls += 1.0;
                roll += 1;
                continue;
            }
            return model.apply(&state, best, self.random(step, 999));
        }
    }

    /// Runs up to `budget` transitions; true once the batch is done.
    pub fn step(&mut self, model: &mut Model, mut budget: u32) -> Result<bool, &'static str> {
        loop {
            let mut arm = match self.arm_career.take() {
                Some(arm) => arm,
                None => {
                    if self.current_pair >= self.end_pair {
                        return Ok(true);
                    }
                    let card = model.arms[self.current_arm].clone();
                    let mut state = model.subject.clone();
                    match &card {
                        Some(c) if c.kind == Kind::Reroll => {
                            state = self.decide(model, state, 0.0, 0, 1)?
                        }
                        Some(c) => state = model.apply(&state, c, self.random(0, 999))?,
                        None => {}
                    }
                    ArmCareer { state, time: 0.0, total: 0.0, step: 0, path: vec![0.0; self.days] }
                }
            };
            let horizon = self.horizon;
            while arm.time < horizon - EPSILON {
                if budget == 0 {
                    self.arm_career = Some(arm);
                    return Ok(false);
                }
                let opportunity = if arm.state.record.potential_left.is_some_and(|left| left > 0.0)
                {
                    snap(model.next(&arm.state, arm.time))
                } else {
                    f64::INFINITY
                };
                if opportunity <= arm.time {
                    return Err("Training opportunities must move forward");
                }
                let to = opportunity.min(snap((arm.time + EPSILON).floor() + 1.0)).min(horizon);
                let (state, profit) = model.advance(&arm.state, arm.time, to);
                if !profit.is_finite() {
                    return Err("Non-finite career profit");
                }
                arm.total += profit;
                arm.state = state;
                arm.time = to;
                self.transitions += 1.0;
                if (arm.time - arm.time.round()).abs() < EPSILON || arm.time >= horizon - EPSILON {
                    let day = (arm.time - EPSILON).ceil() - 1.0;
                    if day >= 0.0 && (day as usize) < arm.path.len() {
                        arm.path[day as usize] = arm.total;
                    }
                }
                if arm.time == opportunity
                    && arm.time < horizon - EPSILON
                    && arm.state.record.potential_left.is_some_and(|left| left > 0.0)
                {
                    arm.step += 1;
                    let cost = model.energy_cost(arm.time);
                    if !cost.is_finite() || cost < 0.0 {
                        return Err("Invalid energy cost");
                    }
                    if model.worth_training(&arm.state, cost) {
                        arm.total -= cost;
                        let trained = arm.state.trained();
                        arm.state = self.decide(model, trained, arm.time, arm.step, 0)?;
                    }
                }
                budget -= 1;
            }
            // Energy spent on the last day lands after its cumulative point.
            if self.days > 0 {
                arm.path[self.days - 1] = arm.total;
            }
            self.totals.push(arm.total);
            self.paths.push(arm.path);
            self.current_arm += 1;
            if self.current_arm == model.arms.len() {
                self.stats.add(&self.totals, &self.paths);
                self.totals.clear();
                self.paths.clear();
                self.current_arm = 0;
                self.current_pair += 1.0;
            }
        }
    }
}

/// The subject's first card, as `rules.apply(employee, card, draw)` takes it.
pub fn apply_first(model: &mut Model, card: &Card, draw: f64) -> Result<Outcome, &'static str> {
    let subject = model.subject.clone();
    model.pick(&subject, card, draw)
}
/// `rules.next(employee, time)`.
pub fn next_first(model: &mut Model, time: f64) -> f64 {
    let subject = model.subject.clone();
    model.next(&subject, time)
}

/// The subject's first step, as `rules.advance(employee, from, to)` takes
/// it: the profit on the way and the clocks and events at `to`. Crosses as
/// `{ profit, age, tenure, employedDays, productionEvents, happiness }`,
/// each event `{ delta, hours }` (hours left).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advanced {
    profit: f64,
    age: f64,
    tenure: f64,
    employed_days: f64,
    production_events: Vec<EventLeft>,
    happiness: Vec<EventLeft>,
}
/// A timed event and the hours it has left.
#[derive(Serialize)]
struct EventLeft {
    delta: f64,
    hours: f64,
}

/// `rules.advance(employee, from, to)` for the subject's first state; the
/// step must go forward, between finite times.
pub fn advance_first(model: &mut Model, from: f64, to: f64) -> Result<Advanced, &'static str> {
    if !(from.is_finite() && to.is_finite() && from < to) {
        return Err("A step must go forward between finite times.");
    }
    let subject = model.subject.clone();
    let (state, profit) = model.advance(&subject, from, to);
    let r = &state.record;
    let events = |list: &[TimedEvent]| {
        list.iter().map(|x| EventLeft { delta: x.delta, hours: x.hours_left }).collect()
    };
    Ok(Advanced {
        profit,
        age: r.age,
        tenure: r.tenure,
        employed_days: r.employed_days,
        production_events: events(&r.production_events),
        happiness: events(&r.happiness_events),
    })
}

/// The hand `rules.hand(employee, random)` deals the subject's first state,
/// or the state after the first card `taken` (its outcome by its draw),
/// when every draw is `draw`: its cards with their pool values.
pub fn hand_first(
    model: &mut Model,
    taken: Option<(&Card, f64)>,
    draw: f64,
) -> Result<Vec<rules::PoolCard>, &'static str> {
    let subject = model.subject.clone();
    let state = match taken {
        Some((card, pick)) => after(&subject, &model.pick(&subject, card, pick)?),
        None => subject,
    };
    let hand = model.hand(&state, |_| draw);
    Ok(hand.cards.iter().map(|p| hand.pool.cards.0[p.rarity][p.index].clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_in_unit_interval() {
        for (seed, pair, step, purpose) in [(1729, 0, 0, 0), (-7, 1, 2, 3), (i32::MAX, 100, 40, 10)]
        {
            let r = random_from_int32s(seed, pair, step, purpose);
            assert!((0.0..1.0).contains(&r));
        }
    }

    #[test]
    fn snapping() {
        assert_eq!(snap(2.0 + 1e-12), 2.0);
        assert_eq!(snap(2.5), 2.5);
        assert_eq!(snap(f64::INFINITY), f64::INFINITY);
    }
}
