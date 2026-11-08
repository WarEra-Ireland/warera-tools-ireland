//! The rules' inputs: an employee, a context with its situation, and a card.
//!
//! The facade (js/employee-core.js) hands over the plain objects, and they
//! are decoded here once into typed records with the defaults
//! (`DEFAULT_EMPLOYEE`, `DEFAULT_CONTEXT`, `DEFAULT_SITUATION`) applied, so
//! the rules read named fields and never see NaN. The decode rules:
//! - A number that is missing, undefined, null, NaN or infinite is unknown:
//!   it takes the default where the field has one, and is `None` otherwise.
//! - A value of the wrong kind (a string or a list where a number goes, a
//!   number where a list goes) is an input error.
//! - Strings count only when non-empty; flags are read by truthiness.
//! - Each struct's doc says what else its decode checks or clamps.

use crate::cards::Stat;
use crate::snapshot::Truthy;
use crate::traits::Trait;
use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::rc::Rc;

/// A finite number, or None.
pub(crate) fn known(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}
/// A non-empty string, or None.
fn text(value: Option<String>) -> Option<Rc<str>> {
    value.filter(|s| !s.is_empty()).map(Into::into)
}

/// A trait code: one the model knows, or another (kept, compared by name).
#[derive(Clone, PartialEq)]
pub enum Code {
    Known(Trait),
    Unknown(Rc<str>),
}

