//! Recruiting: a typed-in candidate (`candidateValue`) and a fresh set of
//! candidates (`freshSetValue`, or keep.rs' sets with their coworkers read
//! natively; the newcomer's own tables are built a few steps at a time for
//! the keep session's `prepare`).

use crate::cfg::CFG;
use crate::model::{Code, Context, RulesEmployee, known};
use crate::rules::{
    Memo, Price, call_js_function, gender_name, hire_production, hourly_profit, hours_left,
    model_only, potential_value, rolled_traits, training_outlook, trait_value, working_days,
};
use crate::sort::{sort_list, sort_places};
use crate::traits::{TRAITS, Trait};
use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::JsValue;

/// What a candidate card can show, and the hidden ranges.
pub struct Hire;
impl Hire {
    pub const MIN_STAT: f64 = 1.0;
    pub const MAX_STAT: f64 = 4.0;
    pub const MIN_POTENTIAL: f64 = 3.0;
    pub const MAX_POTENTIAL: f64 = 10.0;
    pub const MIN_AGE: f64 = 18.0;
    pub const MAX_AGE: f64 = 45.0;
    pub const AVERAGE_STAT: f64 = 2.5;
}
/// How many hiring ages there are.
const AGE_COUNT: usize = (Hire::MAX_AGE - Hire::MIN_AGE + 1.0) as usize;
/// How many potentials a hire can have.
const POTENTIAL_COUNT: f64 = Hire::MAX_POTENTIAL - Hire::MIN_POTENTIAL + 1.0;

/// The wage multiplier of a trait: Greedy's and Modest's, 1 for the rest.
fn wage_multiplier(trait_id: Trait) -> f64 {
    match trait_id {
        Trait::Greedy => 1.2,
        Trait::Modest => 0.85,
        _ => 1.0,
    }
}
/// Whether a trait is all in the wage multiplier (Greedy and Modest).
fn in_wage_multiplier(trait_id: Trait) -> bool {
    matches!(trait_id, Trait::Greedy | Trait::Modest)
}
/// A hire's happiness: neutral 50, +3 a point of Responsibility, less the
/// company's lasting losses, within 0 to 100.
fn hire_happiness(responsibility: f64, loss: f64) -> f64 {
    (50.0 + CFG.responsibility_happiness * responsibility - loss).clamp(0.0, CFG.happiness_max)
}
fn with_happiness(bonus: f64, happiness: f64) -> f64 {
    bonus + (happiness - 50.0) / 100.0
}
/// How likely a wage reading is for a trait whose reading is `multiplier`
/// times the wage expectation.
fn wage_fit(reading: f64, multiplier: f64) -> f64 {
    let expectation = reading / multiplier;
    if (CFG.wage_floor - 1e-6..=2.0 - CFG.wage_floor + 1e-6).contains(&expectation) {
        1.0 / multiplier
    } else {
        0.0
    }
}

/// A typed-in candidate: `{ age, gender, wagePP, expectation, production,
/// responsibility, luck }`. The age must be known (an input error
/// otherwise); either wage reading will do (`wagePP`, the hourly wage over
/// the PP's value, or `expectation`, the card's wage against the market);
/// an unknown stat is the average hire's.
#[derive(Deserialize)]
#[serde(try_from = "CandidateInput")]
pub struct Candidate {
    pub age: f64,
    pub female: bool,
    pub wage_pp: Option<f64>,
    pub expectation: Option<f64>,
    pub production: Option<f64>,
    pub responsibility: Option<f64>,
    pub luck: Option<f64>,
}

#[derive(Deserialize)]
struct CandidateInput {
    age: Option<f64>,
    gender: Option<String>,
    #[serde(rename = "wagePP")]
    wage_pp: Option<f64>,
    expectation: Option<f64>,
    production: Option<f64>,
    responsibility: Option<f64>,
    luck: Option<f64>,
}

impl TryFrom<CandidateInput> for Candidate {
    type Error = &'static str;
    fn try_from(c: CandidateInput) -> Result<Candidate, &'static str> {
        Ok(Candidate {
            age: known(c.age).ok_or("A candidate needs a known age.")?,
            female: c.gender.as_deref() == Some("female"),
            wage_pp: known(c.wage_pp),
            expectation: known(c.expectation),
            production: known(c.production),
            responsibility: known(c.responsibility),
            luck: known(c.luck),
        })
    }
}

