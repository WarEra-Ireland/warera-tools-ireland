//! Product switching (the planner's `priceSets`, `retool`, `switchContext`,
//! `singleSwitches` and `evaluateRetooled` in js/employee-planner.js): the
//! two price sets, a company re-tooled onto another good, Top Products'
//! single switches, and one company re-tooled where it stands and projected.
//!
//! The regional bonus (`computeProductionBonus`, shared.js) stays a page
//! function: the facade calls it per company and good and hands the
//! results over (`regional`).
//!
//! The game's rules for a switch:
//! - It costs `changeItemCost` (5) concrete. There is no cooldown and
//!   nothing else resets: employees stay, so tenure, Creature of Habit and
//!   the recently-moved happiness stay as they are. Stored production is PP
//!   and carries over to the new good.
//! - Saved specialisation is stored per good in days and never decays; the
//!   game reads it as min(days * percentPerDay, maxPercent). Only the
//!   current good gains a day. Switching back resumes from the saved days.
//! - Held tools stay equipped when the new good takes the same tool type;
//!   otherwise they go back to inventory as spares.
//! - The regional bonus is per good and boosts the automated engine only.
//!   It is 0 everywhere while deposits are disabled.
//! - Specialist's good is its trait arg; Craftsman and Laborer follow the
//!   item type. The planner reads both from the company, so they follow a
//!   switch with no change to the employees.

use crate::check::Assignment;
use crate::model::known;
use crate::planner::{
    Env, Holder, LiveAndGame, Placement, Plan, PlanCompany, SavedDaysOverride, Totals, churn,
    tool_type_id,
};
use crate::project::{intern, string};
use crate::snapshot::OrderedMap;
use crate::sort::{sort_list, sort_places};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::HashMap;
use std::rc::Rc;

pub const PERCENT_PER_DAY: f64 = 1.0;
pub const MAX_PERCENT: f64 = 20.0;
pub const CHANGE_ITEM_COST: f64 = 5.0;
/// Live margin over the game's average margin above which a good's price
/// is treated as a spike that may soon drop.
pub const SPIKE_RATIO: f64 = 1.25;

/// Saved specialisation as a percentage, from the days saved on a good.
pub fn saved_specialization(days: f64) -> f64 {
    (days * PERCENT_PER_DAY).clamp(0.0, MAX_PERCENT)
}

/// Days for a switch's cost to pay back at `gross` a day: 0 without a cost,
/// infinite without a gain.
pub fn payback(cost: Option<f64>, gross: f64) -> f64 {
    match cost {
        Some(cost) if cost != 0.0 => {
            if gross > 0.0 {
                cost / gross
            } else {
                f64::INFINITY
            }
        }
        _ => 0.0,
    }
}

/// A good's margin in a price set.
#[derive(Clone, Copy)]
pub struct CodeMargin {
    pub code: u32,
    pub margin: f64,
}

/// The price sets: `live` from the market list, `game` from the game's
/// average margins, each a list of margins by code in the order given (a
/// repeated code keeps its first place and its last value).
#[derive(Clone)]
pub struct PriceSets {
    pub live_entries: Vec<CodeMargin>,
    pub game_entries: Vec<CodeMargin>,
    live_map: HashMap<u32, f64>,
    game_map: HashMap<u32, f64>,
    pub spike_ratio: f64,
}

/// A set's margins by code, a later margin for a code replacing the first
/// in its place.
fn entries(list: &[(String, f64)]) -> Vec<CodeMargin> {
    let mut out: Vec<CodeMargin> = Vec::new();
    for (code, v) in list {
        let k = intern(code);
        match out.iter_mut().find(|x| x.code == k) {
            Some(x) => x.margin = *v,
            None => out.push(CodeMargin { code: k, margin: *v }),
        }
    }
    out
}

/// The known margins of a `{ code: margin }` object, in its order.
fn known_margins(map: OrderedMap<Option<f64>>) -> Vec<(String, f64)> {
    map.0.into_iter().filter_map(|(code, v)| Some((code, known(v)?))).collect()
}

/// `priceSets`' input: `{ list: [{ code, perPP }], gameMargin: { code:
/// margin }, spikeRatio }`, today's margins from the market list and the
/// game's average ones. A margin that isn't a finite number is left out.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceSetsInput {
    list: Vec<ListedPrice>,
    game_margin: Option<OrderedMap<Option<f64>>>,
    spike_ratio: Option<f64>,
}

