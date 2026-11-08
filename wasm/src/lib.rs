//! The employee model as one WASM module: the training rules and card
//! values, the projection of a company's roster, careers, card pricing, the
//! planner and product switching. The facades (`EmployeeCore`,
//! `EmployeePlanner`, `EmployeeCareer`) call the exports here and add the
//! display text.
//!
//! - The rules' inputs (model.rs) and the rules (rules.rs, hourly.rs): wage,
//!   Luck odds, trait values, card outcomes and values, pools and outlooks,
//!   over the trait, card and game tables (traits.rs, cards.rs, cfg.rs).
//! - Recruiting (fresh.rs): a typed-in candidate and a fresh set.
//! - The planner snapshot (snapshot.rs), decoded once into the records
//!   every part below reads (`Snapshot`).
//! - The projection (project.rs): what a company's roster earns, hour by
//!   hour, over the horizon.
//! - The career simulation (career.rs; `Career`, `CareerRun`).
//! - Card pricing and retention (pricing.rs; `CardSession`,
//!   `RetentionSession`).
//! - The keep step and recruiting over a snapshot (keep.rs;
//!   `KeepSession`).
//! - The planner (planner.rs; `evaluate`, `Recommend`), its input checks
//!   (check.rs) and product switching (switch.rs).
//! - Shared: the boundary's value type (io.rs), the result shapes (out.rs),
//!   the caches (cache.rs) and the sorts (sort.rs).
//!
//! The boundary:
//! - every data input and result is `Js<T>` (io.rs): the export names the
//!   type, which decodes the plain object or serializes the result; an
//!   export takes one object per input and gives a named object back;
//! - inputs are decoded once and held by handle (`Snapshot`, `Subject`, the
//!   sessions); never decode per call;
//! - long work runs in steps the facade calls (`Recommend`, `CareerRun`,
//!   `KeepSession.prepare`), so it keeps progress and cancel;
//! - kinds cross as names (`"companyIds"`, `"reroll"`), never as numbers;
//!   the facades map them to text;
//! - what an unknown or odd input means is decided where it is decoded;
//!   inside, numbers are plain `f64`;
//! - no `serde_json`, and no `Debug`/`format!` in shipped code (size).

mod cache;
mod cards;
mod career;
mod cfg;
mod check;
mod fresh;
mod handoffs;
mod hash;
mod hourly;
mod io;
mod keep;
mod model;
mod out;
mod planner;
mod pricing;
mod project;
mod rules;
mod snapshot;
mod sort;
mod switch;
mod traits;

use io::Js;
use model::{Card, Code, Context, RulesEmployee};
use rules::{Memo, Price};
use serde::{Deserialize, Serialize};
use snapshot::OrderedMap;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

/// Runs `f` with the JS `price` callback as the given price, or with the
/// model's own prices if it isn't a function.
fn with_price<T>(callback: &JsValue, f: impl FnOnce(&Price<JsValue>) -> T) -> T {
    let quote = |c: &Card| rules::js_quote(callback, c);
    f(&if callback.is_function() { Price::Given(&quote) } else { Price::Model })
}
/// How many trainings ahead a rule looks: a finite number, else `default`
/// (the facade's own default for the call).
fn depth_or(depth: Option<f64>, default: f64) -> f64 {
    model::known(depth).unwrap_or(default)
}
fn trait_codes(list: &[String]) -> Vec<Code> {
    list.iter().map(|c| Code::of(c)).collect()
}
fn js_error(message: &str) -> JsValue {
    JsError::new(message).into()
}

/// The crate version, reported by the loader on the page and in workers.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

/// The game constants (`cfg::CFG`), with `traitProductionPaid` as it is now.
#[wasm_bindgen]
pub fn config() -> Result<Js<cfg::Config>, JsValue> {
    let mut c = cfg::CFG;
    c.trait_production_paid = cfg::trait_production_paid();
    Js::new(&c)
}

/// `CFG.traitProductionPaid`: whether the wage is paid on own-trait
/// Production too. Off, as the game has it; tests turn it on to model it.
#[wasm_bindgen(js_name = traitProductionPaid)]
pub fn trait_production_paid() -> bool {
    cfg::trait_production_paid()
}
#[wasm_bindgen(js_name = setTraitProductionPaid)]
pub fn set_trait_production_paid(on: bool) {
    if on != cfg::trait_production_paid() {
        fresh::clear_own_tables();
    }
    cfg::set_trait_production_paid(on);
}

/// `[{ code, polarity, weight, gender?, partner?, arg?, priced }]`, in trait id order.
#[wasm_bindgen(js_name = traitRules)]
pub fn trait_rules() -> Result<Js<&'static [traits::Rule]>, JsValue> {
    Js::new(&traits::RULES)
}

/// The pairs no employee holds both of (`traits::EXCLUSIVE`):
/// `[[code, code]]`.
#[wasm_bindgen(js_name = exclusivePairs)]
pub fn exclusive_pairs() -> Result<Js<Vec<[&'static str; 2]>>, JsValue> {
    Js::new(&traits::EXCLUSIVE.iter().map(|&(a, b)| [a.code(), b.code()]).collect())
}