/// `candidateValue`'s options: `{ ctx, bonus, happinessLoss, alt }`. The
/// context defaults; an unknown bonus or `alt` is 0 and an unknown
/// happiness loss `DEFAULT_EMPLOYEE`'s.
#[derive(Deserialize)]
#[serde(from = "CandidateOptionsInput")]
pub struct CandidateOptions {
    pub context: Context,
    pub bonus: f64,
    pub happiness_loss: f64,
    /// What a slot-day earns otherwise, in PP.
    pub alt: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateOptionsInput {
    #[serde(rename = "ctx")]
    context: Option<Context>,
    bonus: Option<f64>,
    happiness_loss: Option<f64>,
    alt: Option<f64>,
}

impl From<CandidateOptionsInput> for CandidateOptions {
    fn from(o: CandidateOptionsInput) -> CandidateOptions {
        CandidateOptions {
            context: o.context.unwrap_or_default(),
            bonus: known(o.bonus).unwrap_or(0.0),
            happiness_loss: known(o.happiness_loss)
                .unwrap_or(RulesEmployee::default().happiness_loss),
            alt: known(o.alt).unwrap_or(0.0),
        }
    }
}

/// `candidateValue`'s result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateValue {
    pub value: f64,
    pub output: f64,
    pub r#trait: f64,
    pub potential: f64,
    pub happiness: f64,
    pub wage_expectation: f64,
    /// The wage against the market, as read.
    pub reading: f64,
    pub odds: Odds,
    pub spread: Vec<Spread>,
}
#[derive(Serialize)]
pub struct Odds {
    pub greedy: f64,
    pub modest: f64,
}
/// One of the candidate's possible values, by trait roll and potential.
#[derive(Serialize)]
pub struct Spread {
    #[serde(rename = "p")]
    pub probability: f64,
    pub value: f64,
}

/// A trait the candidate may have rolled, as `candidateValue` weighs it.
struct TraitRoll {
    trait_id: Trait,
    probability: f64,
    value: f64,
    wage_base: f64,
    /// The Production the wage is paid on, the trait's included.
    paid: f64,
    /// The wage reading per unit of wage expectation: the trait's wage
    /// multiplier times paid over shown Production.
    reading_multiplier: f64,
}

/// A trait roll's own figures: its wage expectation per paid point, its
/// output over the working life and the trait's value.
struct RollValue {
    wage_expectation: f64,
    output: f64,
    value: f64,
}

/// The hire as `candidateValue` and the tables build it.
fn hire_employee(bonus: f64, happiness_loss: f64) -> RulesEmployee {
    RulesEmployee {
        extra_production: 0.0,
        bonus,
        specialization: 0.0,
        happiness_loss,
        trainings_per_day: 1.0,
        traits: Some(Rc::from([])),
        ..RulesEmployee::default()
    }
}