/// A market list entry: `{ code, perPP }`.
#[derive(Deserialize)]
struct ListedPrice {
    code: String,
    #[serde(rename = "perPP")]
    per_pp: Option<f64>,
}

impl From<PriceSetsInput> for PriceSets {
    /// An unknown spike ratio is `SPIKE_RATIO`.
    fn from(input: PriceSetsInput) -> PriceSets {
        let live: Vec<(String, f64)> =
            input.list.into_iter().filter_map(|x| Some((x.code, known(x.per_pp)?))).collect();
        let game = input.game_margin.map(known_margins).unwrap_or_default();
        PriceSets::new(&live, &game, known(input.spike_ratio).unwrap_or(SPIKE_RATIO))
    }
}

/// `{ live: { code: margin }, game: { code: margin }, codes: [{ code, live,
/// game, worse, ratio, spike }] }`: per code (live's first, then game's),
/// the two margins (null if unset), the lower of them, live over game and
/// whether live spikes.
impl Serialize for PriceSets {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct CodeRow {
            code: Rc<str>,
            live: Option<f64>,
            game: Option<f64>,
            worse: Option<f64>,
            ratio: Option<f64>,
            spike: bool,
        }
        let rows: Vec<CodeRow> = self
            .codes()
            .into_iter()
            .map(|c| CodeRow {
                code: string(c).unwrap_or_default(),
                live: self.live(c),
                game: self.game(c),
                worse: self.worse(c),
                ratio: self.ratio(c),
                spike: self.spike(c),
            })
            .collect();
        let margins = |list: &[CodeMargin]| {
            OrderedMap(
                list.iter()
                    .map(|x| (string(x.code).unwrap_or_default().to_string(), x.margin))
                    .collect(),
            )
        };
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("live", &margins(&self.live_entries))?;
        m.serialize_entry("game", &margins(&self.game_entries))?;
        m.serialize_entry("codes", &rows)?;
        m.end()
    }
}