/// The cards priced by number (`cards::numeric_cards`): `{ rarity: [card] }`.
#[wasm_bindgen(js_name = numericCards)]
pub fn numeric_cards() -> Result<Js<OrderedMap<&'static [cards::Card]>>, JsValue> {
    Js::new(&OrderedMap(
        cfg::Rarity::ALL.iter().map(|&r| (r.code().into(), cards::numeric_cards(r))).collect(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tables {
    default_employee: out::DefaultEmployee,
    default_context: OrderedMap<f64>,
    default_situation: model::DefaultSituation,
}

/// The model's other tables: `DEFAULT_EMPLOYEE`, `DEFAULT_CONTEXT` and
/// `DEFAULT_SITUATION`.
#[wasm_bindgen]
pub fn tables() -> Result<Js<Tables>, JsValue> {
    let default_context = Context::default();
    Js::new(&Tables {
        default_employee: out::DefaultEmployee,
        default_context: OrderedMap(vec![
            ("sellRatio".into(), default_context.sell_ratio),
            ("toolboxValue".into(), default_context.toolbox_value),
            ("management".into(), default_context.management),
            ("energyValue".into(), 0.0),
        ]),
        default_situation: model::DEFAULT_SITUATION,
    })
}

/// A decoded planner snapshot (snapshot.rs), held in the module: sessions
/// made from it share it. Free it with `free()` when done (the glue also
/// frees it on garbage collection); a session keeps what it needs.
#[wasm_bindgen]
pub struct Snapshot(Rc<snapshot::Snapshot>);

#[wasm_bindgen]
impl Snapshot {
    /// Decodes `snapshotOf(...).snapshot`, or a hand-built one; throws on a
    /// shape it can't read.
    #[wasm_bindgen(constructor)]
    pub fn new(value: Js<snapshot::Snapshot>) -> Result<Snapshot, JsValue> {
        Ok(Snapshot(Rc::new(snapshot::Snapshot::decode(value.into_value())?)))
    }

    /// The snapshot with the companies at `places` not planned either
    /// (`withExclusions`).
    pub fn exclude(&self, places: Vec<u32>) -> Snapshot {
        let mut s = (*self.0).clone();
        for place in places {
            if let Some(c) = s.companies.get_mut(place as usize) {
                c.excluded = true;
            }
        }
        Snapshot(Rc::new(s))
    }

    /// The snapshot planned over `days` days (card pricing's horizon).
    #[wasm_bindgen(js_name = withDays)]
    pub fn with_days(&self, days: f64) -> Snapshot {
        let mut s = (*self.0).clone();
        s.days = days;
        s.days_integer = days.is_finite() && days.trunc() == days;
        Snapshot(Rc::new(s))
    }

    #[wasm_bindgen(getter, js_name = employeeCount)]
    pub fn employee_count(&self) -> usize {
        self.0.employees.len()
    }

    /// An employee's known traits as ids (`traitRules` order).
    #[wasm_bindgen(js_name = traitIds)]
    pub fn trait_ids(&self, employee: usize) -> Vec<u8> {
        if employee >= self.0.employees.len() {
            return Vec::new();
        }
        self.0.trait_set(employee).iter().map(|t| t.id()).collect()
    }

    /// The index of an employee's company in `companies`, if it has one.
    #[wasm_bindgen(js_name = companyIndex)]
    pub fn company_index(&self, employee: usize) -> Option<u32> {
        self.0
            .employees
            .get(employee)
            .and_then(|e| self.0.first_company(e.record.company))
            .map(|i| i as u32)
    }
}

/// One employee in one context, decoded once (see model.rs) and priced by
/// handle. Work shared between calls (gained
/// trait values, Second Wind's outlook, the Luck forecast's pool) is kept
/// for the handle's life: every rule is pure.
#[wasm_bindgen]
pub struct Subject {
    employee: RulesEmployee,
    context: Context,
    memo: Memo,
}

#[wasm_bindgen]
impl Subject {
    /// `e` and `ctx` decoded with the defaults (model.rs); `ctx` undefined
    /// or null is `DEFAULT_CONTEXT`.
    #[wasm_bindgen(constructor)]
    pub fn new(e: Js<RulesEmployee>, ctx: Js<Option<Context>>) -> Result<Subject, JsValue> {
        Ok(Subject {
            employee: e.decode()?,
            context: ctx.decode()?.unwrap_or_default(),
            memo: Memo::default(),
        })
    }

    #[wasm_bindgen(js_name = cardValue)]
    pub fn card_value(&self, card: Js<Card>, depth: Option<f64>) -> Result<Option<f64>, JsValue> {
        let depth = depth_or(depth, 1.0);
        Ok(rules::card_value(&self.employee, &card.decode()?, &self.context, depth, &self.memo))
    }

    #[wasm_bindgen(js_name = cardOutcomes)]
    pub fn card_outcomes(&self, card: Js<Card>) -> Result<Js<Vec<rules::Outcome>>, JsValue> {
        Js::new(&rules::card_outcomes(&self.employee, &card.decode()?, &self.context))
    }

    #[wasm_bindgen(js_name = traitValue)]
    pub fn trait_value(
        &self,
        code: String,
        arg: Option<String>,
        held: bool,
    ) -> Result<Js<rules::TraitResult>, JsValue> {
        let arg = arg.filter(|a| !a.is_empty()).map(Rc::from);
        Js::new(&rules::trait_value(&Code::of(&code), &self.employee, &self.context, arg, held))
    }

    #[wasm_bindgen(js_name = cardPool)]
    pub fn card_pool(
        &self,
        price_fn: JsValue,
        depth: Option<f64>,
    ) -> Result<Js<rules::Pool>, JsValue> {
        let depth = depth_or(depth, 1.0);
        let pool = with_price(&price_fn, |price| {
            rules::card_pool(&self.employee, &self.context, price, depth, &self.memo)
        })?;
        Js::new(&pool)
    }

    #[wasm_bindgen(js_name = trainingOutlook)]
    pub fn training_outlook(
        &self,
        price_fn: JsValue,
        depth: Option<f64>,
    ) -> Result<Js<rules::Outlook>, JsValue> {
        let depth = depth_or(depth, 1.0);
        let o = with_price(&price_fn, |price| {
            rules::training_outlook(&self.employee, &self.context, price, depth, &self.memo)
        })?;
        Js::new(&o)
    }

    #[wasm_bindgen(js_name = secondWindValue)]
    pub fn second_wind_value(
        &self,
        gain: f64,
        depth: Option<f64>,
        price_fn: JsValue,
    ) -> Result<f64, JsValue> {
        let depth = depth_or(depth, 1.0);
        with_price(&price_fn, |price| {
            rules::second_wind_value(&self.employee, gain, &self.context, depth, price, &self.memo)
        })
    }

    #[wasm_bindgen(js_name = futureLuckValue)]
    pub fn future_luck_value(&self, delta: f64) -> f64 {
        rules::future_luck_value(&self.employee, delta, &self.context, &self.memo)
    }

    #[wasm_bindgen(js_name = expectedTrainingValue)]
    pub fn expected_training_value(
        &self,
        depth: Option<f64>,
        price_fn: JsValue,
    ) -> Result<f64, JsValue> {
        let depth = depth_or(depth, 0.0);
        with_price(&price_fn, |price| {
            rules::expected_training_value(&self.employee, &self.context, depth, price, &self.memo)
        })
    }

    #[wasm_bindgen(js_name = potentialValue)]
    pub fn potential_value(&self, potential: f64, alt: f64, training_value: Option<f64>) -> f64 {
        rules::potential_value(
            &self.employee,
            &self.context,
            potential,
            alt,
            training_value,
            &self.memo,
        )
    }

    #[wasm_bindgen(js_name = rolledTraitValue)]
    pub fn rolled_trait_value(&self, genders: Vec<String>) -> f64 {
        rules::rolled_trait_value(&self.employee, &self.context, &genders)
    }

    #[wasm_bindgen(js_name = hourlyProfit)]
    pub fn hourly_profit(&self) -> f64 {
        rules::hourly_profit(&self.employee, &self.context)
    }
    #[wasm_bindgen(js_name = marginPerPoint)]
    pub fn margin_per_point(&self) -> f64 {
        rules::margin_per_point(&self.employee, &self.context)
    }
    #[wasm_bindgen(js_name = careerBonus)]
    pub fn career_bonus(&self, rate: f64) -> f64 {
        rules::career_bonus(&self.employee, rate)
    }

    #[wasm_bindgen(js_name = wildCardOutcomes)]
    pub fn wild_card_outcomes(&self) -> Result<Js<Vec<rules::WildCardOutcome>>, JsValue> {
        Js::new(&rules::wild_card_outcomes(&self.employee, &self.context, &self.memo))
    }

    #[wasm_bindgen(js_name = gameDailyProfit)]
    pub fn game_daily_profit(
        &self,
        card: Js<Card>,
        margin: Option<f64>,
        pp_value: Option<f64>,
    ) -> Result<Option<f64>, JsValue> {
        let c = card.decode()?;
        let (margin, pp_value) = (model::known(margin), model::known(pp_value));
        Ok(rules::game_daily_profit(&self.employee, &c, &self.context, margin, pp_value))
    }

    #[wasm_bindgen(js_name = canNegotiate)]
    pub fn can_negotiate(&self, drop: f64) -> bool {
        rules::can_negotiate(&self.employee, drop)
    }

    /// On the context's situation.
    #[wasm_bindgen(js_name = comparisonProduction)]
    pub fn comparison_production(&self, day: f64) -> f64 {
        rules::comparison_production(&self.employee, &self.context.situation, day)
    }
}

/// `workingDays`: days left to retirement, if known (see `WorkingLife`).
#[wasm_bindgen(js_name = workingDays)]
pub fn working_days(employee: Js<model::WorkingLife>) -> Result<Option<f64>, JsValue> {
    Ok(employee.decode()?.days())
}

/// The wage expectation a reported wage shows: wage / (paid Production /
/// outputDivisor x the PP's money value).
#[wasm_bindgen(js_name = wageExpectation)]
pub fn wage_expectation(wage: f64, paid_production: f64, pp_value: f64) -> f64 {
    wage / (paid_production / cfg::CFG.output_divisor * pp_value)
}

/// Card pricing's horizon: the longest working life among the planned
/// employees, in whole days from 1 to 47.
#[wasm_bindgen(js_name = cardHorizon)]
pub fn card_horizon(working_days: Vec<f64>) -> f64 {
    working_days.iter().copied().fold(0.0, f64::max).ceil().clamp(1.0, 47.0)
}

/// `paidProduction`: the Production the wage is paid on, never below 1;
/// None when the employee's Production is unknown (see `OwnProduction`).
#[wasm_bindgen(js_name = paidProduction)]
pub fn paid_production(employee: Js<model::OwnProduction>) -> Result<Option<f64>, JsValue> {
    Ok(employee.decode()?.paid())
}

/// An item as `gameMargins` reads it: `{ productionPoints, productionNeeds:
/// { need: n } }`. One without known production points is no product.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    production_points: Option<f64>,
    production_needs: Option<OrderedMap<f64>>,
}

impl Item {
    fn production_points(&self) -> f64 {
        model::known(self.production_points).unwrap_or(0.0)
    }
    /// The inputs: each needed item's code and how many a unit takes.
    fn needs(&self) -> &[(String, f64)] {
        self.production_needs.as_ref().map_or(&[], |needs| &needs.0)
    }
}

/// `gameMargins`: the game's own money per PP of each product, as its UI
/// prices profit, `{ code: margin }` in the items' order. `items`: `{ code:
/// item }`; `values`: `{ code: money per embodied PP }`. A unit is worth
/// value x (its PP plus its inputs' PP), less what its inputs are worth; an
/// item without a value takes `pp_value`; a product with an input that has
/// none counts no input cost.
#[wasm_bindgen(js_name = gameMargins)]
pub fn game_margins(
    items: Js<OrderedMap<Option<Item>>>,
    values: Js<OrderedMap<Option<f64>>>,
    pp_value: f64,
) -> Result<Js<OrderedMap<f64>>, JsValue> {
    use std::collections::HashMap;
    let items: Vec<(String, Item)> =
        items.decode()?.0.into_iter().filter_map(|(code, item)| Some((code, item?))).collect();
    let values: HashMap<String, f64> = values
        .decode()?
        .0
        .into_iter()
        .filter_map(|(code, v)| Some((code, v.filter(|&v| v > 0.0)?)))
        .collect();
    let by_code: HashMap<&str, &Item> = items.iter().map(|(code, item)| (&**code, item)).collect();
    let value_of = |code: &str| values.get(code).copied().unwrap_or(pp_value);
    /// The PP a unit embodies: its own and its inputs', all the way down.
    fn embodied_pp<'a>(
        code: &'a str,
        by_code: &HashMap<&'a str, &'a Item>,
        memo: &mut HashMap<&'a str, f64>,
    ) -> f64 {
        if let Some(&v) = memo.get(code) {
            return v;
        }
        let (own, needs): (f64, &[(String, f64)]) =
            by_code.get(code).map_or((0.0, &[]), |item| (item.production_points(), item.needs()));
        let v = own
            + needs.iter().fold(0.0, |sum, (need, n)| sum + n * embodied_pp(need, by_code, memo));
        memo.insert(code, v);
        v
    }
    let mut memo = HashMap::new();
    let mut margins: Vec<(String, f64)> = Vec::new();
    for (code, item) in &items {
        if item.production_points() <= 0.0 {
            continue;
        }
        if item.needs().iter().any(|(need, _)| !values.contains_key(need)) {
            margins.push((code.clone(), value_of(code)));
            continue;
        }
        let inputs = item.needs().iter().fold(0.0, |sum, (need, n)| {
            sum + n * value_of(need) * embodied_pp(need, &by_code, &mut memo)
        });
        margins.push((
            code.clone(),
            (value_of(code) * embodied_pp(code, &by_code, &mut memo) - inputs)
                / item.production_points(),
        ));
    }
    Js::new(&OrderedMap(margins))
}

/// The tool types in index order, as `{ type: [goods] }`.
pub struct ToolTypes;

impl Serialize for ToolTypes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(pricing::TOOL_TYPES.len()))?;
        for (tool_type, goods) in pricing::TOOL_TYPES {
            map.serialize_entry(tool_type, goods)?;
        }
        map.end()
    }
}