/// `candidateValue`: a typed-in candidate over their working life, in PP.
pub fn candidate_value(candidate: &Candidate, options: &CandidateOptions) -> CandidateValue {
    let CandidateOptions { context, bonus, happiness_loss, alt } = options;
    let (bonus, happiness_loss, alt) = (*bonus, *happiness_loss, *alt);
    let production = candidate.production.unwrap_or(Hire::AVERAGE_STAT);
    let gender = if candidate.female { "female" } else { "male" };
    // Either wage reading will do: the card's expectation (the wage against
    // the market, 1 = market) is the game's own, so it reads the trait
    // without our V; the wage, when typed, sets the pay (wage / (Production/4 x V)).
    let shown = candidate.wage_pp.map(|wage_pp| 4.0 * wage_pp / production);
    let reading = candidate.expectation.or(shown).unwrap_or(0.0);
    // The wage paid, per shown point, / V.
    let pay = shown.unwrap_or(reading);
    let responsibility = candidate.responsibility.unwrap_or(Hire::AVERAGE_STAT);
    let happiness = hire_happiness(responsibility, happiness_loss);
    let employee = RulesEmployee {
        age: candidate.age,
        production,
        trait_production: 0.0,
        extra_production: 0.0,
        responsibility,
        luck: candidate.luck.unwrap_or(Hire::AVERAGE_STAT),
        bonus: with_happiness(bonus, happiness),
        happiness: Some(happiness),
        specialization: 0.0,
        wage_expectation: pay,
        happiness_loss,
        trainings_per_day: 1.0,
        traits: Some(Rc::from([])),
        ..RulesEmployee::default()
    };
    let hours = hours_left(&employee);
    let situation = context.with_gender(gender).situation;
    let rolls: Vec<TraitRoll> = rolled_traits(&employee, context, gender)
        .into_iter()
        .map(|rolled| {
            let paid =
                (production + hire_production(rolled.trait_id, employee.age, &situation)).max(1.0);
            TraitRoll {
                trait_id: rolled.trait_id,
                probability: rolled.probability,
                value: rolled.value,
                wage_base: rolled.wage_base,
                paid,
                reading_multiplier: wage_multiplier(rolled.trait_id) * paid / production,
            }
        })
        .collect();
    // The roll weights given the wage reading (traitsGivenWage).
    let fits: Vec<f64> = rolls
        .iter()
        .map(|roll| roll.probability * wage_fit(reading, roll.reading_multiplier))
        .collect();
    let total = fits.iter().fold(0.0, |a, v| a + v);
    let given: Vec<TraitRoll> = if total != 0.0 {
        rolls
            .into_iter()
            .zip(&fits)
            .map(|(roll, fit)| TraitRoll { probability: fit / total, ..roll })
            .filter(|roll| roll.probability > 0.0)
            .collect()
    } else {
        rolls
    };
    // Each roll's own output and wage, the trait priced at that expectation;
    // Greedy and Modest are already in the wage.
    let roll_values: Vec<RollValue> = given
        .iter()
        .map(|roll| {
            let wage_expectation = pay * production / roll.paid;
            let output =
                hourly_profit(&RulesEmployee { wage_expectation, ..employee.clone() }, context)
                    * hours;
            let value = if in_wage_multiplier(roll.trait_id) {
                0.0
            } else {
                roll.value + (pay - wage_expectation) * roll.wage_base
            };
            RollValue { wage_expectation, output, value }
        })
        .collect();
    let mean = |part: fn(&RollValue) -> f64| {
        given
            .iter()
            .zip(&roll_values)
            .fold(0.0, |a, (roll, values)| a + roll.probability * part(values))
    };
    let output = mean(|values| values.output);
    let traits_value = mean(|values| values.value);
    let wage_expectation = mean(|values| values.wage_expectation);
    let expected = RulesEmployee { wage_expectation, ..employee.clone() };
    let memo = Memo::default();
    let mut outlook = None;
    let potentials: Vec<f64> = (0..POTENTIAL_COUNT as usize)
        .map(|i| {
            let potential = Hire::MIN_POTENTIAL + i as f64;
            // The outlook doesn't depend on the potential: worked out once.
            if working_days(&expected) != 0.0 && potential != 0.0 && outlook.is_none() {
                outlook = Some(
                    model_only(training_outlook(&expected, context, &Price::Model, 1.0, &memo))
                        .value,
                );
            }
            potential_value(&expected, context, potential, alt, outlook, &memo)
        })
        .collect();
    let potential = potentials.iter().fold(0.0, |a, v| a + v) / potentials.len() as f64;
    let chance = |trait_id: Trait| {
        given.iter().find(|roll| roll.trait_id == trait_id).map_or(0.0, |roll| roll.probability)
    };
    let spread = given
        .iter()
        .zip(&roll_values)
        .flat_map(|(roll, values)| {
            potentials.iter().map(move |&v| Spread {
                probability: roll.probability / POTENTIAL_COUNT,
                value: values.output + values.value + v,
            })
        })
        .collect();
    CandidateValue {
        value: output + traits_value + potential,
        output,
        r#trait: traits_value,
        potential,
        happiness,
        wage_expectation,
        reading,
        odds: Odds { greedy: chance(Trait::Greedy), modest: chance(Trait::Modest) },
        spread,
    }
}

// --- A fresh set of candidates ---

/// One company setting (`groups[i]` of freshSetValue): `{ ctx, bonus,
/// happinessLoss, weight, coworkers }`. The context defaults; an unknown
/// bonus is 0, happiness loss `DEFAULT_EMPLOYEE`'s and weight 1. Groups in
/// one setting share a newcomer.
#[derive(Deserialize)]
#[serde(from = "GroupInput")]
pub struct Group {
    pub setting: Setting,
    pub weight: f64,
    /// `g.coworkers(production, wagePP, gender)`; read when a function.
    pub coworkers: JsValue,
}