impl PriceSets {
    pub fn new(list: &[(String, f64)], game: &[(String, f64)], spike_ratio: f64) -> PriceSets {
        let (live, game) = (entries(list), entries(game));
        PriceSets {
            live_map: live.iter().map(|x| (x.code, x.margin)).collect(),
            game_map: game.iter().map(|x| (x.code, x.margin)).collect(),
            live_entries: live,
            game_entries: game,
            spike_ratio,
        }
    }
    pub fn live(&self, code: u32) -> Option<f64> {
        self.live_map.get(&code).copied()
    }
    pub fn game(&self, code: u32) -> Option<f64> {
        self.game_map.get(&code).copied()
    }
    /// The lower of the two, or the one known.
    pub fn worse(&self, code: u32) -> Option<f64> {
        match (self.live(code), self.game(code)) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
    /// live / game, or None without both (and a positive game margin).
    pub fn ratio(&self, code: u32) -> Option<f64> {
        match (self.live(code), self.game(code)) {
            (Some(l), Some(g)) if g > 0.0 => Some(l / g),
            _ => None,
        }
    }
    pub fn spike(&self, code: u32) -> bool {
        let (Some(l), Some(g)) = (self.live(code), self.game(code)) else {
            return false;
        };
        if g > 0.0 { l / g > self.spike_ratio } else { l > 0.0 }
    }
    /// Every code either set has, live's first.
    pub fn codes(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self.live_entries.iter().map(|x| x.code).collect();
        for x in &self.game_entries {
            if !out.contains(&x.code) {
                out.push(x.code);
            }
        }
        out
    }
}

/// Where a switched company came from: `switch.from` and `switch.fromType`
/// (0 when unset).
#[derive(Clone, Copy)]
pub struct SwitchOrigin {
    pub from: u32,
    pub from_type: u32,
}

/// What `retool` reads of a company.
pub struct CompanyBase {
    pub product: u32,
    pub item_type: u32,
    /// Its margin, when known.
    pub margin: Option<f64>,
    pub engine_bonus: f64,
    pub engine_daily_prod: f64,
    /// `company.switch`, if it has one.
    pub switch: Option<SwitchOrigin>,
}
/// A company re-tooled onto a good: its fields and `switch`.
pub struct Retooled {
    pub item_type: u32,
    /// The margin on the good, when known.
    pub margin: Option<f64>,
    pub engine_bonus: f64,
    pub from: u32,
    pub from_type: u32,
    pub cost: Option<f64>,
    pub concrete: f64,
    pub tool_type_changes: bool,
    pub engine_daily: f64,
}

/// `retool`: `margin` is `ctx.margins?.[product]` when known, `item_type`
/// is `ctx.types?.[product]` (None for null or undefined), `regional` the
/// regional bonus's total / 100 if there is one. The same good is no
/// switch and costs nothing, and keeps the company's margin when the
/// context has none for it.
pub fn retool(
    company: &CompanyBase,
    product: u32,
    margin: Option<f64>,
    item_type: Option<u32>,
    regional: Option<f64>,
    change_item_cost: Option<f64>,
    concrete_price: Option<f64>,
) -> Retooled {
    let same = product == company.product;
    let margin = margin.or(if same { company.margin } else { None });
    let item_type = item_type.unwrap_or(if same { company.item_type } else { 0 });
    let engine_bonus = match regional {
        Some(r) => r,
        None => {
            if same {
                company.engine_bonus
            } else {
                0.0
            }
        }
    };
    let concrete = if same { 0.0 } else { change_item_cost.unwrap_or(CHANGE_ITEM_COST) };
    let cost =
        if concrete == 0.0 { Some(0.0) } else { concrete_price.map(|price| concrete * price) };
    let (from, from_type) = match company.switch {
        Some(origin) => (
            if origin.from != 0 { origin.from } else { company.product },
            if origin.from_type != 0 { origin.from_type } else { company.item_type },
        ),
        None => (company.product, company.item_type),
    };
    Retooled {
        item_type,
        margin,
        engine_bonus,
        from,
        from_type,
        cost,
        concrete,
        tool_type_changes: tool_type_id(company.product) != tool_type_id(product),
        engine_daily: company.engine_daily_prod * (1.0 + engine_bonus),
    }
}

/// `retool`'s input: `{ company, product, margin, type, regional,
/// changeItemCost, concretePrice }`: a snapshot company and the good, with
/// the good's margin, item type and regional bonus from the caller's
/// switch context (unknown when unset), a switch's concrete (unknown:
/// `CHANGE_ITEM_COST`) and concrete's unit price (unknown: no cost).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetoolInput {
    company: RetoolCompany,
    product: String,
    margin: Option<f64>,
    #[serde(rename = "type")]
    item_type: Option<String>,
    regional: Option<f64>,
    change_item_cost: Option<f64>,
    concrete_price: Option<f64>,
}

/// What `retool` reads of a snapshot company: `{ product, type, margin,
/// engineBonus, engineDailyProd, switch: { from, fromType } }`. A margin
/// that isn't a finite number is unknown; unknown engine numbers are 0.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetoolCompany {
    product: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
    margin: Option<f64>,
    engine_bonus: Option<f64>,
    engine_daily_prod: Option<f64>,
    switch: Option<SwitchOriginInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchOriginInput {
    from: Option<String>,
    from_type: Option<String>,
}

/// A company re-tooled: `{ type, margin, engineBonus, switch }`; the
/// margin is null when neither the context nor (on its own good) the
/// company has one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetoolOut {
    r#type: Option<Rc<str>>,
    margin: Option<f64>,
    engine_bonus: f64,
    switch: SwitchOut,
}

/// A company's switch: `{ from, fromType, to, cost, concrete,
/// toolTypeChanges, engineDaily }` (engineDaily: engine PP a day).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SwitchOut {
    from: Option<Rc<str>>,
    from_type: Option<Rc<str>>,
    to: String,
    cost: Option<f64>,
    concrete: f64,
    tool_type_changes: bool,
    engine_daily: f64,
}

impl RetoolInput {
    pub fn retool(self) -> RetoolOut {
        let id = |s: &Option<String>| s.as_deref().map_or(0, intern);
        let c = &self.company;
        let base = CompanyBase {
            product: id(&c.product),
            item_type: id(&c.item_type),
            margin: known(c.margin),
            engine_bonus: known(c.engine_bonus).unwrap_or(0.0),
            engine_daily_prod: known(c.engine_daily_prod).unwrap_or(0.0),
            switch: c.switch.as_ref().map(|origin| SwitchOrigin {
                from: id(&origin.from),
                from_type: id(&origin.from_type),
            }),
        };
        let r = retool(
            &base,
            intern(&self.product),
            known(self.margin),
            self.item_type.as_deref().map(intern),
            known(self.regional),
            known(self.change_item_cost),
            known(self.concrete_price),
        );
        RetoolOut {
            r#type: string(r.item_type),
            margin: r.margin,
            engine_bonus: r.engine_bonus,
            switch: SwitchOut {
                from: string(r.from),
                from_type: string(r.from_type),
                to: self.product,
                cost: r.cost,
                concrete: r.concrete,
                tool_type_changes: r.tool_type_changes,
                engine_daily: r.engine_daily,
            },
        }
    }
}