impl Code {
    pub fn of(s: &str) -> Code {
        Trait::from_code(s).map_or_else(|| Code::Unknown(s.into()), Code::Known)
    }
    pub fn known(&self) -> Option<Trait> {
        match self {
            Code::Known(t) => Some(*t),
            Code::Unknown(_) => None,
        }
    }
    pub fn is(&self, t: Trait) -> bool {
        matches!(self, Code::Known(x) if *x == t)
    }
    pub fn as_str(&self) -> &str {
        match self {
            Code::Known(t) => t.code(),
            Code::Unknown(s) => s,
        }
    }
}
impl<'de> Deserialize<'de> for Code {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Code::of(&String::deserialize(d)?))
    }
}
impl Serialize for Code {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// A held trait `{ code, arg }`: the code is required, `arg` is a non-empty
/// string or none.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "HeldInput")]
pub struct Held {
    pub code: Code,
    pub arg: Option<Rc<str>>,
}

#[derive(Deserialize)]
struct HeldInput {
    code: Code,
    arg: Option<String>,
}
impl From<HeldInput> for Held {
    fn from(input: HeldInput) -> Held {
        Held { code: input.code, arg: text(input.arg) }
    }
}

/// One of `productionEvents`: a bonus change for a while, `{ delta, hours }`.
#[derive(Clone, Copy, PartialEq, Serialize)]
pub struct ProductionEvent {
    /// The change, in %.
    pub delta: f64,
    #[serde(rename = "hours")]
    pub hours_left: f64,
}

/// An employee as the rules read it. Decoded with `DEFAULT_EMPLOYEE` for
/// what is unknown (see the module doc); an event without a known delta and
/// hours is left out. A working life needn't be whole days: trait values
/// count the whole days in it. It serializes to the object it decodes from.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "EmployeeInput", rename_all = "camelCase")]
pub struct RulesEmployee {
    pub age: f64,
    /// The game's days to retirement; the age gives them when unknown.
    pub retire_in_days: Option<f64>,
    /// Hired plus trained Production (the API's `base`).
    pub production: f64,
    /// The flat Production of the employee's own traits.
    pub trait_production: f64,
    /// The rest of their Production (Rival, Mentor, coworkers' effects).
    pub extra_production: f64,
    pub responsibility: f64,
    pub luck: f64,
    /// Today's production bonus, as a fraction.
    pub bonus: f64,
    /// Days of specialization on the good.
    pub specialization: f64,
    /// The wage per paid point, over the PP's value.
    pub wage_expectation: f64,
    pub happiness_loss: f64,
    /// Today's happiness; unknown happiness isn't capped.
    pub happiness: Option<f64>,
    pub potential_left: f64,
    pub potential_max: Option<f64>,
    /// Trainings a day; unknown, or 0 or less, is the default 1.
    pub trainings_per_day: f64,
    /// The hourly wage, in money.
    pub wage: Option<f64>,
    /// The base wage expectation Negotiation applies to.
    pub negotiation_expectation: Option<f64>,
    /// Climber's next raise as the game reports it; None when unknown or
    /// not reported (the game shows 0), and then worked out from the
    /// Production.
    pub climber_raise: Option<f64>,
    #[serde(rename = "productionEvents")]
    pub events: Rc<[ProductionEvent]>,
    /// None when the traits aren't known (a coworker's, say).
    pub traits: Option<Rc<[Held]>>,
    pub nationality: Option<Rc<str>>,
}

impl Default for RulesEmployee {
    /// `DEFAULT_EMPLOYEE`.
    fn default() -> RulesEmployee {
        RulesEmployee {
            age: 30.0,
            retire_in_days: None,
            production: 3.0,
            trait_production: 0.0,
            extra_production: 0.0,
            responsibility: 2.0,
            luck: 2.0,
            bonus: 0.24,
            specialization: 20.0,
            wage_expectation: 1.0,
            happiness_loss: 10.0,
            happiness: None,
            potential_left: 3.0,
            potential_max: None,
            trainings_per_day: 1.0,
            wage: None,
            negotiation_expectation: None,
            climber_raise: None,
            events: Rc::new([]),
            traits: None,
            nationality: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeeInput {
    age: Option<f64>,
    retire_in_days: Option<f64>,
    production: Option<f64>,
    trait_production: Option<f64>,
    extra_production: Option<f64>,
    responsibility: Option<f64>,
    luck: Option<f64>,
    bonus: Option<f64>,
    specialization: Option<f64>,
    wage_expectation: Option<f64>,
    happiness_loss: Option<f64>,
    happiness: Option<f64>,
    potential_left: Option<f64>,
    potential_max: Option<f64>,
    trainings_per_day: Option<f64>,
    wage: Option<f64>,
    negotiation_expectation: Option<f64>,
    climber_raise: Option<f64>,
    production_events: Option<Vec<EventInput>>,
    traits: Option<Vec<Held>>,
    nationality: Option<String>,
}

#[derive(Deserialize)]
struct EventInput {
    delta: Option<f64>,
    hours: Option<f64>,
}

impl From<EmployeeInput> for RulesEmployee {
    fn from(input: EmployeeInput) -> RulesEmployee {
        let d = RulesEmployee::default();
        let or = |value: Option<f64>, default: f64| known(value).unwrap_or(default);
        RulesEmployee {
            age: or(input.age, d.age),
            retire_in_days: known(input.retire_in_days),
            production: or(input.production, d.production),
            trait_production: or(input.trait_production, d.trait_production),
            extra_production: or(input.extra_production, d.extra_production),
            responsibility: or(input.responsibility, d.responsibility),
            luck: or(input.luck, d.luck),
            bonus: or(input.bonus, d.bonus),
            specialization: or(input.specialization, d.specialization),
            wage_expectation: or(input.wage_expectation, d.wage_expectation),
            happiness_loss: or(input.happiness_loss, d.happiness_loss),
            happiness: known(input.happiness),
            potential_left: or(input.potential_left, d.potential_left),
            potential_max: known(input.potential_max),
            trainings_per_day: known(input.trainings_per_day)
                .filter(|&n| n > 0.0)
                .unwrap_or(d.trainings_per_day),
            wage: known(input.wage),
            negotiation_expectation: known(input.negotiation_expectation),
            climber_raise: known(input.climber_raise).filter(|&raise| raise != 0.0),
            events: input
                .production_events
                .unwrap_or_default()
                .into_iter()
                .filter_map(|event| {
                    Some(ProductionEvent {
                        delta: known(event.delta)?,
                        hours_left: known(event.hours)?,
                    })
                })
                .collect(),
            traits: input.traits.map(Into::into),
            nationality: text(input.nationality),
        }
    }
}

impl RulesEmployee {
    /// The traits, none when unknown.
    pub fn traits(&self) -> &[Held] {
        self.traits.as_deref().unwrap_or(&[])
    }
    pub fn holds(&self, t: Trait) -> bool {
        self.traits().iter().any(|h| h.code.is(t))
    }
    pub fn with_traits(&self, traits: Vec<Held>) -> RulesEmployee {
        RulesEmployee { traits: Some(traits.into()), ..self.clone() }
    }
    /// A trainable stat.
    pub fn stat(&self, stat: Stat) -> f64 {
        match stat {
            Stat::Production => self.production,
            Stat::Responsibility => self.responsibility,
            Stat::Luck => self.luck,
        }
    }
    pub fn set_stat(&mut self, stat: Stat, value: f64) {
        match stat {
            Stat::Production => self.production = value,
            Stat::Responsibility => self.responsibility = value,
            Stat::Luck => self.luck = value,
        }
    }
}

/// `ctx.energyValue`: what 10 energy earns elsewhere, a number or a list by
/// day (the last entry holds after it).
#[derive(Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Energy {
    Number(f64),
    List(Rc<[f64]>),
}

/// A number, or a list of numbers; an unknown one is 0.
impl<'de> Deserialize<'de> for Energy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EnergyVisitor;
        impl<'de> Visitor<'de> for EnergyVisitor {
            type Value = Energy;
            fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
                formatter.write_str("a number or a list of numbers")
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Energy, E> {
                Ok(Energy::Number(known(Some(v)).unwrap_or(0.0)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Energy, E> {
                self.visit_f64(v as f64)
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Energy, E> {
                self.visit_f64(v as f64)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Energy, A::Error> {
                let mut list = Vec::new();
                while let Some(v) = seq.next_element::<Option<f64>>()? {
                    list.push(known(v).unwrap_or(0.0));
                }
                Ok(Energy::List(list.into()))
            }
        }
        deserializer.deserialize_any(EnergyVisitor)
    }
}

/// A context as the rules read it: the company's and the market's numbers
/// and the employee's situation. Decoded with `DEFAULT_CONTEXT` for what is
/// unknown; `futureTraining` is a flag that only `false` turns off. It
/// serializes to the object it decodes from.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "ContextInput", rename_all = "camelCase")]
pub struct Context {
    /// What the product earns per point, over the PP's value.
    pub sell_ratio: f64,
    /// A toolbox's value, in PP.
    pub toolbox_value: f64,
    pub management: f64,
    /// A coworker's output in PP, if known.
    pub coworker_output: Option<f64>,
    /// The PP's money value, if known (above 0).
    pub pp_value: Option<f64>,
    #[serde(rename = "energyValue")]
    pub energy: Energy,
    /// Whether the employee will train again (the Luck forecast).
    pub future_training: bool,
    pub situation: Rc<Situation>,
}

impl Default for Context {
    /// `DEFAULT_CONTEXT`, in `DEFAULT_SITUATION`.
    fn default() -> Context {
        Context {
            sell_ratio: 1.0,
            toolbox_value: 0.0,
            management: 0.0,
            coworker_output: None,
            pp_value: None,
            energy: Energy::Number(0.0),
            future_training: true,
            situation: Rc::new(Situation::default()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextInput {
    sell_ratio: Option<f64>,
    toolbox_value: Option<f64>,
    management: Option<f64>,
    coworker_output: Option<f64>,
    pp_value: Option<f64>,
    energy_value: Option<Energy>,
    future_training: Option<bool>,
    situation: Option<Situation>,
}

impl From<ContextInput> for Context {
    fn from(input: ContextInput) -> Context {
        let d = Context::default();
        Context {
            sell_ratio: known(input.sell_ratio).unwrap_or(d.sell_ratio),
            toolbox_value: known(input.toolbox_value).unwrap_or(d.toolbox_value),
            management: known(input.management).unwrap_or(d.management),
            coworker_output: known(input.coworker_output),
            pp_value: known(input.pp_value).filter(|&v| v > 0.0),
            energy: input.energy_value.unwrap_or(d.energy),
            future_training: input.future_training != Some(false),
            situation: input.situation.map_or(d.situation, Rc::new),
        }
    }
}

impl Context {
    /// The context with the situation's gender set.
    pub fn with_gender(&self, gender: &str) -> Context {
        let mut situation = (*self.situation).clone();
        situation.gender = Some(gender.into());
        Context { situation: Rc::new(situation), ..self.clone() }
    }
}

/// What `workingDays` reads of an employee: `{ retireInDays, age }`. Days
/// left come from `retireInDays` when it is known, else from the age.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingLife {
    retire_in_days: Option<f64>,
    age: Option<f64>,
}

impl WorkingLife {
    /// Days left to retirement, never below 0; None without either number.
    pub fn days(&self) -> Option<f64> {
        known(self.retire_in_days)
            .or_else(|| known(self.age).map(|age| crate::cfg::CFG.retire_age - age))
            .map(|days| days.max(0.0))
    }
}

/// What `paidProduction` reads of an employee: `{ production,
/// traitProduction }`, their hired and trained Production and their own
/// traits' (unknown is 0).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnProduction {
    production: Option<f64>,
    trait_production: Option<f64>,
}

impl OwnProduction {
    /// The Production the wage is paid on; None when `production` is unknown.
    pub fn paid(&self) -> Option<f64> {
        known(self.production).map(|production| {
            crate::project::paid_production(production, known(self.trait_production).unwrap_or(0.0))
        })
    }
}

/// Where the employee works and among whom. Decoded with
/// `DEFAULT_SITUATION` for what is unknown (an empty string is no value, so
/// `gender: ''` is an unknown gender, where a missing one is the default's).
/// It serializes to the object it decodes from: no text is `''`.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "SituationInput", rename_all = "camelCase")]
pub struct Situation {
    #[serde(serialize_with = "text_or_empty")]
    pub gender: Option<Rc<str>>,
    pub engine_daily_prod: f64,
    pub engine_bonus: f64,
    pub coworkers: f64,
    pub female_coworkers: f64,
    /// Whether a coworker shares the nationality; unknown is worked out
    /// from the counts.
    pub same_nationality_coworkers: Option<bool>,
    pub home_core: Option<bool>,
    pub other_nationalities: f64,
    pub stronger_coworker: bool,
    pub weaker_coworker: bool,
    /// How many coworkers are weaker: set with the known coworkers' standing.
    #[serde(skip)]
    pub weaker_count: f64,
    /// The known coworkers.
    pub peers: Option<Rc<[Peer]>>,
    /// The coworkers as employees in their contexts, for what a card does
    /// to their traits.
    pub coworker_models: Option<Rc<[Coworker]>>,
    pub coworker_ids: Rc<[Rc<str>]>,
    pub better_paid: f64,
    pub coworker_happiness: Option<f64>,
    #[serde(serialize_with = "text_or_empty")]
    pub place: Option<Rc<str>>,
    #[serde(serialize_with = "text_or_empty")]
    pub item_type: Option<Rc<str>>,
    #[serde(serialize_with = "text_or_empty")]
    pub product: Option<Rc<str>>,
    pub income_tax: f64,
    pub tenure_days: f64,
    pub employed_days: f64,
    pub has_tool: bool,
    pub small_storage: bool,
    pub storage_full: bool,
    #[serde(serialize_with = "text_or_empty")]
    pub nationality: Option<Rc<str>>,
}

/// A situation's text, `''` for none: a missing one would decode as the
/// default's.
fn text_or_empty<S: Serializer>(value: &Option<Rc<str>>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(value.as_deref().unwrap_or(""))
}

impl Default for Situation {
    /// `DEFAULT_SITUATION`.
    fn default() -> Situation {
        Situation {
            gender: Some("male".into()),
            engine_daily_prod: 0.0,
            engine_bonus: 0.0,
            coworkers: 2.0,
            female_coworkers: 1.0,
            same_nationality_coworkers: None,
            home_core: None,
            other_nationalities: 0.0,
            stronger_coworker: true,
            weaker_coworker: true,
            weaker_count: 0.0,
            peers: None,
            coworker_models: None,
            coworker_ids: Rc::new([]),
            better_paid: 0.0,
            coworker_happiness: None,
            place: Some("homeCore".into()),
            item_type: Some("product".into()),
            product: None,
            income_tax: 0.0,
            tenure_days: 0.0,
            employed_days: 0.0,
            has_tool: false,
            small_storage: false,
            storage_full: false,
            nationality: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SituationInput {
    gender: Option<String>,
    engine_daily_prod: Option<f64>,
    engine_bonus: Option<f64>,
    coworkers: Option<f64>,
    female_coworkers: Option<f64>,
    same_nationality_coworkers: Option<Truthy>,
    home_core: Option<Truthy>,
    other_nationalities: Option<f64>,
    stronger_coworker: Option<Truthy>,
    weaker_coworker: Option<Truthy>,
    peers: Option<Vec<Peer>>,
    coworker_models: Option<Vec<Coworker>>,
    coworker_ids: Option<Vec<String>>,
    better_paid: Option<f64>,
    coworker_happiness: Option<f64>,
    place: Option<String>,
    item_type: Option<String>,
    product: Option<String>,
    income_tax: Option<f64>,
    tenure_days: Option<f64>,
    employed_days: Option<f64>,
    has_tool: Option<Truthy>,
    small_storage: Option<Truthy>,
    storage_full: Option<Truthy>,
    nationality: Option<String>,
}

impl From<SituationInput> for Situation {
    fn from(input: SituationInput) -> Situation {
        let d = Situation::default();
        let number = |value: Option<f64>, default: f64| known(value).unwrap_or(default);
        let string = |value: Option<String>, default: Option<Rc<str>>| match value {
            None => default,
            Some(s) => text(Some(s)),
        };
        let flag = |value: Option<Truthy>, default: bool| value.map_or(default, |t| t.0);
        Situation {
            gender: string(input.gender, d.gender),
            engine_daily_prod: number(input.engine_daily_prod, d.engine_daily_prod),
            engine_bonus: number(input.engine_bonus, d.engine_bonus),
            coworkers: number(input.coworkers, d.coworkers),
            female_coworkers: number(input.female_coworkers, d.female_coworkers),
            same_nationality_coworkers: input.same_nationality_coworkers.map(|t| t.0),
            home_core: input.home_core.map(|t| t.0),
            other_nationalities: number(input.other_nationalities, d.other_nationalities),
            stronger_coworker: flag(input.stronger_coworker, d.stronger_coworker),
            weaker_coworker: flag(input.weaker_coworker, d.weaker_coworker),
            weaker_count: d.weaker_count,
            peers: input.peers.map(Into::into),
            coworker_models: input.coworker_models.map(Into::into),
            coworker_ids: input
                .coworker_ids
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
            better_paid: number(input.better_paid, d.better_paid),
            coworker_happiness: known(input.coworker_happiness),
            place: string(input.place, d.place),
            item_type: string(input.item_type, d.item_type),
            product: string(input.product, d.product),
            income_tax: number(input.income_tax, d.income_tax),
            tenure_days: number(input.tenure_days, d.tenure_days),
            employed_days: number(input.employed_days, d.employed_days),
            has_tool: flag(input.has_tool, d.has_tool),
            small_storage: flag(input.small_storage, d.small_storage),
            storage_full: flag(input.storage_full, d.storage_full),
            nationality: string(input.nationality, d.nationality),
        }
    }
}

/// `DEFAULT_SITUATION` as the facade gets it (`Situation::default` is the same,
/// as the rules read it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSituation {
    gender: &'static str,
    engine_daily_prod: f64,
    engine_bonus: f64,
    coworkers: f64,
    female_coworkers: f64,
    same_nationality_coworkers: Option<f64>,
    home_core: Option<bool>,
    other_nationalities: f64,
    stronger_coworker: bool,
    weaker_coworker: bool,
    peers: Option<()>,
    coworker_models: Option<()>,
    coworker_ids: [(); 0],
    better_paid: f64,
    coworker_happiness: Option<f64>,
    place: &'static str,
    item_type: &'static str,
    product: Option<&'static str>,
    income_tax: f64,
    tenure_days: f64,
    employed_days: f64,
    has_tool: bool,
    small_storage: bool,
    storage_full: bool,
}
pub const DEFAULT_SITUATION: DefaultSituation = DefaultSituation {
    gender: "male",
    engine_daily_prod: 0.0,
    engine_bonus: 0.0,
    coworkers: 2.0,
    female_coworkers: 1.0,
    same_nationality_coworkers: None,
    home_core: None,
    other_nationalities: 0.0,
    stronger_coworker: true,
    weaker_coworker: true,
    peers: None,
    coworker_models: None,
    coworker_ids: [],
    better_paid: 0.0,
    coworker_happiness: None,
    place: "homeCore",
    item_type: "product",
    product: None,
    income_tax: 0.0,
    tenure_days: 0.0,
    employed_days: 0.0,
    has_tool: false,
    small_storage: false,
    storage_full: false,
};

/// A known coworker: `{ production, wagePP, model?, situation?, self? }`.
/// One without a model needs a known Production (an input error otherwise);
/// with a model, the model gives their Production.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(try_from = "PeerInput")]
pub struct Peer {
    /// Their Production as Rival and Mentor compare it, when there is no model.
    pub production: f64,
    /// Their hourly wage in PP, if known.
    #[serde(rename = "wagePP")]
    pub wage_pp: Option<f64>,
    pub model: Option<Rc<RulesEmployee>>,
    pub situation: Option<Rc<Situation>>,
    /// The employee priced, among a coworker's peers.
    #[serde(rename = "self")]
    pub is_self: bool,
}

#[derive(Deserialize)]
struct PeerInput {
    production: Option<f64>,
    #[serde(rename = "wagePP")]
    wage_pp: Option<f64>,
    model: Option<Rc<RulesEmployee>>,
    situation: Option<Rc<Situation>>,
    #[serde(default, rename = "self")]
    is_self: Truthy,
}

impl TryFrom<PeerInput> for Peer {
    type Error = &'static str;
    fn try_from(input: PeerInput) -> Result<Peer, &'static str> {
        let production = match (known(input.production), &input.model) {
            (Some(production), _) => production,
            (None, Some(_)) => 0.0,
            (None, None) => return Err("A coworker needs a model or a known production."),
        };
        Ok(Peer {
            production,
            wage_pp: known(input.wage_pp),
            model: input.model,
            situation: input.situation,
            is_self: input.is_self.0,
        })
    }
}

/// A coworker as `{ e, ctx }` (situation.coworkerModels): the employee is
/// required, the context defaults.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "CoworkerInput")]
pub struct Coworker {
    #[serde(rename = "e")]
    pub employee: Rc<RulesEmployee>,
    #[serde(rename = "ctx")]
    pub context: Rc<Context>,
}

#[derive(Deserialize)]
struct CoworkerInput {
    e: RulesEmployee,
    ctx: Option<Context>,
}
impl From<CoworkerInput> for Coworker {
    fn from(input: CoworkerInput) -> Coworker {
        Coworker { employee: Rc::new(input.e), context: Rc::new(input.ctx.unwrap_or_default()) }
    }
}

/// A card kind.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Drill,
    Negotiation,
    SecondWind,
    Reroll,
    Habit,
    HabitPair,
    Rehab,
    RehabAll,
    WildCard,
    Mentoring,
    RemoveTrait,
    Other,
}

impl Kind {
    pub fn of(s: &str) -> Kind {
        match s {
            "drill" => Kind::Drill,
            "negotiation" => Kind::Negotiation,
            "secondWind" => Kind::SecondWind,
            "reroll" => Kind::Reroll,
            "habit" => Kind::Habit,
            "habitPair" => Kind::HabitPair,
            "rehab" => Kind::Rehab,
            "rehabAll" => Kind::RehabAll,
            "wildCard" => Kind::WildCard,
            "mentoring" => Kind::Mentoring,
            "removeTrait" => Kind::RemoveTrait,
            _ => Kind::Other,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Kind::Drill => "drill",
            Kind::Negotiation => "negotiation",
            Kind::SecondWind => "secondWind",
            Kind::Reroll => "reroll",
            Kind::Habit => "habit",
            Kind::HabitPair => "habitPair",
            Kind::Rehab => "rehab",
            Kind::RehabAll => "rehabAll",
            Kind::WildCard => "wildCard",
            Kind::Mentoring => "mentoring",
            Kind::RemoveTrait => "removeTrait",
            Kind::Other => "other",
        }
    }
}

/// A training card (or the chart's `removeTrait`). A drill has a known stat
/// and a delta, Negotiation a drop, Second Wind a gain and a Production
/// trait card a delta: a card without its numbers is an input error. The
/// numbers a kind doesn't have are 0. A trait card's code may be unknown;
/// an empty one is none (`code`, `to`) or left out (`codes`).
#[derive(Clone, PartialEq, Deserialize)]
#[serde(try_from = "CardInput")]
pub struct Card {
    pub kind: Kind,
    pub stat: Option<Stat>,
    pub delta: f64,
    pub drop: f64,
    /// Trainings Second Wind adds: only a whole number is taken.
    pub gain: f64,
    pub code: Option<Code>,
    pub codes: Option<Rc<[Code]>>,
    pub to: Option<Code>,
    pub arg: Option<Rc<str>>,
}

#[derive(Deserialize)]
struct CardInput {
    card: String,
    stat: Option<String>,
    delta: Option<f64>,
    drop: Option<f64>,
    gain: Option<f64>,
    code: Option<String>,
    codes: Option<Vec<String>>,
    to: Option<String>,
    arg: Option<String>,
}

impl TryFrom<CardInput> for Card {
    type Error = &'static str;
    fn try_from(c: CardInput) -> Result<Card, &'static str> {
        let kind = Kind::of(&c.card);
        let code = |s: Option<String>| s.filter(|s| !s.is_empty()).map(|s| Code::of(&s));
        let stat = c.stat.as_deref().and_then(Stat::of);
        let number = |value: Option<f64>, needed: bool, error: &'static str| match known(value) {
            Some(v) => Ok(v),
            None if needed => Err(error),
            None => Ok(0.0),
        };
        if kind == Kind::Drill && stat.is_none() {
            return Err("A drill needs a stat (production, responsibility or luck).");
        }
        Ok(Card {
            kind,
            stat,
            delta: number(c.delta, kind == Kind::Drill, "A drill needs a delta.")?,
            drop: number(c.drop, kind == Kind::Negotiation, "A negotiation needs a drop.")?,
            gain: number(c.gain, kind == Kind::SecondWind, "A Second Wind needs a gain.")?,
            code: code(c.code),
            codes: c
                .codes
                .map(|codes| codes.iter().filter(|s| !s.is_empty()).map(|s| Code::of(s)).collect()),
            to: code(c.to),
            arg: text(c.arg),
        })
    }
}

impl Card {
    pub const fn new(kind: Kind) -> Card {
        Card {
            kind,
            stat: None,
            delta: 0.0,
            drop: 0.0,
            gain: 0.0,
            code: None,
            codes: None,
            to: None,
            arg: None,
        }
    }
    pub fn drill(stat: Stat, delta: f64) -> Card {
        Card { stat: Some(stat), delta, ..Card::new(Kind::Drill) }
    }
    pub fn with_code(kind: Kind, code: Code) -> Card {
        Card { code: Some(code), ..Card::new(kind) }
    }
    /// The fields of the card object the facade gets, in its key order.
    pub fn entries<M: SerializeMap>(&self, map: &mut M) -> Result<(), M::Error> {
        map.serialize_entry("card", self.kind.name())?;
        match self.kind {
            Kind::Drill => {
                map.serialize_entry("stat", &self.stat)?;
                map.serialize_entry("delta", &self.delta)?;
            }
            Kind::Negotiation => map.serialize_entry("drop", &self.drop)?,
            Kind::SecondWind => map.serialize_entry("gain", &self.gain)?,
            Kind::Habit | Kind::Rehab | Kind::RemoveTrait => {
                map.serialize_entry("code", &self.code)?
            }
            Kind::HabitPair => map.serialize_entry("codes", &self.codes.as_deref())?,
            Kind::Mentoring => {
                map.serialize_entry("code", &self.code)?;
                map.serialize_entry("to", &self.to)?;
            }
            _ => {}
        }
        Ok(())
    }
}
impl Serialize for Card {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        self.entries(&mut map)?;
        map.end()
    }
}

impl From<&crate::cards::Card> for Card {
    fn from(c: &crate::cards::Card) -> Card {
        match *c {
            crate::cards::Card::Drill { stat, delta } => Card::drill(stat, delta),
            crate::cards::Card::Negotiation { drop } => {
                Card { drop, ..Card::new(Kind::Negotiation) }
            }
            crate::cards::Card::SecondWind { gain } => Card { gain, ..Card::new(Kind::SecondWind) },
        }
    }
}
