//! The planner snapshot (`snapshotOf` in js/employee-assignments.js), decoded
//! once into the model's records behind the `Snapshot` handle.
//!
//! Every session (`Recommend`, `CardSession`, `RetentionSession`,
//! `KeepSession`, `Career`) and one-shot call (`evaluate`, `validate`, `uncertainty`, ...) builds what
//! it reads from these records in Rust: the planner's `Plan`, card pricing's
//! `Roster`, the career's members. Strings are interned here
//! (`project::intern`), so the facade hands over the plain object.
//!
//! What an unknown number (missing, null, NaN or infinite) means is decided
//! here:
//! - one that only adds to something (management and the owner's
//!   Management bonus, toolbox value and training quota; a company's engine
//!   output, engine bonus, bonus and manager's bonus; a switch's cost; a
//!   tool's bonus; an employee's trait Production, Luck, Climber raise and
//!   the happiness a newcomer shares; days saved on a good; a rarity's
//!   training value) is 0;
//! - one that may be unknown is `None`: the PP value, the hours, days to
//!   retirement, trainings left, potential, the game's reported figures and
//!   wage expectation, the happiness lost over the working life, storage,
//!   and recruiting's values (unless all four are known); hours since a
//!   move or a switch are infinite (never); a timed event without its
//!   numbers is left out;
//! - the numbers `validate` requires (days; a company's margin, tax and
//!   capacity; an employee's age, production, responsibility, wage,
//!   tenure and employed days; a tool's hours) are NaN, which `validate`
//!   reports from the facts kept beside them (`valid_numbers`,
//!   `EmployeeCheck`). No export plans with one: they check first
//!   (`check::numbers_known`, `planned_period`);
//! - a company's tax happiness loss is the rule's for its tax
//!   (`cfg::tax_happiness_loss`).
//!
//! Lists, flags and objects the hand-built test snapshots leave out read as
//! empty, false or absent.

use crate::cfg;
use crate::check::{
    COMPANY_BONUS, COMPANY_CAPACITY, COMPANY_MARGIN, COMPANY_TAX, EmployeeCheck, TraitCheck,
};
use crate::model::{Code, Held, known};
use crate::project::{
    self, CompanyRecord, EmployeeRecord, TimedEvent, TraitRecord, intern, intern_optional, string,
    truthy_string,
};
use crate::traits::{Trait, TraitSet};
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::rc::Rc;

/// The decoded snapshot.
#[derive(Clone)]
pub struct Snapshot {
    /// `s.days`, and whether it is a whole number (`Number.isInteger`).
    pub days: f64,
    pub days_integer: bool,
    /// `s.hours`: the projections' length when known (else `days * 24`).
    pub hours: Option<f64>,
    pub training_quota: f64,
    pub management: f64,
    /// The owner's Management bonus, %, as any of their employees gets it.
    pub management_pct: f64,
    pub toolbox_value: f64,
    /// The PP's money value (`ppValue`), set by the page; above 0 when known.
    pub pp_value: Option<f64>,
    pub companies: Vec<Company>,
    pub employees: Vec<Employee>,
    pub tools: Vec<Tool>,
}

/// A company: the record the projection reads and what the planner looks
/// up besides.
#[derive(Clone)]
pub struct Company {
    pub record: CompanyRecord,
    /// `c.type`, interned.
    pub item_type: u32,
    /// Not planned (`c.excluded` holds the reason): its roster and tools stay.
    pub excluded: bool,
    pub capacity: f64,
    /// Hours since it was re-tooled: infinite if it never was (or it isn't
    /// known).
    pub switched_age_hours: f64,
    /// `c.switch.from` and `c.switch.fromType`, interned (0 without a switch).
    pub switch_from: u32,
    pub switch_from_type: u32,
    /// `!!c.id`.
    pub has_id: bool,
    /// `Number.isFinite` of margin, bonus and tax and
    /// `Number.isInteger(c.capacity)`, as `check::COMPANY_*` bits.
    pub valid_numbers: u8,
    /// The manager's bonus, %, which a company without employees gets.
    pub manager_pct: f64,
}