/// `TOOL_TYPES`.
#[wasm_bindgen(js_name = toolTypes)]
pub fn tool_types() -> Result<Js<ToolTypes>, JsValue> {
    Js::new(&ToolTypes)
}

/// Luck or Management as the odds read them: one that isn't a finite
/// number counts as none, as a negative one does.
fn stat_or_none(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

/// `toolboxRate`.
#[wasm_bindgen(js_name = toolboxRate)]
pub fn toolbox_rate(luck: f64) -> f64 {
    rules::toolbox_rate(stat_or_none(luck))
}

/// `rarityOdds`: `{ rarity: p }`.
#[wasm_bindgen(js_name = rarityOdds)]
pub fn rarity_odds(luck: f64, management: f64) -> Result<Js<OrderedMap<f64>>, JsValue> {
    let odds = rules::rarity_odds(stat_or_none(luck), stat_or_none(management));
    Js::new(&OrderedMap(
        cfg::Rarity::ALL.iter().zip(odds).map(|(r, p)| (r.code().into(), p)).collect(),
    ))
}

/// `eligibleTraits`: trait ids, of the polarities listed (in the rules'
/// order, whatever the list's).
#[wasm_bindgen(js_name = eligibleTraits)]
pub fn eligible_traits(
    held: Vec<String>,
    gender: Option<String>,
    polarities: Js<Vec<traits::Polarity>>,
) -> Result<Vec<u8>, JsValue> {
    let listed = polarities.decode()?;
    let wanted: Vec<traits::Polarity> =
        rules::ALL_POLARITIES.into_iter().filter(|p| listed.contains(p)).collect();
    Ok(rules::eligible_traits(&trait_codes(&held), gender.as_deref(), &wanted)
        .into_iter()
        .map(|t| t.id())
        .collect())
}

/// `wildCardRisk`; undefined for null.
#[wasm_bindgen(js_name = wildCardRisk)]
pub fn wild_card_risk(held: Vec<String>, gender: Option<String>) -> Option<f64> {
    rules::wild_card_risk(&trait_codes(&held), gender.as_deref())
}

/// `peerProduction`: each row's Production after peer effects.
#[wasm_bindgen(js_name = peerProduction)]
pub fn peer_production(rows: Js<Vec<rules::PeerRow>>) -> Result<Vec<f64>, JsValue> {
    Ok(rules::peer_production(&rows.decode()?))
}

/// `energyOn`: what 10 energy earns elsewhere `day` days from now, in the
/// context's `energyValue`.
#[wasm_bindgen(js_name = energyOn)]
pub fn energy_on(context: Js<Context>, day: f64) -> Result<f64, JsValue> {
    Ok(rules::energy_on(&context.decode()?.energy, day))
}

/// `candidateValue`: a typed-in candidate over their working life, in PP.
#[wasm_bindgen(js_name = candidateValue)]
pub fn candidate_value(
    candidate: Js<fresh::Candidate>,
    options: Js<fresh::CandidateOptions>,
) -> Result<Js<fresh::CandidateValue>, JsValue> {
    Js::new(&fresh::candidate_value(&candidate.decode()?, &options.decode()?))
}

/// `freshSetValue`: what a fresh set of candidates is worth when the pick
/// sees only what a card shows (see fresh.rs).
#[wasm_bindgen(js_name = freshSetValue)]
pub fn fresh_set_value(
    groups: Js<Vec<fresh::Group>>,
    options: Js<fresh::FreshSetOptions>,
) -> Result<FreshSet, JsValue> {
    Ok(FreshSet(Rc::new(fresh::fresh_set_value(&groups.decode()?, &options.decode()?)?)))
}

/// A fresh set's value; `beat(bar)` reads its picks.
#[wasm_bindgen]
pub struct FreshSet(Rc<fresh::FreshSet>);

#[wasm_bindgen]
impl FreshSet {
    /// `{ best, gross, days, rate, average, coworkers }`.
    pub fn summary(&self) -> Result<Js<fresh::Summary>, JsValue> {
        Js::new(&self.0.summary())
    }
    pub fn beat(&self, bar: f64) -> f64 {
        self.0.beat(bar)
    }
}

// --- Careers ---

/// The career simulation of one employee and hand (`careerOptions`): its
/// caches live as long as the handle, across `batch` runs.
#[wasm_bindgen]
pub struct Career(Rc<RefCell<career::Model>>);

#[wasm_bindgen]
impl Career {
    /// The careers of employee `subject` (a place in `snapshot`, see
    /// `career::Model::new`), with the subject's rules, energy and hand.
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot: &Snapshot,
        subject: usize,
        input: Js<career::Subject>,
    ) -> Result<Career, JsValue> {
        if subject >= snapshot.0.employees.len() {
            return Err(js_error("No such employee."));
        }
        let model = career::Model::new(&snapshot.0, subject, input.decode()?).map_err(js_error)?;
        Ok(Career(Rc::new(RefCell::new(model))))
    }
    /// The hand's slots that are arms, after taking nothing.
    pub fn slots(&self) -> Vec<u32> {
        self.0.borrow().slots.clone()
    }
    /// The hand's slots that can't be taken.
    pub fn skipped(&self) -> Vec<u32> {
        self.0.borrow().skipped.clone()
    }
    /// `rules.next` for the first state.
    pub fn next(&self, time: f64) -> f64 {
        career::next_first(&mut self.0.borrow_mut(), time)
    }
    #[wasm_bindgen(js_name = energyCost)]
    pub fn energy_cost(&self, time: f64) -> f64 {
        self.0.borrow().energy_cost(time)
    }
    /// The outcome `rules.apply` picks for the first state.
    #[wasm_bindgen(js_name = applyFirst)]
    pub fn apply_first(&self, card: Js<Card>, draw: f64) -> Result<Js<rules::Outcome>, JsValue> {
        let c = card.decode()?;
        let outcome = career::apply_first(&mut self.0.borrow_mut(), &c, draw).map_err(js_error)?;
        Js::new(&outcome)
    }
    /// `rules.advance` for the first state, from day `from` to day `to`.
    #[wasm_bindgen(js_name = advanceFirst)]
    pub fn advance_first(&self, from: f64, to: f64) -> Result<Js<career::Advanced>, JsValue> {
        let advanced =
            career::advance_first(&mut self.0.borrow_mut(), from, to).map_err(js_error)?;
        Js::new(&advanced)
    }
    /// The hand `rules.hand` deals the first state when every draw is `draw`.
    #[wasm_bindgen(js_name = handFirst)]
    pub fn hand_first(&self, draw: f64) -> Result<Js<Vec<rules::PoolCard>>, JsValue> {
        let cards = career::hand_first(&mut self.0.borrow_mut(), None, draw).map_err(js_error)?;
        Js::new(&cards)
    }
    /// The hand `rules.hand` deals the state after the first card `card`
    /// (its outcome by `pick`), when every draw is `draw`.
    #[wasm_bindgen(js_name = handAfter)]
    pub fn hand_after(
        &self,
        card: Js<Card>,
        pick: f64,
        draw: f64,
    ) -> Result<Js<Vec<rules::PoolCard>>, JsValue> {
        let card = card.decode()?;
        let cards = career::hand_first(&mut self.0.borrow_mut(), Some((&card, pick)), draw)
            .map_err(js_error)?;
        Js::new(&cards)
    }
    /// The work done so far.
    pub fn metrics(&self) -> Result<Js<career::Metrics>, JsValue> {
        Js::new(&self.0.borrow().metrics())
    }
    /// A batch of `count` sampled careers from pair `start`.
    pub fn batch(&self, seed: f64, start: f64, count: f64) -> Result<CareerRun, JsValue> {
        let batch = career::Batch::new(&self.0.borrow(), seed, start, count).map_err(js_error)?;
        Ok(CareerRun { model: self.0.clone(), batch })
    }
}