/// What a newcomer's own tables are worked out from: the context they are
/// hired into, the company's bonus and the happiness they lose.
#[derive(Clone, PartialEq)]
pub struct Setting {
    pub context: Context,
    pub bonus: f64,
    pub happiness_loss: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupInput {
    #[serde(rename = "ctx")]
    context: Option<Context>,
    bonus: Option<f64>,
    happiness_loss: Option<f64>,
    weight: Option<f64>,
    #[serde(default, with = "serde_wasm_bindgen::preserve")]
    coworkers: JsValue,
}

impl From<GroupInput> for Group {
    fn from(g: GroupInput) -> Group {
        Group {
            setting: Setting {
                context: g.context.unwrap_or_default(),
                bonus: known(g.bonus).unwrap_or(0.0),
                happiness_loss: known(g.happiness_loss)
                    .unwrap_or(RulesEmployee::default().happiness_loss),
            },
            weight: known(g.weight).unwrap_or(1.0),
            coworkers: g.coworkers,
        }
    }
}

/// A rollable trait: its weight, wage multiplier, value and wageBase by
/// Production (priced at age 31), and the flat Production it gives at each
/// hiring age.
struct TraitRow {
    weight: f64,
    wage_multiplier: f64,
    value: [f64; 5],
    wage_base: [f64; 5],
    production: Vec<f64>,
}
/// Traits that read alike on the card at one age and Production (the same
/// wage multiplier and paid Production), their figures summed by weight.
struct TraitGroup {
    /// The wage reading per unit of wage expectation.
    reading_multiplier: f64,
    /// Shown over paid Production: a reading times this is the wage
    /// expectation per paid point.
    paid_share: f64,
    weight: f64,
    value: f64,
    wage_base: f64,
}
/// One gender's rollable traits: their rows and total weight, and per
/// hiring age, by Production, the groups that read alike.
struct RollableTraits {
    rows: Vec<TraitRow>,
    total_weight: f64,
    groups: Vec<[Vec<TraitGroup>; 5]>,
}

/// The newcomer's own tables for a company setting (`ownTables`).
pub struct OwnTables {
    /// By Responsibility, per hiring age: output per paid point before wages.
    gross: [Vec<f64>; 5],
    /// Per hiring age: the hours left.
    hours_left: Vec<f64>,
    /// Per hiring age: the working days.
    working_days: Vec<f64>,
    /// By Production: the typical hire's training outlook per working day.
    outlook_per_day: [f64; 5],
    /// By gender, as `GENDERS` lists them.
    traits: [RollableTraits; 2],
    /// The typical hire's working days.
    typical_working_days: f64,
}

/// Own tables kept for their setting.
struct CachedOwnTables {
    setting: Setting,
    tables: Rc<OwnTables>,
}

/// Settings whose own tables are kept, the oldest dropped first: a page
/// works out one per recruiting company and coworker mix, and each is a few
/// kilobytes.
const OWN_TABLES_KEPT: usize = 200;

thread_local! {
    static OWN_TABLES: RefCell<Vec<CachedOwnTables>> = const { RefCell::new(Vec::new()) };
}

/// Drops every cached own table (they depend on the paid rule).
pub fn clear_own_tables() {
    OWN_TABLES.with(|cache| cache.borrow_mut().clear());
}
pub fn own_tables_cached(setting: &Setting) -> Option<Rc<OwnTables>> {
    OWN_TABLES.with(|cache| {
        let cache = cache.borrow();
        cache.iter().find(|cached| cached.setting == *setting).map(|cached| cached.tables.clone())
    })
}
fn cache_own_tables(setting: Setting, tables: Rc<OwnTables>) {
    OWN_TABLES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= OWN_TABLES_KEPT {
            cache.remove(0);
        }
        cache.push(CachedOwnTables { setting, tables });
    });
}

/// The newcomer's own tables (`ownTables`), built a step at a time. A
/// `step` works out one value: the training outlook at the next Production,
/// then, once those are done, the next trait.
pub struct OwnTablesBuilder {
    setting: Setting,
    /// The hire at age 31, average Production and wage expectation 1.
    typical_hire: RulesEmployee,
    gross: [Vec<f64>; 5],
    hours_left: Vec<f64>,
    working_days: Vec<f64>,
    outlook_per_day: [f64; 5],
    trait_rows: [Vec<TraitRow>; 2],
    /// 1..=4: `outlook_per_day[Production]`; then traits by gender.
    next_production: usize,
    next_gender: usize,
    next_trait: usize,
}

const GENDERS: [&str; 2] = ["male", "female"];

impl OwnTablesBuilder {
    pub fn new(setting: &Setting) -> OwnTablesBuilder {
        let setting = setting.clone();
        let context = &setting.context;
        let hire = hire_employee(setting.bonus, setting.happiness_loss);
        let typical_hire = RulesEmployee {
            age: 31.0,
            production: Hire::AVERAGE_STAT,
            wage_expectation: 1.0,
            ..hire.clone()
        };
        // Per age: output per paid point before wages (by Responsibility),
        // hours left, working days.
        let mut gross: [Vec<f64>; 5] = Default::default();
        let (mut hours, mut days) = (Vec::new(), Vec::new());
        for age in 0..AGE_COUNT {
            let employee = RulesEmployee {
                age: Hire::MIN_AGE + age as f64,
                production: CFG.output_divisor,
                wage_expectation: 0.0,
                ..hire.clone()
            };
            for (r, row) in gross.iter_mut().enumerate().skip(Hire::MIN_STAT as usize) {
                let happy_bonus =
                    with_happiness(hire.bonus, hire_happiness(r as f64, hire.happiness_loss));
                row.push(hourly_profit(
                    &RulesEmployee { bonus: happy_bonus, ..employee.clone() },
                    context,
                ));
            }
            hours.push(hours_left(&employee));
            days.push(working_days(&employee));
        }
        OwnTablesBuilder {
            setting,
            typical_hire,
            gross,
            hours_left: hours,
            working_days: days,
            outlook_per_day: [0.0; 5],
            trait_rows: Default::default(),
            next_production: 1,
            next_gender: 0,
            next_trait: 0,
        }
    }