/// An employee: the record the projection reads and what the planner and
/// card pricing look up besides.
#[derive(Clone)]
pub struct Employee {
    pub record: EmployeeRecord,
    /// `e.gender` (the career's situation).
    pub gender: Option<Rc<str>>,
    /// Pinned by the user.
    pub locked: bool,
    /// `e.equipped?.id`, interned (0 for none).
    pub equipped: u32,
    /// `e.specializations` in key order (good, saved days); None without it.
    pub specializations: Option<Vec<SavedDays>>,
    /// What the game reports, if `e.observed` is set.
    pub observed: Option<Observed>,
    pub check: EmployeeCheck,
    /// Every trait as the rules read it, hidden ones included, and the ones
    /// they show.
    pub held: Rc<[Held]>,
    pub shown: Rc<[Held]>,
    pub potential_max: Option<f64>,
    /// The wage expectation the game reports (the API's `wageExpectation`).
    pub negotiation_expectation: Option<f64>,
    /// Happiness points they lose, averaged over the working life
    /// (`lifeLoss`, rounded), and the lasting losses a newcomer shares.
    pub life_loss: Option<f64>,
    pub shared_loss: f64,
    /// A drawn hand waits for its card.
    pub pending_training: bool,
    /// Their equipped tool has capacity left.
    pub has_tool: bool,
}

/// The game's reported figures for an employee, each when known.
#[derive(Clone, Copy)]
pub struct Observed {
    pub production: Option<f64>,
    pub responsibility: Option<f64>,
    pub happiness: Option<f64>,
    pub bonus: Option<f64>,
    pub output: Option<f64>,
}

/// Days an employee saved on a good (an entry of `e.specializations`).
#[derive(Clone, Copy)]
pub struct SavedDays {
    /// The good, interned.
    pub product: u32,
    pub days: f64,
}

/// An equipped (`holder` set) or spare tool.
#[derive(Clone)]
pub struct Tool {
    /// `t.id`, interned (0 undefined).
    pub id: u32,
    pub tool: project::Tool,
    /// `t.holder`, interned; 0 when falsy.
    pub holder: u32,
}

impl Snapshot {
    /// Decodes `snapshotOf(...).snapshot` (or a hand-built one); throws on a
    /// shape it can't read.
    pub fn decode(value: wasm_bindgen::JsValue) -> Result<Snapshot, serde_wasm_bindgen::Error> {
        let input: SnapshotInput = serde_wasm_bindgen::from_value(value)?;
        Ok(Snapshot::from(input))
    }

    /// The first company with id `id`, if any.
    pub fn first_company(&self, id: u32) -> Option<usize> {
        self.companies.iter().position(|c| c.record.id == id)
    }
    /// The last employee with id `id`, if any.
    pub fn last_employee(&self, id: u32) -> Option<usize> {
        self.employees.iter().rposition(|e| e.record.id == id)
    }
    /// The first employee with id `id`, if any.
    pub fn first_employee(&self, id: u32) -> Option<usize> {
        self.employees.iter().position(|e| e.record.id == id)
    }
    /// The last tool with id `id`, if any.
    pub fn last_tool(&self, id: u32) -> Option<usize> {
        self.tools.iter().rposition(|t| t.id == id)
    }
    /// The first tool with id `id`, if any.
    pub fn first_tool(&self, id: u32) -> Option<usize> {
        self.tools.iter().position(|t| t.id == id)
    }

    /// Employee `e`'s known traits.
    pub fn trait_set(&self, e: usize) -> TraitSet {
        self.employees[e]
            .record
            .traits
            .iter()
            .filter_map(|t| t.id)
            .fold(TraitSet::EMPTY, TraitSet::with)
    }
}

impl Employee {
    /// `e.specializations[product]` if set (`Object.hasOwn`).
    pub fn saved_days(&self, product: u32) -> Option<f64> {
        self.specializations.as_ref()?.iter().rev().find(|s| s.product == product).map(|s| s.days)
    }
}