/// The switch options as the facade hands them over (`switchContext`):
/// `{ live, game, types, concretePrice, changeItemCost, regional }`, the two
/// price sets and the item types as `{ code: value }` objects (a margin that
/// isn't a finite number, or a type that is null, left out), concrete's
/// unit price and a switch's concrete (unknown: none and `CHANGE_ITEM_COST`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchInput {
    live: OrderedMap<Option<f64>>,
    game: OrderedMap<Option<f64>>,
    types: OrderedMap<Option<String>>,
    concrete_price: Option<f64>,
    change_item_cost: Option<f64>,
    regional: Vec<RegionalBonus>,
}

/// A company's regional bonus on a good, where the page has one: `{
/// company, product, bonus }`, the bonus's total / 100.
#[derive(Deserialize)]
struct RegionalBonus {
    company: String,
    product: String,
    bonus: f64,
}

/// `switchContext`: the price sets, goods a company can be re-tooled onto
/// (best at the worse price first) and how to re-tool it.
#[derive(Clone)]
pub struct SwitchContext {
    pub price_sets: PriceSets,
    /// `market.types`: each good's item type.
    item_types: HashMap<u32, u32>,
    pub codes: Vec<u32>,
    concrete_price: Option<f64>,
    change_item_cost: Option<f64>,
    regional: HashMap<(u32, u32), f64>,
}

impl SwitchContext {
    pub fn new(input: SwitchInput) -> SwitchContext {
        let price_sets =
            PriceSets::new(&known_margins(input.live), &known_margins(input.game), SPIKE_RATIO);
        let item_types: HashMap<u32, u32> = input
            .types
            .0
            .iter()
            .filter_map(|(k, v)| Some((intern(k), intern(v.as_deref()?))))
            .collect();
        let mut codes: Vec<u32> = price_sets
            .live_entries
            .iter()
            .map(|x| x.code)
            .filter(|c| item_types.get(c).is_some_and(|t| *t > 1) && tool_type_id(*c) != 0)
            .collect();
        // Ties stay in the market's order.
        sort_list(&mut codes, &|&a, &b| {
            let worse = |code| price_sets.worse(code).unwrap_or(0.0);
            worse(b).total_cmp(&worse(a))
        });
        let regional = input
            .regional
            .iter()
            .map(|r| ((intern(&r.company), intern(&r.product)), r.bonus))
            .collect();
        SwitchContext {
            price_sets,
            item_types,
            codes,
            concrete_price: known(input.concrete_price),
            change_item_cost: known(input.change_item_cost),
            regional,
        }
    }
    /// The game's margin for a company's good, or its own (live) when the game has none.
    pub fn game_margin(&self, c: &PlanCompany) -> f64 {
        self.price_sets.game(c.record.product).unwrap_or(c.record.margin)
    }
    /// Every other good: no shortlist.
    pub fn products(&self, product: u32) -> Vec<u32> {
        self.codes.iter().copied().filter(|&c| c != product).collect()
    }
    pub fn spike(&self, code: u32) -> bool {
        self.price_sets.spike(code)
    }
    pub fn ratio(&self, code: u32) -> Option<f64> {
        self.price_sets.ratio(code)
    }