    /// One step; the tables once they are built (and cached).
    pub fn step(&mut self) -> Option<Rc<OwnTables>> {
        let typical_days = working_days(&self.typical_hire);
        if self.next_production <= Hire::MAX_STAT as usize {
            let production = self.next_production as f64;
            let employee = RulesEmployee { production, ..self.typical_hire.clone() };
            self.outlook_per_day[self.next_production] = model_only(training_outlook(
                &employee,
                &self.setting.context,
                &Price::Model,
                1.0,
                &Memo::default(),
            ))
            .value
                / typical_days;
            self.next_production += 1;
            return None;
        }
        while self.next_gender < 2 {
            let gender = GENDERS[self.next_gender];
            let rollable: Vec<Trait> = TRAITS
                .iter()
                .copied()
                .filter(|t| {
                    t.rule().weight > 0 && t.rule().gender.is_none_or(|g| gender_name(g) == gender)
                })
                .collect();
            if let Some(&rolled) = rollable.get(self.next_trait) {
                // Each priced by Production at age 31 at expectation 1
                // (wageBase moves it), with the flat Production it gives at
                // each hiring age.
                let gender_context = self.setting.context.with_gender(gender);
                let mut value = [0.0; 5];
                let mut wage_base = [0.0; 5];
                for p in 1..5 {
                    if rolled.rule().partner || in_wage_multiplier(rolled) {
                        continue;
                    }
                    let priced = trait_value(
                        &Code::Known(rolled),
                        &RulesEmployee { production: p as f64, ..self.typical_hire.clone() },
                        &gender_context,
                        None,
                        false,
                    );
                    value[p] = priced.value.unwrap_or(0.0);
                    wage_base[p] = priced.wage_base;
                }
                let production = (0..AGE_COUNT)
                    .map(|age| {
                        hire_production(
                            rolled,
                            Hire::MIN_AGE + age as f64,
                            &gender_context.situation,
                        )
                    })
                    .collect();
                self.trait_rows[self.next_gender].push(TraitRow {
                    weight: f64::from(rolled.rule().weight),
                    wage_multiplier: wage_multiplier(rolled),
                    value,
                    wage_base,
                    production,
                });
                self.next_trait += 1;
                return None;
            }
            self.next_gender += 1;
            self.next_trait = 0;
        }
        let trait_rows = std::mem::take(&mut self.trait_rows);
        let traits = trait_rows.map(|rows| {
            let total_weight = rows.iter().fold(0.0, |a, row| a + row.weight);
            // Traits that read alike on the card, by age and Production: the
            // same wage multiplier and paid Production.
            let groups = (0..AGE_COUNT)
                .map(|age| {
                    let mut by_production: [Vec<TraitGroup>; 5] = Default::default();
                    for (p, groups) in by_production.iter_mut().enumerate().skip(1) {
                        let production = p as f64;
                        // (wage multiplier, paid Production) of each group.
                        let mut keys: Vec<(f64, f64)> = Vec::new();
                        for row in &rows {
                            let paid = (production + row.production[age]).max(1.0);
                            let at = keys
                                .iter()
                                .position(|&(m, q)| m == row.wage_multiplier && q == paid)
                                .unwrap_or_else(|| {
                                    keys.push((row.wage_multiplier, paid));
                                    groups.push(TraitGroup {
                                        reading_multiplier: row.wage_multiplier * paid / production,
                                        paid_share: production / paid,
                                        weight: 0.0,
                                        value: 0.0,
                                        wage_base: 0.0,
                                    });
                                    keys.len() - 1
                                });
                            let group = &mut groups[at];
                            group.weight += row.weight;
                            group.value += row.weight * row.value[p];
                            group.wage_base += row.weight * row.wage_base[p];
                        }
                    }
                    by_production
                })
                .collect();
            RollableTraits { rows, total_weight, groups }
        });
        let tables = Rc::new(OwnTables {
            gross: std::mem::take(&mut self.gross),
            hours_left: std::mem::take(&mut self.hours_left),
            working_days: std::mem::take(&mut self.working_days),
            outlook_per_day: self.outlook_per_day,
            traits,
            typical_working_days: typical_days,
        });
        cache_own_tables(self.setting.clone(), tables.clone());
        Some(tables)
    }

    pub fn run(mut self) -> Rc<OwnTables> {
        loop {
            if let Some(tables) = self.step() {
                return tables;
            }
        }
    }
}

/// `rate`: a fixed PP a slot-day, or 'slot' (solved for the slot's own
/// rate). Decoded from `'slot'` or a number (unknown is 0).
#[derive(Clone, Copy)]
pub enum Rate {
    Fixed(f64),
    Slot,
}