// --- The input, as the facade hands it over ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    companies: Vec<CompanyInput>,
    employees: Vec<EmployeeInput>,
    #[serde(default)]
    tools: Option<Vec<ToolInput>>,
    days: Option<f64>,
    hours: Option<f64>,
    toolbox_value: Option<f64>,
    training_quota: Option<f64>,
    management: Option<f64>,
    management_pct: Option<f64>,
    #[serde(rename = "ppValue")]
    pp_value: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanyInput {
    id: Option<String>,
    product: Option<String>,
    /// 'raw' | 'product' | 'weapon'
    #[serde(rename = "type")]
    item_type: Option<String>,
    /// What its good earns per point of production (`perPP`).
    margin: Option<f64>,
    #[serde(default)]
    disabled: Truthy,
    engine_daily_prod: Option<f64>,
    engine_bonus: Option<f64>,
    /// Management, manager and core-region bonus, %; null when it didn't load.
    bonus: Option<f64>,
    tax: Option<f64>,
    /// The happiness its income tax takes, as its employees report it.
    tax_loss: Option<f64>,
    country: Option<String>,
    core_country: Option<String>,
    storage: Option<f64>,
    #[serde(default)]
    full: Truthy,
    capacity: Option<f64>,
    /// Why the company isn't planned, if it isn't.
    #[serde(default)]
    excluded: Truthy,
    switched_age_hours: Option<f64>,
    /// Set on a company re-tooled onto another good (`retool`).
    switch: Option<SwitchInput>,
    recruitment_values: Option<Vec<Option<f64>>>,
    manager_pct: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchInput {
    from: Option<String>,
    from_type: Option<String>,
    cost: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmployeeInput {
    id: Option<String>,
    company: Option<String>,
    age: Option<f64>,
    retire_in_days: Option<f64>,
    #[serde(default)]
    locked: Truthy,
    production: Option<f64>,
    trait_production: Option<f64>,
    responsibility: Option<f64>,
    luck: Option<f64>,
    training_base_luck: Option<f64>,
    training_luck: Option<f64>,
    potential_left: Option<f64>,
    wage: Option<f64>,
    climber_raise: Option<f64>,
    gender: Option<String>,
    nationality: Option<String>,
    traits: Option<Vec<TraitInput>>,
    specializations: Option<OrderedMap<Option<f64>>>,
    tenure: Option<f64>,
    employed_days: Option<f64>,
    /// Infinity if never moved.
    move_age_hours: Option<f64>,
    production_events: Option<Vec<EventInput>>,
    #[serde(rename = "happiness")]
    happiness_events: Option<Vec<EventInput>>,
    observed: Option<ObservedInput>,
    equipped: Option<EquippedInput>,
    training_values: Option<Vec<Option<f64>>>,
    potential_max: Option<f64>,
    negotiation_expectation: Option<f64>,
    life_loss: Option<f64>,
    shared_loss: Option<f64>,
    #[serde(default)]
    pending_training: Truthy,
    #[serde(default)]
    has_tool: Truthy,
}

#[derive(Deserialize)]
struct TraitInput {
    code: Option<String>,
    revealed: Option<bool>,
    arg: Option<String>,
}

/// A timed event: `delta`, for `hours` more.
#[derive(Deserialize)]
struct EventInput {
    delta: Option<f64>,
    hours: Option<f64>,
}

/// What the game reports today, after traits and coworkers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservedInput {
    luck: Option<f64>,
    trainings_per_day: Option<f64>,
    production: Option<f64>,
    responsibility: Option<f64>,
    happiness: Option<f64>,
    bonus: Option<f64>,
    output: Option<f64>,
}

#[derive(Deserialize)]
struct EquippedInput {
    id: Option<String>,
}

#[derive(Deserialize)]
struct ToolInput {
    id: Option<String>,
    holder: Option<String>,
    #[serde(rename = "type")]
    tool_type: Option<String>,
    bonus: Option<f64>,
    hours: Option<f64>,
}

/// A flag read by truthiness (`x ? 1 : 0`): false, 0, NaN, '', null and
/// undefined are false, anything else true.
#[derive(Default)]
pub(crate) struct Truthy(pub(crate) bool);

impl<'de> Deserialize<'de> for Truthy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TruthyVisitor;
        impl<'de> Visitor<'de> for TruthyVisitor {
            type Value = Truthy;
            fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
                formatter.write_str("any value")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Truthy, E> {
                Ok(Truthy(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Truthy, E> {
                Ok(Truthy(v != 0))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Truthy, E> {
                Ok(Truthy(v != 0))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Truthy, E> {
                Ok(Truthy(v != 0.0 && !v.is_nan()))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Truthy, E> {
                Ok(Truthy(!v.is_empty()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Truthy, E> {
                Ok(Truthy(false))
            }
            fn visit_none<E: de::Error>(self) -> Result<Truthy, E> {
                Ok(Truthy(false))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Truthy, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Truthy(true))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Truthy, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Truthy(true))
            }
        }
        deserializer.deserialize_any(TruthyVisitor)
    }
}

/// A map that crosses as a plain object, keys in their order.
pub struct OrderedMap<V>(pub Vec<(String, V)>);

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedMapVisitor<V>(core::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedMapVisitor<V> {
            type Value = OrderedMap<V>;
            fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
                while let Some(entry) = access.next_entry()? {
                    entries.push(entry);
                }
                Ok(OrderedMap(entries))
            }
        }
        deserializer.deserialize_map(OrderedMapVisitor(core::marker::PhantomData))
    }
}

// --- Decoding ---

/// A number `validate` requires: NaN when missing (see the module doc).
fn required(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}
/// A number that is 0 when unknown.
fn zero(v: Option<f64>) -> f64 {
    known(v).unwrap_or(0.0)
}
/// Hours since something happened: infinite (never) when unknown.
fn hours_since(v: Option<f64>) -> f64 {
    v.filter(|x| !x.is_nan()).unwrap_or(f64::INFINITY)
}
fn is_finite(v: Option<f64>) -> bool {
    v.is_some_and(f64::is_finite)
}
/// Timed events with a known delta and hours (infinite hours: for good).
fn events(list: Option<Vec<EventInput>>) -> Vec<TimedEvent> {
    list.unwrap_or_default()
        .into_iter()
        .filter_map(|x| {
            Some(TimedEvent {
                delta: known(x.delta)?,
                hours_left: x.hours.filter(|h| !h.is_nan())?,
            })
        })
        .collect()
}

impl From<SnapshotInput> for Snapshot {
    fn from(input: SnapshotInput) -> Snapshot {
        Snapshot {
            days: required(input.days),
            days_integer: input.days.is_some_and(|d| d.is_finite() && d.trunc() == d),
            hours: known(input.hours),
            training_quota: zero(input.training_quota),
            management: zero(input.management),
            management_pct: zero(input.management_pct),
            toolbox_value: zero(input.toolbox_value),
            pp_value: known(input.pp_value).filter(|&v| v > 0.0),
            companies: input.companies.into_iter().map(Company::from).collect(),
            employees: input.employees.into_iter().map(Employee::from).collect(),
            tools: input.tools.unwrap_or_default().into_iter().map(Tool::from).collect(),
        }
    }
}

impl From<CompanyInput> for Company {
    fn from(c: CompanyInput) -> Company {
        let product = intern_optional(c.product.as_deref());
        let item_type = intern_optional(c.item_type.as_deref());
        // Recruiting's values with 0 to 3 Recruiters, if all four are known.
        let recruitment = c.recruitment_values.and_then(|list| {
            let values: Vec<f64> = list.into_iter().take(4).map(known).collect::<Option<_>>()?;
            <[f64; 4]>::try_from(values).ok()
        });
        let bits = |finite: bool, bit: u8| if finite { bit } else { 0 };
        let capacity_integer = c.capacity.is_some_and(|v| v.is_finite() && v.trunc() == v);
        let record = CompanyRecord {
            id: intern_optional(c.id.as_deref()),
            product,
            product_text: string(product),
            item_type_text: string(item_type),
            tool_type: c
                .product
                .as_deref()
                .and_then(crate::pricing::tool_type_of)
                .map_or(0, intern),
            margin: required(c.margin),
            disabled: c.disabled.0,
            engine_daily_prod: zero(c.engine_daily_prod),
            engine_bonus: zero(c.engine_bonus),
            bonus: zero(c.bonus),
            tax: required(c.tax),
            tax_loss: known(c.tax_loss).unwrap_or_else(|| cfg::tax_happiness_loss(required(c.tax))),
            country: intern_optional(c.country.as_deref()),
            core_country: intern_optional(c.core_country.as_deref()),
            storage: known(c.storage),
            full: c.full.0,
            switched: c.switch.is_some(),
            switch_cost: c.switch.as_ref().map_or(0.0, |s| zero(s.cost)),
            recruitment,
        };
        Company {
            item_type,
            excluded: c.excluded.0,
            capacity: required(c.capacity),
            switched_age_hours: hours_since(c.switched_age_hours),
            switch_from: c.switch.as_ref().map_or(0, |s| intern_optional(s.from.as_deref())),
            switch_from_type: c
                .switch
                .as_ref()
                .map_or(0, |s| intern_optional(s.from_type.as_deref())),
            has_id: truthy_string(record.id),
            valid_numbers: bits(is_finite(c.margin), COMPANY_MARGIN)
                | bits(is_finite(c.bonus), COMPANY_BONUS)
                | bits(is_finite(c.tax), COMPANY_TAX)
                | bits(capacity_integer, COMPANY_CAPACITY),
            manager_pct: zero(c.manager_pct),
            record,
        }
    }
}

impl From<EmployeeInput> for Employee {
    fn from(e: EmployeeInput) -> Employee {
        let observed = e.observed.as_ref();
        let observed_value = |f: fn(&ObservedInput) -> Option<f64>| known(observed.and_then(f));
        let traits = e.traits.unwrap_or_default();
        let held_trait = |t: &TraitInput| {
            Some(Held {
                code: Code::of(t.code.as_deref()?),
                arg: t.arg.as_deref().filter(|a| !a.is_empty()).map(Rc::from),
            })
        };
        let held = traits.iter().filter_map(held_trait).collect();
        let shown =
            traits.iter().filter(|t| t.revealed != Some(false)).filter_map(held_trait).collect();
        let training_values = e.training_values.map(|list| {
            std::array::from_fn(|i| known(list.get(i).copied().flatten()).unwrap_or(0.0))
        });
        let mut record = EmployeeRecord {
            id: intern_optional(e.id.as_deref()),
            company: intern_optional(e.company.as_deref()),
            age: required(e.age),
            retire_in_days: known(e.retire_in_days),
            production: required(e.production),
            trait_production: zero(e.trait_production),
            responsibility: required(e.responsibility),
            luck: zero(e.luck),
            training_base_luck: known(e.training_base_luck),
            training_luck: known(e.training_luck),
            potential_left: known(e.potential_left),
            wage: required(e.wage),
            climber_raise: zero(e.climber_raise),
            employed_days: required(e.employed_days),
            move_age_hours: hours_since(e.move_age_hours),
            tenure: required(e.tenure),
            female: e.gender.as_deref() == Some("female"),
            nationality: intern_optional(e.nationality.as_deref()),
            observed_luck: observed_value(|o| o.luck),
            observed_trainings_per_day: observed_value(|o| o.trainings_per_day),
            traits: traits
                .iter()
                .map(|t| {
                    TraitRecord::new(
                        t.code.as_deref().and_then(Trait::from_code),
                        intern_optional(t.arg.as_deref()),
                    )
                })
                .collect(),
            flags: 0,
            happiness_events: events(e.happiness_events),
            production_events: events(e.production_events),
            training_values,
        };
        record.update_flags();
        let finite_bit = |v: Option<f64>, bit: u8| if is_finite(v) { 1 << bit } else { 0 };
        let equipped = e.equipped.as_ref().map_or(0, |x| intern_optional(x.id.as_deref()));
        let check = EmployeeCheck {
            id: truthy_string(record.id),
            finite: finite_bit(e.age, 0)
                | finite_bit(e.production, 1)
                | finite_bit(e.responsibility, 2)
                | finite_bit(e.wage, 3)
                | finite_bit(e.tenure, 4)
                | finite_bit(e.employed_days, 5)
                | finite_bit(e.climber_raise, 6),
            equipped: if truthy_string(equipped) { equipped } else { 0 },
            traits: traits
                .iter()
                .zip(&record.traits)
                .map(|(t, r)| TraitCheck {
                    hidden: t.revealed == Some(false),
                    has_arg: truthy_string(r.arg),
                })
                .collect(),
        };
        Employee {
            gender: e.gender.map(Rc::from),
            locked: e.locked.0,
            equipped,
            specializations: e.specializations.map(|m| {
                m.0.into_iter()
                    .map(|(good, days)| SavedDays { product: intern(&good), days: zero(days) })
                    .collect()
            }),
            observed: e.observed.as_ref().map(|o| Observed {
                production: known(o.production),
                responsibility: known(o.responsibility),
                happiness: known(o.happiness),
                bonus: known(o.bonus),
                output: known(o.output),
            }),
            check,
            record,
            held,
            shown,
            potential_max: known(e.potential_max),
            negotiation_expectation: known(e.negotiation_expectation),
            life_loss: known(e.life_loss),
            shared_loss: zero(e.shared_loss),
            pending_training: e.pending_training.0,
            has_tool: e.has_tool.0,
        }
    }
}

impl From<ToolInput> for Tool {
    fn from(t: ToolInput) -> Tool {
        let holder = intern_optional(t.holder.as_deref());
        Tool {
            id: intern_optional(t.id.as_deref()),
            tool: project::Tool {
                tool_type: intern_optional(t.tool_type.as_deref()),
                bonus: zero(t.bonus),
                hours: required(t.hours),
            },
            holder: if truthy_string(holder) { holder } else { 0 },
        }
    }
}