    /// The company at its place re-tooled onto `product`, from its record;
    /// None onto a good without a known margin, which can't be planned.
    pub fn retool(&self, c: &PlanCompany, product: u32) -> Option<PlanCompany> {
        let base = CompanyBase {
            product: c.record.product,
            item_type: c.item_type,
            margin: Some(c.record.margin).filter(|m| m.is_finite()),
            engine_bonus: c.record.engine_bonus,
            engine_daily_prod: c.record.engine_daily_prod,
            switch: c
                .record
                .switched
                .then_some(SwitchOrigin { from: c.from, from_type: c.from_type }),
        };
        let r = retool(
            &base,
            product,
            self.price_sets.live(product),
            self.item_types.get(&product).copied(),
            self.regional.get(&(c.record.id, product)).copied(),
            self.change_item_cost,
            self.concrete_price,
        );
        let margin = r.margin?;
        let mut retooled = c.clone();
        retooled.record.product = product;
        retooled.record.product_text = string(product);
        retooled.record.item_type_text = string(r.item_type);
        retooled.item_type = r.item_type;
        retooled.record.tool_type = tool_type_id(product);
        retooled.record.margin = margin;
        retooled.record.engine_bonus = r.engine_bonus;
        retooled.record.switched = true;
        retooled.record.switch_cost = r.cost.unwrap_or(0.0);
        retooled.from = r.from;
        retooled.from_type = r.from_type;
        retooled.cost = r.cost;
        retooled.concrete = r.concrete;
        Some(retooled)
    }
}

// --- A company re-tooled where it stands ---

/// A company re-tooled where it stands, as Top Products tries each good:
/// the re-tooled record takes the company's place, its members read their
/// saved days on the new good (capped), and held tools that don't fit the
/// good come off as spares.
pub struct InPlace {
    /// The re-tooled record's index in `plan.companies`.
    at: usize,
    tool_type: u32,
    /// Each employee's tool once the ones that don't fit are off.
    equipped: Vec<Option<usize>>,
    /// The tools taken off.
    spares: Vec<usize>,
    /// `validate` on the re-tooled snapshot: only the company's record
    /// changed, and its margin is known (`retool`).
    valid: bool,
}

impl InPlace {
    /// The company at `slot` re-tooled onto `product` in `env`, `members`
    /// its employees; None onto a good without a known margin. `undo` puts
    /// it back.
    fn apply(
        env: &mut Env,
        switches: &SwitchContext,
        slot: usize,
        members: &[usize],
        product: u32,
    ) -> Option<InPlace> {
        let company = switches.retool(&env.plan.companies[slot], product)?;
        let tool_type = tool_type_id(product);
        let overrides = members
            .iter()
            .map(|&e| SavedDaysOverride {
                employee: e,
                product,
                days: saved_specialization(env.saved_days(e, product)),
            })
            .collect();
        let mut equipped = env.plan.equipped.clone();
        let mut spares = Vec::new();
        for &e in members {
            if let Some(t) = equipped[e]
                && !fits(&env.plan, tool_type, t)
            {
                spares.push(t);
                equipped[e] = None;
            }
        }
        let valid =
            matches!(company.record.item_type_text.as_deref(), Some("raw" | "product" | "weapon"))
                && company.record.bonus.is_finite()
                && company.record.tax.is_finite()
                && company.capacity.fract() == 0.0
                && company.capacity >= 1.0;
        env.plan.companies.push(company);
        let at = env.plan.companies.len() - 1;
        env.company_at[slot] = at;
        env.set_saved_days_overrides(overrides);
        Some(InPlace { at, tool_type, equipped, spares, valid })
    }

    /// The company at `slot` back as it was.
    fn undo(env: &mut Env, slot: usize) {
        env.company_at[slot] = slot;
        env.set_saved_days_overrides(Vec::new());
        env.plan.companies.pop();
    }

    /// Whether tool `t` fits the new good.
    fn fits(&self, plan: &Plan, t: usize) -> bool {
        fits(plan, self.tool_type, t)
    }
}

/// Whether tool `t` takes `tool_type` (0: a good no tool fits).
fn fits(plan: &Plan, tool_type: u32, t: usize) -> bool {
    tool_type != 0 && plan.tools[t].tool_type == tool_type
}

/// `evaluateRetooled`'s input: `{ company, product, switches, arrangement }`,
/// the company's place in the snapshot, the good, the switch context's
/// input (`SwitchInput`) and an arrangement (unset: as it stands, with the
/// tools that no longer fit taken off).
#[derive(Deserialize)]
pub struct RetooledInput {
    pub company: usize,
    pub product: String,
    pub switches: SwitchInput,
    pub arrangement: Option<Vec<Assignment>>,
}

/// `evaluateRetooled`'s result: the totals with rows and the ids of the
/// tools taken off; or why the company can't be projected on the good,
/// `problem`: `unknownCompany`, `noMargin` (the good has no known margin)
/// or `notPlannable` (the re-tooled company fails `validate`).
#[derive(Serialize)]
pub struct RetooledTotals {
    totals: Option<Totals>,
    spares: Vec<Rc<str>>,
    problem: Option<&'static str>,
}