/// A batch in progress: `step(n)` runs up to n transitions.
#[wasm_bindgen]
pub struct CareerRun {
    model: Rc<RefCell<career::Model>>,
    batch: career::Batch,
}

/// A batch's result: `{ version, start, n, mean, m2, curve, decisions,
/// candidates, transitions, rerolls, projections, pools }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerResult<'a> {
    version: f64,
    start: f64,
    #[serde(rename = "n")]
    count: f64,
    mean: &'a [f64],
    m2: &'a [Vec<f64>],
    curve: &'a [Vec<f64>],
    decisions: f64,
    candidates: f64,
    transitions: f64,
    rerolls: f64,
    projections: f64,
    pools: f64,
}

#[wasm_bindgen]
impl CareerRun {
    /// True once every career is done.
    pub fn step(&mut self, transitions: u32) -> Result<bool, JsValue> {
        self.batch.step(&mut self.model.borrow_mut(), transitions).map_err(js_error)
    }
    pub fn progress(&self) -> Result<Js<career::Progress>, JsValue> {
        Js::new(&self.batch.progress())
    }
    pub fn result(&self) -> Result<Js<CareerResult<'static>>, JsValue> {
        let (batch, model) = (&self.batch, self.model.borrow());
        Js::new(&CareerResult {
            version: career::VERSION,
            start: batch.start,
            count: batch.stats.count,
            mean: &batch.stats.mean,
            m2: &batch.stats.m2,
            curve: &batch.stats.curve,
            decisions: batch.decisions,
            candidates: batch.candidates,
            transitions: batch.transitions,
            rerolls: batch.rerolls,
            projections: model.projections,
            pools: model.pools,
        })
    }
}