impl<'de> Deserialize<'de> for Rate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Rate, D::Error> {
        struct RateVisitor;
        impl Visitor<'_> for RateVisitor {
            type Value = Rate;
            fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
                formatter.write_str("'slot' or a number")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Rate, E> {
                if v == "slot" {
                    Ok(Rate::Slot)
                } else {
                    Err(E::invalid_value(de::Unexpected::Str(v), &self))
                }
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Rate, E> {
                Ok(Rate::Fixed(known(Some(v)).unwrap_or(0.0)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Rate, E> {
                self.visit_f64(v as f64)
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Rate, E> {
                self.visit_f64(v as f64)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Rate, E> {
                Ok(Rate::Fixed(0.0))
            }
        }
        deserializer.deserialize_any(RateVisitor)
    }
}

/// `freshSetValue`'s options: `{ alt, slots, draws, seed, rate }`; unknown
/// ones are 0, 3, 6,000, 1 and a rate of 0. Slots, draws and the seed are
/// whole numbers: a known one is rounded toward 0 into `u32`'s range.
#[derive(Clone, Copy, Deserialize)]
#[serde(from = "FreshSetOptionsInput")]
pub struct FreshSetOptions {
    pub alt: f64,
    pub slots: u32,
    pub draws: u32,
    pub seed: u32,
    pub rate: Rate,
}

#[derive(Deserialize)]
struct FreshSetOptionsInput {
    alt: Option<f64>,
    slots: Option<f64>,
    draws: Option<f64>,
    seed: Option<f64>,
    rate: Option<Rate>,
}

impl From<FreshSetOptionsInput> for FreshSetOptions {
    fn from(o: FreshSetOptionsInput) -> FreshSetOptions {
        FreshSetOptions {
            alt: known(o.alt).unwrap_or(0.0),
            slots: known(o.slots).map_or(3, |n| n as u32),
            draws: known(o.draws).map_or(6000, |n| n as u32),
            seed: known(o.seed).map_or(1, |n| n as u32),
            rate: o.rate.unwrap_or(Rate::Fixed(0.0)),
        }
    }
}

/// A drawn candidate as the pick ranks them: their value at the rate, its
/// gross and working days, and the chance they are the best of `slots`.
pub struct Pick {
    pub value: f64,
    pub gross: f64,
    pub days: f64,
    pub probability: f64,
}
/// A pick's value and the chance it is the one taken.
#[derive(Clone, Copy)]
pub struct RankedPick {
    pub value: f64,
    pub probability: f64,
}
/// `freshSetValue`'s result; `beat(bar)` reads the sorted picks.
pub struct FreshSet {
    pub best: f64,
    pub gross: f64,
    pub days: f64,
    pub rate: f64,
    pub average: f64,
    pub coworkers: f64,
    pub picks: Vec<RankedPick>,
}

/// The newcomer's own tables for a setting, with what their trainings earn
/// above `alt`: by Production, per hiring age, the sum over the first n
/// trainings.
struct NewcomerTables {
    own: Rc<OwnTables>,
    trainings: [Vec<Vec<f64>>; 5],
}
/// A setting's newcomer tables: groups in one setting share them.
struct KnownNewcomer<'a> {
    setting: &'a Setting,
    tables: Rc<NewcomerTables>,
}

/// A group of a fresh set with what the newcomer does to the coworkers, read
/// on the wage grid (`wage_grid`): by gender as `GENDERS` lists them, then
/// Production 1 to 4 (None without coworkers).
pub struct SetGroup<'a> {
    pub setting: &'a Setting,
    pub weight: f64,
    pub coworkers: [[Option<Vec<f64>>; 5]; 2],
}

/// A group as the draws read it: its weight, the newcomer's tables, and the
/// coworkers on the wage grid.
struct GroupTables {
    weight: f64,
    newcomer: Rc<NewcomerTables>,
    coworkers: [[Option<Vec<f64>>; 5]; 2],
}

/// A drawn candidate: their value as the card reads, their value, and their
/// working days.
#[derive(Clone, Copy)]
struct DrawnCandidate {
    seen: f64,
    value: f64,
    days: f64,
}

/// The pick at one rate: the candidates ranked, and the means over them.
struct Picked {
    picks: Vec<Pick>,
    best: f64,
    gross: f64,
    days: f64,
}

/// The expectation x Greedy/Modest grid the coworkers callback is read on.
pub fn wage_grid() -> [f64; 11] {
    std::array::from_fn(|i| 0.6 + i as f64 * 0.1)
}

/// The chance that the k-th worst (from 0) of `draws` candidates is the
/// best of `slots` drawn: ((k + 1) / draws)^slots - (k / draws)^slots,
/// summed as (a^(s-1) + a^(s-2) b + ... + b^(s-1)) / draws, so no two
/// near-equal powers are subtracted.
fn best_of_chance(k: usize, draws: u32, slots: u32) -> f64 {
    let n = f64::from(draws);
    let (a, b) = ((k as f64 + 1.0) / n, k as f64 / n);
    let (mut sum, mut b_power) = (0.0, 1.0);
    for _ in 0..slots {
        sum = sum * a + b_power;
        b_power *= b;
    }
    sum / n
}

/// The mulberry32 generator.
struct Mulberry32 {
    state: u32,
}
impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let s = self.state;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }
}