impl RetooledTotals {
    fn problem(kind: &'static str) -> RetooledTotals {
        RetooledTotals { totals: None, spares: Vec::new(), problem: Some(kind) }
    }
}

/// The company at place `slot` re-tooled where it stands onto `product`,
/// as Top Products tries it, and projected over `arrangement` (None: as it
/// stands, with the tools that don't fit taken off).
pub fn evaluate_retooled(
    mut env: Env,
    switches: &SwitchContext,
    slot: usize,
    product: &str,
    arrangement: Option<Vec<Placement>>,
) -> RetooledTotals {
    if slot >= env.plan.company_count {
        return RetooledTotals::problem("unknownCompany");
    }
    let id = env.plan.companies[slot].id.clone();
    let members: Vec<usize> = (0..env.plan.people.len())
        .filter(|&e| env.plan.company_of[e].is_some_and(|x| env.plan.companies[x].id == id))
        .collect();
    let Some(retooled) = InPlace::apply(&mut env, switches, slot, &members, intern(product)) else {
        return RetooledTotals::problem("noMargin");
    };
    if !retooled.valid {
        return RetooledTotals::problem("notPlannable");
    }
    let placements = arrangement.unwrap_or_else(|| {
        (0..env.plan.people.len())
            .map(|e| Placement { company: env.plan.company_of[e], tool: retooled.equipped[e] })
            .collect()
    });
    let totals = env.totals(&placements, /* rows */ true);
    let spares = retooled.spares.iter().map(|&t| env.plan.tools[t].id.clone()).collect();
    RetooledTotals { totals: Some(totals), spares, problem: None }
}

// --- Top Products: each company's best switch on its own ---

/// A company's switch to a good, with free tools or without.
#[derive(Clone)]
pub struct SwitchCandidate {
    to: u32,
    tools: f64,
    tool_ids: Vec<usize>,
    live: f64,
    game: f64,
    worse: f64,
    need: f64,
    cost: Option<f64>,
    concrete: f64,
    spike: bool,
    ratio: Option<f64>,
    payback: f64,
}
/// A company's verdict, the candidate picked and every candidate.
pub struct Row {
    slot: usize,
    verdict: &'static str,
    pick: Option<usize>,
    candidates: Vec<SwitchCandidate>,
}
/// `singleSwitches`' result.
pub struct SingleSwitches {
    days: f64,
    floor: f64,
    rows: Vec<Row>,
    env: Env,
}

const EPS: f64 = 1e-9;
fn pays(x: &SwitchCandidate) -> bool {
    x.worse > x.need + EPS
}