/// The career simulation's constants: `{ version, maxRerolls }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerConstants {
    version: f64,
    max_rerolls: u32,
}

#[wasm_bindgen(js_name = careerConstants)]
pub fn career_constants() -> Result<Js<CareerConstants>, JsValue> {
    Js::new(&CareerConstants { version: career::VERSION, max_rerolls: career::MAX_REROLLS })
}

/// `EmployeeCareer.random`: the arguments cross as int32s (the facade's
/// `x | 0`).
#[wasm_bindgen(js_name = careerRandom)]
pub fn career_random(seed: i32, pair: i32, step: i32, purpose: i32) -> f64 {
    career::random_from_int32s(seed, pair, step, purpose)
}

/// A batch's `n`, if it has one.
#[derive(Deserialize)]
struct SampleCount {
    #[serde(rename = "n")]
    count: Option<f64>,
}
/// What `careerCompare` reads of a batch: `{ n, mean, m2 }`.
#[derive(Deserialize)]
pub struct Moments {
    #[serde(rename = "n")]
    count: f64,
    mean: Vec<f64>,
    m2: Vec<Vec<f64>>,
}

/// `EmployeeCareer.merge`: two batches' stats as one; an empty one (no
/// `n`) gives the other back as it is.
#[wasm_bindgen(js_name = careerMerge)]
pub fn career_merge(
    a: Js<career::Stats>,
    b: Js<career::Stats>,
) -> Result<Js<career::Stats>, JsValue> {
    let has_samples = |v: &JsValue| {
        serde_wasm_bindgen::from_value::<Option<SampleCount>>(v.clone())
            .ok()
            .flatten()
            .and_then(|c| c.count)
            .is_some_and(|n| n > 0.0)
    };
    if !has_samples(a.value()) {
        return Ok(b);
    }
    if !has_samples(b.value()) {
        return Ok(a);
    }
    let merged = career::merge(&a.decode()?, &b.decode()?).map_err(js_error)?;
    Js::new(&merged)
}

/// `EmployeeCareer.compare`: arm i against arm j of a batch (null standard
/// error below two samples); an error when the batch has no such arm.
#[wasm_bindgen(js_name = careerCompare)]
pub fn career_compare(
    stats: Js<Moments>,
    i: usize,
    j: usize,
) -> Result<Js<career::Comparison>, JsValue> {
    let moments = stats.decode()?;
    let mean = |k: usize| moments.mean.get(k).copied();
    let m2 = |a: usize, b: usize| moments.m2.get(a).and_then(|row| row.get(b)).copied();
    let (Some(mean_i), Some(mean_j), Some(m2_ii), Some(m2_jj), Some(m2_ij)) =
        (mean(i), mean(j), m2(i, i), m2(j, j), m2(i, j))
    else {
        return Err(js_error("No such arm."));
    };
    Js::new(&career::compare(moments.count, mean_i, mean_j, m2_ii, m2_jj, m2_ij))
}

// --- Card pricing and retention ---

/// `EmployeePlanner.cardSession`'s pricing over its prepared snapshot
/// (see pricing.rs). Its caches live as long as the handle.
#[wasm_bindgen]
pub struct CardSession(pricing::CardSession);

#[wasm_bindgen]
impl CardSession {
    /// Over `snapshot` (with its exclusions and horizon); `unpriced`: trait
    /// ids whose rows say unpriced.
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot: &Snapshot,
        allow_moves: bool,
        unpriced: Vec<u8>,
    ) -> Result<CardSession, JsValue> {
        planned_period(&snapshot.0)?;
        Ok(CardSession(pricing::CardSession::new(
            pricing::Roster::new(&snapshot.0),
            allow_moves,
            &unpriced,
        )))
    }
    /// The planned companies' employees (indices): plans' equipment order.
    pub fn people(&self) -> Vec<u32> {
        self.0.people().iter().map(|&i| i as u32).collect()
    }
    /// Plan `index` of a state a price made.
    pub fn plan(&self, state: u32, index: usize) -> Result<Js<pricing::Plan>, JsValue> {
        Js::new(self.0.plan(state, index).ok_or_else(|| js_error("No such plan."))?)
    }
    /// One price: the inputs merged by the facade.
    pub fn price(
        &mut self,
        input: Js<pricing::Inputs>,
    ) -> Result<Js<pricing::PriceResult>, JsValue> {
        Js::new(&self.0.price(input.decode()?).into())
    }
}