/// `freshSetValue`: what a fresh set of candidates is worth when the pick
/// sees only what a card shows; a group's `coworkers` callback is read on
/// the wage grid.
pub fn fresh_set_value(groups: &[Group], options: &FreshSetOptions) -> Result<FreshSet, JsValue> {
    if groups.is_empty() {
        return Err(JsValue::from_str("freshSetValue: no groups"));
    }
    let grid = wage_grid();
    let mut read = Vec::with_capacity(groups.len());
    for group in groups {
        // What a newcomer does to the coworkers, by gender, Production and wage.
        let mut coworkers: [[Option<Vec<f64>>; 5]; 2] = Default::default();
        if group.coworkers.is_function() {
            for (gender, by_production) in GENDERS.iter().zip(&mut coworkers) {
                for (p, slot) in by_production.iter_mut().enumerate().skip(1) {
                    let production = p as f64;
                    let mut row = Vec::with_capacity(grid.len());
                    for &x in &grid {
                        row.push(call_js_function(
                            &group.coworkers,
                            production,
                            production / CFG.output_divisor * x,
                            gender,
                        )?);
                    }
                    *slot = Some(row);
                }
            }
        }
        read.push(SetGroup { setting: &group.setting, weight: group.weight, coworkers });
    }
    Ok(fresh_set_of(read, options))
}