/// `singleSwitches` on a snapshot already through `withExclusions` and
/// valid as it is (the facade checks).
pub fn single_switches(mut env: Env, switches: &SwitchContext) -> SingleSwitches {
    let initial = env.initial();
    let base = env.totals(&initial, /* rows */ false);
    let days = env.plan.hours.unwrap_or(env.plan.days * 24.0) / 24.0;
    let floor = (churn::FLOOR_SHARE * base.value).max(churn::FLOOR_MIN);
    // Value at the game's margins: each company's PP repriced.
    let game_value = |env: &Env, t: &Totals| {
        t.by_company.iter().fold(0.0, |sum, x| {
            let c = env.company_by_id(&x.id);
            sum + x.value + (switches.game_margin(c) - c.record.margin) * x.production_points
        })
    };
    let base_game = game_value(&env, &base);
    let company_count = env.plan.company_count;
    let employee_count = env.plan.people.len();
    let mut rows = Vec::with_capacity(company_count);
    for slot in 0..company_count {
        let mut row = Row { slot, verdict: "stay", pick: None, candidates: Vec::new() };
        let c = env.plan.companies[slot].clone();
        if c.excluded {
            row.verdict = "off";
            rows.push(row);
            continue;
        }
        if c.record.disabled {
            rows.push(row);
            continue;
        }
        let need =
            floor * if c.switched_age < churn::RECENT_HOURS { churn::RECENT_FACTOR } else { 1.0 };
        let members: Vec<usize> = (0..employee_count)
            .filter(|&e| env.plan.company_of[e].is_some_and(|x| env.plan.companies[x].id == c.id))
            .collect();
        for product in switches.products(c.record.product) {
            let Some(retooled) = InPlace::apply(&mut env, switches, slot, &members, product) else {
                continue;
            };
            let fits = |t: usize| retooled.fits(&env.plan, t);
            let holder = |t: usize| {
                if retooled.spares.contains(&t) { Holder::Free } else { env.plan.tools[t].holder }
            };
            let as_is: Vec<Placement> = (0..employee_count)
                .map(|e| Placement { company: env.plan.company_of[e], tool: retooled.equipped[e] })
                .collect();
            let plan = &env.plan;
            let mut free: Vec<usize> = (0..plan.tool_count)
                .filter(|&t| plan.tools[t].hours > 0.0 && holder(t) == Holder::Free && fits(t))
                .collect();
            sort_places(&mut free, &|a, b| {
                let (x, y) = (&plan.tools[a], &plan.tools[b]);
                y.bonus.total_cmp(&x.bonus).then(y.hours.total_cmp(&x.hours)).then(a.cmp(&b))
            });
            let mut bare: Vec<usize> =
                members.iter().copied().filter(|&e| retooled.equipped[e].is_none()).collect();
            sort_places(&mut bare, &|a, b| {
                (plan.people[b].production).total_cmp(&plan.people[a].production).then(a.cmp(&b))
            });
            bare.truncate(free.len());
            // The arrangement as it is, and (if anyone is bare) with free tools.
            let mut variants = vec![(as_is.clone(), false)];
            if !bare.is_empty() {
                let mut with_tools = as_is.clone();
                for (i, &e) in bare.iter().enumerate() {
                    with_tools[e].tool = Some(free[i]);
                }
                variants.push((with_tools, true));
            }
            for (arrangement, tools) in variants {
                if !retooled.valid {
                    continue;
                }
                env.reset_projector();
                let r = env.totals(&arrangement, /* rows */ false);
                let live = r.value - base.value;
                let game = game_value(&env, &r) - base_game;
                let worse = live.min(game);
                let cost = env.plan.companies[retooled.at].cost;
                let gross = (worse + cost.unwrap_or(0.0)) / days;
                let n = if tools { bare.len() } else { 0 };
                row.candidates.push(SwitchCandidate {
                    to: product,
                    tools: n as f64,
                    tool_ids: free[..n].to_vec(),
                    live,
                    game,
                    worse,
                    need,
                    cost,
                    concrete: env.plan.companies[retooled.at].concrete,
                    spike: switches.spike(product),
                    ratio: switches.ratio(product),
                    payback: payback(cost, gross),
                });
            }
            InPlace::undo(&mut env, slot);
        }
        // Ties stay in the order the goods were tried.
        sort_list(&mut row.candidates, &|a, b| {
            b.worse.total_cmp(&a.worse).then(a.tools.total_cmp(&b.tools))
        });
        rows.push(row);
    }
    // A company's best switch among those whose tools are still free, else
    // its best hold (by today's gain).
    let pick = |row: &Row, free: &[bool]| -> Option<usize> {
        let open: Vec<usize> = (0..row.candidates.len())
            .filter(|&i| row.candidates[i].tool_ids.iter().all(|&t| free[t]))
            .collect();
        if let Some(&i) = open.iter().find(|&&i| pays(&row.candidates[i])) {
            return Some(i);
        }
        let mut holds: Vec<usize> = open
            .into_iter()
            .filter(|&i| {
                let x = &row.candidates[i];
                x.live > x.need + EPS
            })
            .collect();
        sort_places(&mut holds, &|a, b| {
            let (x, y) = (&row.candidates[a], &row.candidates[b]);
            y.live.total_cmp(&x.live).then(x.tools.total_cmp(&y.tools)).then(a.cmp(&b))
        });
        holds.first().copied()
    };
    let mut free: Vec<bool> =
        (0..env.plan.tool_count).map(|t| env.plan.tools[t].holder == Holder::Free).collect();
    let mut picked: Vec<Option<usize>> = vec![None; company_count];
    loop {
        // The best switch that takes free tools goes first; ties by place.
        // Each is (company place, candidate).
        let mut next: Vec<(usize, usize)> = rows
            .iter()
            .filter(|r| picked[r.slot].is_none() && r.verdict == "stay")
            .filter_map(|r| pick(r, &free).map(|x| (r.slot, x)))
            .filter(|&(s, x)| {
                let c = &rows[s].candidates[x];
                pays(c) && c.tools != 0.0
            })
            .collect();
        sort_list(&mut next, &|&(slot_a, a), &(slot_b, b)| {
            (rows[slot_b].candidates[b].worse)
                .total_cmp(&rows[slot_a].candidates[a].worse)
                .then(slot_a.cmp(&slot_b))
        });
        let Some(&(s, x)) = next.first() else { break };
        picked[s] = Some(x);
        for &t in &rows[s].candidates[x].tool_ids {
            free[t] = false;
        }
    }
    for row in rows.iter_mut() {
        if row.verdict != "stay" {
            continue;
        }
        let Some(x) = picked[row.slot].or_else(|| pick(row, &free)) else {
            continue;
        };
        let c = &row.candidates[x];
        row.verdict = if pays(c) {
            "switch"
        } else if c.spike {
            "spike"
        } else {
            "hold"
        };
        row.pick = Some(x);
    }
    SingleSwitches { days, floor, rows, env }
}