/// `EmployeePlanner.retentionSession`'s projections over its snapshot.
#[wasm_bindgen]
pub struct RetentionSession(pricing::Retention);

#[wasm_bindgen]
impl RetentionSession {
    /// Over `snapshot` (with its exclusions).
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot: &Snapshot) -> RetentionSession {
        RetentionSession(pricing::Retention::new(pricing::Roster::new(&snapshot.0)))
    }
    /// Employee `employee`'s company with and without them; throws for one
    /// who isn't in a planned company.
    pub fn price(&mut self, employee: usize) -> Result<Js<pricing::Kept>, JsValue> {
        Js::new(&self.0.price(employee).map_err(|f| js_error(f.message()))?)
    }
}

/// The keep step and recruiting over a snapshot (`EmployeePlanner.keepSession`,
/// keep.rs): employees by place in the snapshot, rosters as `{ company,
/// without }` (company by place, the employee left out by place or none).
#[wasm_bindgen]
pub struct KeepSession(keep::Session);

#[wasm_bindgen]
impl KeepSession {
    /// Over `snapshot` (with its exclusions, which retention reads); throws
    /// without its PP value.
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot: &Snapshot) -> Result<KeepSession, JsValue> {
        keep::Session::new(&snapshot.0)
            .map(KeepSession)
            .ok_or_else(|| js_error("The keep step needs the snapshot's PP value."))
    }
    /// Employee `employee` in their company as the rules read them: `{
    /// employee, context }`, the plain objects the rules decode. `options`
    /// is `{ energyValue, coworkers }`: what 10 energy earns elsewhere (a
    /// number or a list by day), and whether each coworker is a model in
    /// their own context (the default).
    pub fn model(
        &self,
        employee: usize,
        options: Js<keep::ModelOptions>,
    ) -> Result<Js<keep::Model>, JsValue> {
        Js::new(&self.0.model(employee, options.decode()?).map_err(js_error)?)
    }
    /// Employee `employee`'s company with and without them (retention), as
    /// `RetentionSession.price`; kept for their row.
    pub fn retention(&mut self, employee: usize) -> Result<Js<pricing::Kept>, JsValue> {
        Js::new(&self.0.retention(employee).map_err(js_error)?)
    }
    /// One step of building what employee `employee`'s row reads (the
    /// newcomer's tables and the coworker grid of the company without
    /// them); true once it is ready.
    pub fn prepare(&mut self, employee: usize) -> Result<bool, JsValue> {
        self.0.prepare(employee).map_err(js_error)
    }
    /// Employee `employee`'s keep row: `feed` is `{ alt, trainingValue,
    /// energyValue }`.
    pub fn row(&mut self, employee: usize, feed: Js<keep::Feed>) -> Result<Js<keep::Row>, JsValue> {
        Js::new(&self.0.row(employee, feed.decode()?).map_err(js_error)?)
    }
    /// A fresh set in `roster`: `options` is `{ alt, slots }`.
    #[wasm_bindgen(js_name = freshSet)]
    pub fn fresh_set(
        &mut self,
        roster: Js<keep::RosterInput>,
        options: Js<keep::SetOptions>,
    ) -> Result<FreshSet, JsValue> {
        let roster = self.0.roster(roster.decode()?).map_err(js_error)?;
        Ok(FreshSet(self.0.fresh_set_for(roster, options.decode()?)))
    }
    /// What `newcomer` (`{ nationality, gender, production, wage }`) does to
    /// the traits of `roster`'s employees: `{ value, notes: [{ employee,
    /// trait }] }`.
    pub fn impact(
        &mut self,
        roster: Js<keep::RosterInput>,
        newcomer: Js<keep::NewcomerInput>,
    ) -> Result<Js<keep::Impact>, JsValue> {
        let roster = self.0.roster(roster.decode()?).map_err(js_error)?;
        Js::new(&*self.0.impact(roster, newcomer.decode()?))
    }
    /// A typed candidate (`candidateValue`'s) who is `newcomer` joining
    /// `roster`: `{ value, place }`; `options` is `{ alt }`.
    pub fn candidate(
        &mut self,
        roster: Js<keep::RosterInput>,
        newcomer: Js<keep::NewcomerInput>,
        candidate: Js<fresh::Candidate>,
        options: Js<keep::CandidateInput>,
    ) -> Result<Js<keep::Priced>, JsValue> {
        let roster = self.0.roster(roster.decode()?).map_err(js_error)?;
        let priced =
            self.0.candidate(roster, newcomer.decode()?, &candidate.decode()?, options.decode()?);
        Js::new(&priced)
    }
}

// --- The planner ---

/// The snapshot's planning period, which every projection of it runs for:
/// an input error unless its days, and its hours if given, are a finite
/// number from 0 (the tool timelines run for the days).
fn planned_period(snapshot: &snapshot::Snapshot) -> Result<(), JsValue> {
    let (days, hours) = (snapshot.days, snapshot.hours);
    if days.is_finite() && days >= 0.0 && hours.is_none_or(|hours| hours >= 0.0) {
        Ok(())
    } else {
        Err(js_error("The planning period must be a known number of days."))
    }
}

/// An input error unless every number the projection reads is known where
/// `env` plans (`check::numbers_known`).
fn numbers_known(env: &planner::Env) -> Result<(), JsValue> {
    if check::numbers_known(env) { Ok(()) } else { Err(js_error(check::UNKNOWN_NUMBERS)) }
}

/// `recommend`'s search over a snapshot, a round at a time: `step()` runs
/// one and says whether to go on (the facade reports progress between
/// them), `result(partial)` gives the result so far, marked `partial` as the
/// facade says, and `outputOnly()` the output-only comparison after the
/// search (`planner::output_only`), or `outputOnlyTerms()` the terms for
/// one an `OutputOnlySearch` made alongside it.
#[wasm_bindgen]
pub struct Recommend {
    search: planner::Search,
    /// The snapshot searched (with its exclusions).
    snapshot: Rc<snapshot::Snapshot>,
    switches: Option<switch::SwitchContext>,
    /// The proposed plan's value, from the last `result` (None before one).
    value: Option<f64>,
    /// The output-only comparison, once made.
    comparison: Option<planner::OutputOnly>,
}