/// A fresh set over groups whose coworkers are read already (at least one
/// group).
pub fn fresh_set_of(groups: Vec<SetGroup>, options: &FreshSetOptions) -> FreshSet {
    let FreshSetOptions { alt, slots, draws, seed, rate } = *options;
    let grid = wage_grid();
    let mut newcomers: Vec<KnownNewcomer> = Vec::new();
    let mut tables = Vec::with_capacity(groups.len());
    for group in groups {
        let setting = group.setting;
        let newcomer = match newcomers.iter().find(|known| *known.setting == *setting) {
            Some(known) => known.tables.clone(),
            None => {
                let own = own_tables_cached(setting)
                    .unwrap_or_else(|| OwnTablesBuilder::new(setting).run());
                // Trainings by Production, age and potential, above what 10 energy earns.
                let mut trainings: [Vec<Vec<f64>>; 5] = Default::default();
                for (p, row) in trainings.iter_mut().enumerate().skip(1) {
                    *row = own
                        .working_days
                        .iter()
                        .map(|&days| {
                            let mut by_count = vec![0.0];
                            for k in 0..Hire::MAX_POTENTIAL as usize {
                                by_count.push(
                                    by_count[k]
                                        + (own.outlook_per_day[p] * (days - k as f64).max(0.0)
                                            - alt)
                                            .max(0.0),
                                );
                            }
                            by_count
                        })
                        .collect();
                }
                let tables = Rc::new(NewcomerTables { own, trainings });
                newcomers.push(KnownNewcomer { setting, tables: tables.clone() });
                tables
            }
        };
        tables.push(GroupTables { weight: group.weight, newcomer, coworkers: group.coworkers });
    }
    let coworker_at = |row: &Option<Vec<f64>>, x: f64| -> f64 {
        let Some(row) = row else { return 0.0 };
        let f = ((x - grid[0]) / 0.1).clamp(0.0, (grid.len() - 1) as f64);
        let i = ((grid.len() - 2) as f64).min(f.floor());
        let index = i as usize;
        row[index] + (row[index + 1] - row[index]) * (f - i)
    };
    let weights = tables.iter().fold(0.0, |a, t| a + t.weight);
    let mut random = Mulberry32 { state: seed };
    let mut candidates: Vec<DrawnCandidate> = Vec::new();
    let mut coworker_sum = 0.0;
    for _ in 0..draws {
        let mut roll = random.next() * weights;
        let mut setting = &tables[0];
        for t in &tables {
            roll -= t.weight;
            if roll < 0.0 {
                setting = t;
                break;
            }
        }
        let NewcomerTables { own, trainings } = &*setting.newcomer;
        let gender = if random.next() < 0.5 { 0 } else { 1 };
        let production =
            Hire::MIN_STAT + (random.next() * (Hire::MAX_STAT - Hire::MIN_STAT + 1.0)).floor();
        let responsibility =
            Hire::MIN_STAT + (random.next() * (Hire::MAX_STAT - Hire::MIN_STAT + 1.0)).floor();
        let expectation = CFG.wage_floor + random.next() * 0.6;
        let age = (random.next() * AGE_COUNT as f64).floor() as usize;
        let potential = (Hire::MIN_POTENTIAL + (random.next() * POTENTIAL_COUNT).floor()) as usize;
        let traits = &own.traits[gender];
        let mut trait_roll = random.next() * traits.total_weight;
        let mut rolled = &traits.rows[0];
        for row in &traits.rows {
            trait_roll -= row.weight;
            if trait_roll < 0.0 {
                rolled = row;
                break;
            }
        }
        let (p, r) = (production as usize, responsibility as usize);
        let scale = own.working_days[age] / own.typical_working_days;
        // w is the expectation per paid point; the card reads x, the wage
        // / (Production/4 x V), which holds the trait's paid Production.
        let w = expectation * rolled.wage_multiplier;
        let x = w * (production + rolled.production[age]).max(1.0) / production;
        let coworker_effect = coworker_at(&setting.coworkers[gender][p], x);
        coworker_sum += coworker_effect;
        let hours = own.hours_left[age];
        let fixed = production / CFG.output_divisor * own.gross[r][age] * hours + coworker_effect;
        let own_value = |w: f64, weight: f64, value: f64, wage_base: f64| {
            -production / CFG.output_divisor * w * hours * weight
                + (value + (1.0 - w) * wage_base) * scale
        };
        let value = fixed
            + own_value(w, 1.0, rolled.value[p], rolled.wage_base[p])
            + trainings[p][age][potential];
        // As the card reads: each group of traits by how well it fits x.
        let (mut fit, mut read) = (0.0, 0.0);
        let alike = &traits.groups[age][p];
        for group in alike {
            let f = wage_fit(x, group.reading_multiplier) * group.weight;
            if f != 0.0 {
                fit += f;
                read += wage_fit(x, group.reading_multiplier)
                    * own_value(x * group.paid_share, group.weight, group.value, group.wage_base);
            }
        }
        if fit == 0.0 {
            for group in alike {
                fit += group.weight;
                read += own_value(x * group.paid_share, group.weight, group.value, group.wage_base);
            }
        }
        let potentials_mean =
            trainings[p][age][Hire::MIN_POTENTIAL as usize..].iter().fold(0.0, |s, v| s + v)
                / POTENTIAL_COUNT;
        let seen = fixed + read / fit + potentials_mean;
        candidates.push(DrawnCandidate { seen, value, days: own.working_days[age] });
    }
    let chances: Vec<f64> =
        (0..candidates.len()).map(|k| best_of_chance(k, draws, slots)).collect();
    let pick_at = |day_rate: f64| {
        let seen: Vec<f64> = candidates.iter().map(|c| c.seen - day_rate * c.days).collect();
        let mut order: Vec<usize> = (0..candidates.len()).collect();
        sort_places(&mut order, &|a, b| seen[a].total_cmp(&seen[b]));
        let picks: Vec<Pick> = order
            .iter()
            .zip(&chances)
            .map(|(&i, &probability)| {
                let c = &candidates[i];
                Pick {
                    value: c.value - day_rate * c.days,
                    gross: c.value,
                    days: c.days,
                    probability,
                }
            })
            .collect();
        let mean =
            |part: fn(&Pick) -> f64| picks.iter().fold(0.0, |a, x| a + x.probability * part(x));
        let (best, gross, days) = (mean(|x| x.value), mean(|x| x.gross), mean(|x| x.days));
        Picked { picks, best, gross, days }
    };
    // The slot's rate and the pick depend on each other; a few rounds settle it.
    let solve = matches!(rate, Rate::Slot);
    let mut day_rate = match rate {
        Rate::Fixed(v) => v,
        Rate::Slot => 0.0,
    };
    let mut picked = pick_at(day_rate);
    if solve {
        for _ in 0..4 {
            // No working days at all: the surplus is taken as a day's.
            let days = if picked.days == 0.0 { 1.0 } else { picked.days };
            day_rate = ((picked.gross - alt) / days).max(0.0);
            picked = pick_at(day_rate);
        }
    }
    let Picked { picks, best, gross, days } = picked;
    let mut ranked: Vec<RankedPick> =
        picks.iter().map(|x| RankedPick { value: x.value, probability: x.probability }).collect();
    sort_list(&mut ranked, &|x, y| x.value.total_cmp(&y.value));
    FreshSet {
        best,
        gross,
        days,
        rate: day_rate,
        average: candidates.iter().fold(0.0, |a, c| a + c.value - day_rate * c.days)
            / f64::from(draws),
        coworkers: coworker_sum / f64::from(draws),
        picks: ranked,
    }
}

/// A fresh set's figures: `{ best, gross, days, rate, average, coworkers }`.
#[derive(Serialize)]
pub struct Summary {
    best: f64,
    gross: f64,
    days: f64,
    rate: f64,
    average: f64,
    coworkers: f64,
}

impl FreshSet {
    /// How often the pick beats `bar`.
    pub fn beat(&self, bar: f64) -> f64 {
        self.picks.iter().fold(0.0, |a, x| if x.value > bar { a + x.probability } else { a })
    }
    pub fn summary(&self) -> Summary {
        Summary {
            best: self.best,
            gross: self.gross,
            days: self.days,
            rate: self.rate,
            average: self.average,
            coworkers: self.coworkers,
        }
    }
}