impl Serialize for SingleSwitches {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // Tools by their ids.
        struct ToolIds<'a> {
            env: &'a Env,
            tools: &'a [usize],
        }
        impl Serialize for ToolIds<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                self.tools
                    .iter()
                    .map(|&t| &*self.env.plan.tools[t].id)
                    .collect::<Vec<_>>()
                    .serialize(s)
            }
        }
        struct CandidateOut<'a> {
            env: &'a Env,
            candidate: &'a SwitchCandidate,
        }
        impl Serialize for CandidateOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let x = self.candidate;
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("to", &*string(x.to).unwrap_or_default())?;
                m.serialize_entry("tools", &x.tools)?;
                m.serialize_entry("toolIds", &ToolIds { env: self.env, tools: &x.tool_ids })?;
                for (k, v) in
                    [("live", x.live), ("game", x.game), ("worse", x.worse), ("need", x.need)]
                {
                    m.serialize_entry(k, &v)?;
                }
                m.serialize_entry("cost", &x.cost)?;
                m.serialize_entry("concrete", &x.concrete)?;
                m.serialize_entry("spike", &x.spike)?;
                m.serialize_entry("ratio", &x.ratio)?;
                m.serialize_entry("payback", &x.payback)?;
                m.end()
            }
        }
        struct RowOut<'a> {
            result: &'a SingleSwitches,
            row: &'a Row,
        }
        impl Serialize for RowOut<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let (env, r, days) = (&self.result.env, self.row, self.result.days);
                let c = &env.plan.companies[r.slot];
                let x = r.pick.map(|i| &r.candidates[i]);
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("id", &*c.id)?;
                if let Some(p) = &c.record.product_text {
                    m.serialize_entry("product", &**p)?;
                }
                m.serialize_entry("verdict", r.verdict)?;
                m.serialize_entry("to", &x.map(|x| string(x.to).unwrap_or_default()).as_deref())?;
                m.serialize_entry("tools", &x.map_or(0.0, |x| x.tools))?;
                m.serialize_entry(
                    "toolIds",
                    &ToolIds { env, tools: x.map_or(&[][..], |x| &x.tool_ids) },
                )?;
                m.serialize_entry(
                    "gain",
                    &x.map(|x| LiveAndGame { live: x.live / days, game: x.game / days }),
                )?;
                m.serialize_entry("spike", &x.is_some_and(|x| x.spike))?;
                m.serialize_entry("ratio", &x.and_then(|x| x.ratio))?;
                m.serialize_entry("cost", &x.and_then(|x| x.cost))?;
                m.serialize_entry("concrete", &x.map_or(0.0, |x| x.concrete))?;
                m.serialize_entry("payback", &x.map(|x| x.payback))?;
                m.serialize_entry(
                    "candidates",
                    &r.candidates
                        .iter()
                        .map(|candidate| CandidateOut { env, candidate })
                        .collect::<Vec<_>>(),
                )?;
                m.end()
            }
        }
        let mut m = s.serialize_map(Some(3))?;
        m.serialize_entry("days", &self.days)?;
        m.serialize_entry("floor", &self.floor)?;
        m.serialize_entry(
            "rows",
            &self.rows.iter().map(|row| RowOut { result: self, row }).collect::<Vec<_>>(),
        )?;
        m.end()
    }
}