/// The output-only comparison: `{ alternative, scored, selected, planned }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputOnlyResult<'a> {
    alternative: planner::SearchOut<'a>,
    scored: Option<&'a planner::Totals>,
    selected: bool,
    planned: usize,
}

impl OutputOnlyResult<'_> {
    fn of(
        comparison: &mut planner::OutputOnly,
    ) -> Result<Js<Option<OutputOnlyResult<'static>>>, JsValue> {
        let alternative = comparison.alternative.result(/* partial */ false);
        Js::new(&Some(OutputOnlyResult {
            alternative,
            scored: comparison.scored.as_ref(),
            selected: comparison.selected,
            planned: comparison.planned,
        }))
    }
}

#[wasm_bindgen]
impl Recommend {
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot: &Snapshot,
        options: Js<planner::RecommendInput>,
    ) -> Result<Recommend, JsValue> {
        planned_period(&snapshot.0)?;
        let input = options.decode()?;
        let options = input.options();
        let switches = input.switches.map(switch::SwitchContext::new);
        let search =
            planner::Search::new(planner::Plan::new(&snapshot.0), switches.clone(), options);
        numbers_known(&search.env)?;
        Ok(Recommend {
            search,
            snapshot: snapshot.0.clone(),
            switches,
            value: None,
            comparison: None,
        })
    }
    pub fn step(&mut self) -> Result<bool, JsValue> {
        Ok(self.search.step())
    }
    pub fn result(&mut self, partial: bool) -> Result<Js<planner::SearchOut<'static>>, JsValue> {
        let r = self.search.result(partial);
        let value = r.value();
        let out = Js::new(&r)?;
        self.value = Some(value);
        Ok(out)
    }
    /// After `result(false)`: the comparison, or null when it isn't made
    /// (also before any result, with no plan to compare).
    #[wasm_bindgen(js_name = outputOnly)]
    pub fn output_only(&mut self) -> Result<Js<Option<OutputOnlyResult<'static>>>, JsValue> {
        let Some(comparison) = self.value.and_then(|value| {
            planner::output_only(&self.search, &self.snapshot, self.switches.clone(), value)
        }) else {
            return Js::new(&None);
        };
        OutputOnlyResult::of(self.comparison.insert(comparison))
    }
    /// After `result(false)`: the output-only comparison's terms, `{ budget,
    /// value }`, for an `OutputOnlySearch` to settle on, or null when the
    /// comparison isn't made (also before any result).
    #[wasm_bindgen(js_name = outputOnlyTerms)]
    pub fn output_only_terms(&self) -> Result<Js<Option<planner::Terms>>, JsValue> {
        let terms = self.value.and_then(|value| {
            planner::Comparison::budget(&self.search).map(|budget| planner::Terms { budget, value })
        });
        Js::new(&terms)
    }
    /// Projections run so far (`P.misses`).
    pub fn projections(&self) -> f64 {
        self.search.env.misses
    }
    pub fn floor(&self) -> f64 {
        self.search.floor()
    }
}

/// `recommend`'s output-only comparison, searched alongside the main search
/// (in another worker) over the same snapshot and options: `step()` runs a
/// round and says whether to go on, with the most projections the main
/// search can leave; `settle(terms)` takes its `outputOnlyTerms()` once it
/// has finished, holding the search to that budget (starting again if it
/// has already projected past it); `result()` finishes the search and gives
/// what `Recommend.outputOnly()` would have.
#[wasm_bindgen]
pub struct OutputOnlySearch {
    /// The main search as it starts, which the comparison is built from.
    primary: planner::Search,
    snapshot: Rc<snapshot::Snapshot>,
    switches: Option<switch::SwitchContext>,
    /// None when the comparison isn't made.
    comparison: Option<planner::Comparison>,
    terms: Option<planner::Terms>,
    result: Option<planner::OutputOnly>,
}

#[wasm_bindgen]
impl OutputOnlySearch {
    #[wasm_bindgen(constructor)]
    pub fn new(
        snapshot: &Snapshot,
        options: Js<planner::RecommendInput>,
    ) -> Result<OutputOnlySearch, JsValue> {
        planned_period(&snapshot.0)?;
        let input = options.decode()?;
        let options = input.options();
        let switches = input.switches.map(switch::SwitchContext::new);
        let primary =
            planner::Search::new(planner::Plan::new(&snapshot.0), switches.clone(), options);
        numbers_known(&primary.env)?;
        let comparison = planner::Comparison::budget(&primary).map(|budget| {
            planner::Comparison::new(&primary, &snapshot.0, switches.clone(), budget)
        });
        Ok(OutputOnlySearch {
            primary,
            snapshot: snapshot.0.clone(),
            switches,
            comparison,
            terms: None,
            result: None,
        })
    }
    pub fn step(&mut self) -> bool {
        self.comparison.as_mut().is_some_and(planner::Comparison::step)
    }
    /// The main search's terms (`Recommend.outputOnlyTerms()`).
    pub fn settle(&mut self, terms: Js<planner::Terms>) -> Result<(), JsValue> {
        let terms = terms.decode()?;
        if let Some(comparison) = &mut self.comparison {
            if comparison.within(terms.budget) {
                comparison.limit(terms.budget);
            } else {
                *comparison = planner::Comparison::new(
                    &self.primary,
                    &self.snapshot,
                    self.switches.clone(),
                    terms.budget,
                );
            }
        }
        self.terms = Some(terms);
        Ok(())
    }
    /// After `settle`: the comparison, or null when it isn't made.
    pub fn result(&mut self) -> Result<Js<Option<OutputOnlyResult<'static>>>, JsValue> {
        let Some(terms) = self.terms else {
            return Err(js_error("The output-only comparison has no terms yet: settle it first."));
        };
        if let Some(mut comparison) = self.comparison.take() {
            while comparison.step() {}
            self.result = Some(comparison.finish(&self.snapshot, terms.value));
        }
        match &mut self.result {
            Some(result) => OutputOnlyResult::of(result),
            None => Js::new(&None),
        }
    }
}

/// `validate(s, arrangement)`: the problems, in check order (see
/// `check::validate`). `arrangement`: `[{ employee, company, tool }]` by id.
#[wasm_bindgen]
pub fn validate(
    snapshot: &Snapshot,
    arrangement: Js<Vec<check::Assignment>>,
) -> Result<Js<Vec<check::Problem>>, JsValue> {
    let arrangement = arrangement.decode()?;
    let entries = check::ArrangementEntry::read(&snapshot.0, &arrangement);
    let env = planner::Env::new(planner::Plan::new(&snapshot.0));
    Js::new(&check::validate(&env, &entries))
}

/// `uncertainty` of every employee: those the planner can't reproduce, in
/// snapshot order.
#[wasm_bindgen]
pub fn uncertainty(snapshot: &Snapshot) -> Result<Js<Vec<check::Uncertainty>>, JsValue> {
    Js::new(&check::uncertainties(&snapshot.0))
}

/// A row `riskWarnings` reads: `{ id, minHappiness }`, the employee's id
/// and their lowest projected happiness.
#[derive(Deserialize)]
pub struct RiskRow {
    id: Option<String>,
    #[serde(rename = "minHappiness")]
    min_happiness: Option<f64>,
}

/// `riskWarnings`' rule over rows `[{ id, minHappiness }]` (the last
/// employee with the id): the indices of the rows whose employee may quit.
#[wasm_bindgen(js_name = quitRisks)]
pub fn quit_risks(snapshot: &Snapshot, rows: Js<Vec<RiskRow>>) -> Result<Vec<u32>, JsValue> {
    let rows = rows.decode()?;
    let s = &snapshot.0;
    Ok(rows
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            s.last_employee(project::intern_optional(r.id.as_deref())).is_some_and(|e| {
                r.min_happiness.is_some_and(|h| check::may_quit(&s.employees[e].record, h))
            })
        })
        .map(|(i, _)| i as u32)
        .collect())
}

/// `evaluate`'s totals under `arrangement` (`[{ employee, company, tool }]`
/// by id).
#[wasm_bindgen]
pub fn evaluate(
    snapshot: &Snapshot,
    arrangement: Js<Vec<check::Assignment>>,
) -> Result<Js<planner::Totals>, JsValue> {
    planned_period(&snapshot.0)?;
    let assignment = check::placements(&snapshot.0, &arrangement.decode()?);
    let mut env = planner::Env::new(planner::Plan::new(&snapshot.0));
    numbers_known(&env)?;
    let totals = env.totals(&assignment, /* rows */ true);
    Js::new(&totals)
}

/// `withExclusions`' stat check, skipping the companies at the places in
/// `skip`.
#[wasm_bindgen(js_name = observedMismatches)]
pub fn observed_mismatches(
    snapshot: &Snapshot,
    skip: Vec<u32>,
) -> Result<Js<Vec<planner::Mismatch>>, JsValue> {
    let mut env = planner::Env::new(planner::Plan::new(&snapshot.0));
    let mut skipped = vec![false; snapshot.0.companies.len()];
    for place in skip {
        if let Some(s) = skipped.get_mut(place as usize) {
            *s = true;
        }
    }
    Js::new(&env.observed_mismatches(&skipped))
}

/// `EmployeePlanner.singleSwitches` on a snapshot through `withExclusions`.
#[wasm_bindgen(js_name = singleSwitches)]
pub fn single_switches(
    snapshot: &Snapshot,
    switches: Js<switch::SwitchInput>,
) -> Result<Js<switch::SingleSwitches>, JsValue> {
    planned_period(&snapshot.0)?;
    let env = planner::Env::new(planner::Plan::new(&snapshot.0));
    numbers_known(&env)?;
    let switches = switch::SwitchContext::new(switches.decode()?);
    Js::new(&switch::single_switches(env, &switches))
}

/// `switchContext`'s goods, best at the worse price first.
#[wasm_bindgen(js_name = switchCodes)]
pub fn switch_codes(switches: Js<switch::SwitchInput>) -> Result<Vec<String>, JsValue> {
    let switches = switch::SwitchContext::new(switches.decode()?);
    Ok(switches
        .codes
        .iter()
        .map(|&c| project::string(c).map(|s| s.to_string()).unwrap_or_default())
        .collect())
}

/// `priceSets`: today's and the game's margins as tables (the facade
/// builds the objects and functions).
#[wasm_bindgen(js_name = priceSets)]
pub fn price_sets(input: Js<switch::PriceSetsInput>) -> Result<Js<switch::PriceSets>, JsValue> {
    Js::new(&input.decode()?.into())
}

/// `EmployeePlanner.retool`: a company re-tooled onto a good.
#[wasm_bindgen]
pub fn retool(input: Js<switch::RetoolInput>) -> Result<Js<switch::RetoolOut>, JsValue> {
    Js::new(&input.decode()?.retool())
}

/// `EmployeePlanner.evaluateRetooled`: one company re-tooled where it
/// stands, as Top Products tries it, and projected.
#[wasm_bindgen(js_name = evaluateRetooled)]
pub fn evaluate_retooled(
    snapshot: &Snapshot,
    input: Js<switch::RetooledInput>,
) -> Result<Js<switch::RetooledTotals>, JsValue> {
    planned_period(&snapshot.0)?;
    let switch::RetooledInput { company, product, switches, arrangement } = input.decode()?;
    let env = planner::Env::new(planner::Plan::new(&snapshot.0));
    numbers_known(&env)?;
    let arrangement = arrangement.map(|a| check::placements(&snapshot.0, &a));
    let switches = switch::SwitchContext::new(switches);
    Js::new(&switch::evaluate_retooled(env, &switches, company, &product, arrangement))
}

/// The planner's minimum gain (`CHURN`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Churn {
    price_uncertainty: f64,
    floor_share: f64,
    floor_min: f64,
    recent_hours: f64,
    recent_factor: f64,
}

/// Saved specialisation: a percent a day, up to a cap.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Specialization {
    percent_per_day: f64,
    max_percent: f64,
}

/// The planner's and product switching's constants: `{ churn,
/// specialization, changeItemCost, spikeRatio }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerConstants {
    churn: Churn,
    specialization: Specialization,
    change_item_cost: f64,
    spike_ratio: f64,
}

#[wasm_bindgen(js_name = plannerConstants)]
pub fn planner_constants() -> Result<Js<PlannerConstants>, JsValue> {
    use planner::churn::*;
    Js::new(&PlannerConstants {
        churn: Churn {
            price_uncertainty: PRICE_UNCERTAINTY,
            floor_share: FLOOR_SHARE,
            floor_min: FLOOR_MIN,
            recent_hours: RECENT_HOURS,
            recent_factor: RECENT_FACTOR,
        },
        specialization: Specialization {
            percent_per_day: switch::PERCENT_PER_DAY,
            max_percent: switch::MAX_PERCENT,
        },
        change_item_cost: switch::CHANGE_ITEM_COST,
        spike_ratio: switch::SPIKE_RATIO,
    })
}
