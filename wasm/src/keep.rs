//! The keep step and recruiting over a snapshot (`KeepSession`).
//!
//! The keep step ("Working out who is worth keeping") prices each employee
//! against a fresh hire in their slot: what keeping them earns (retention,
//! pricing.rs), the trainings their potential holds, and a fresh set of
//! candidates in their company without them. Recruiting reads the same
//! rosters: the fresh sets of the feed's hire rows and the Hire tab, a typed
//! candidate in a company, and what a newcomer does to the coworkers' traits
//! (which the page turns into hiring preferences).
//!
//! Everything comes from the snapshot (`snapshotOf`, with the PP's value):
//! - an employee's model and context in a roster (`Data::context`); in
//!   their company as it is, with each coworker as a model in their own
//!   context, they are the Training page's too (`Session::model`: the
//!   calculator, card jobs, the feed's training outlooks and the energy
//!   curve);
//! - a company seen by a newcomer who joins it (`Data::join`), for fresh
//!   sets and candidates.
//!
//! A roster is a company's employees, all of them or all but one (the one
//! whose slot is priced). Per roster the session keeps the coworkers' trait
//! values and what each newcomer does to them, and fresh sets by `alt` and
//! slots; the newcomer's own tables are fresh.rs' cache. Every value kept is
//! a pure function of its key, so keeping it never changes a result.

use crate::cache::Recent;
use crate::fresh::{
    self, Candidate, CandidateOptions, CandidateValue, FreshSet, FreshSetOptions, Hire,
    OwnTablesBuilder, Rate, SetGroup, Setting, Summary,
};
use crate::model::{
    Code, Context, Coworker, Energy, Held, Peer, ProductionEvent, RulesEmployee, Situation,
};
use crate::pricing::{Kept, Retention, Roster};
use crate::project::{intern_optional, string, truthy_string};
use crate::rules::{Memo, comparison_production, potential_value, trait_value, working_days};
use crate::snapshot::Snapshot;
use crate::traits::Trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::rc::Rc;

/// A finite number, or `default`: how the rules' decode reads a number the
/// page computed (model.rs).
fn or(value: f64, default: f64) -> f64 {
    if value.is_finite() { value } else { default }
}
/// `Math.round`: the nearest whole number, halves up.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}
/// `Math.max(...list)` of a non-empty list: NaN if any is NaN.
fn js_max(list: &[f64]) -> f64 {
    list.iter()
        .fold(f64::NEG_INFINITY, |a, &v| if a.is_nan() || v.is_nan() { f64::NAN } else { a.max(v) })
}
/// The mean of a non-empty list, summed in order.
fn mean(list: &[f64]) -> f64 {
    list.iter().fold(0.0, |a, v| a + v) / list.len() as f64
}
/// An interned string as the rules read text: None when unset or empty.
fn text_of(id: u32) -> Option<Rc<str>> {
    string(id).filter(|s| !s.is_empty())
}
fn gender(female: bool) -> Rc<str> {
    if female { "female".into() } else { "male".into() }
}

/// Someone in a roster as its contexts read them: an employee of the
/// snapshot, or the newcomer a fresh set or a candidate adds.
struct Person {
    id: Rc<str>,
    nationality: u32,
    female: bool,
    /// Hired plus trained Production (the API's `base`), 0 when unknown.
    production: f64,
    wage: f64,
    /// Whole days in the company (since the last move, else the hire) and
    /// since hired.
    tenure_days: f64,
    employed_days: f64,
    /// Today's happiness and output (the game's estimate), when known.
    happiness: Option<f64>,
    output: Option<f64>,
    /// As Rival and Mentor compare them: age, days to retirement,
    /// nationality, Production and every trait.
    compared: Rc<RulesEmployee>,
    /// As a coworker's peers list them: age, days to retirement and
    /// nationality.
    listed: Rc<RulesEmployee>,
}

/// An employee of the snapshot as the keep step reads them.
struct Member {
    person: Person,
    /// Their company, by place.
    company: Option<usize>,
    /// Their model, the same in every roster.
    employee: RulesEmployee,
    potential_max: Option<f64>,
    /// Potential left before a waiting hand is drawn.
    potential_left: f64,
    /// The lasting happiness losses a newcomer would share, and the income
    /// tax's.
    shared_loss: f64,
    tax_loss: f64,
    has_tool: bool,
    /// Holds Recruiter (a hidden one too): a candidate slot more.
    recruiter: bool,
}

impl Member {
    /// The traits they show, as their model holds them.
    fn traits(&self) -> &[Held] {
        self.employee.traits()
    }
}

/// A company as the roster contexts read it.
struct Place {
    /// Its employees, by place, in snapshot order.
    members: Vec<usize>,
    sell_ratio: f64,
    engine_daily_prod: f64,
    engine_bonus: f64,
    country: u32,
    core_country: u32,
    /// The product's type, 'product' when unknown.
    item_type: Option<Rc<str>>,
    product: Option<Rc<str>>,
    small_storage: bool,
    full: bool,
    /// The region's income tax (NaN when unknown).
    tax: f64,
    /// Management, manager and core-region bonus, %, as an employee gets it.
    bonus: f64,
    manager_pct: f64,
}

/// Where someone works, seen from their nationality: `{ place, homeCore }`
/// (`locationFor`); at home, outside the core, when the region or the
/// nationality is unknown.
fn location(c: &Place, nationality: u32) -> (Rc<str>, bool) {
    if !(truthy_string(c.country) && truthy_string(c.core_country) && truthy_string(nationality)) {
        return ("home".into(), false);
    }
    let home_core = c.core_country == nationality;
    let place = if c.country != nationality {
        "abroad"
    } else if home_core {
        "homeCore"
    } else {
        "home"
    };
    (place.into(), home_core)
}

/// How many nationalities other than `own` the coworkers hold.
fn other_nationalities<'a>(own: u32, coworkers: impl Iterator<Item = &'a Person>) -> f64 {
    let mut seen: Vec<u32> = Vec::new();
    for x in coworkers {
        if truthy_string(x.nationality) && x.nationality != own && !seen.contains(&x.nationality) {
            seen.push(x.nationality);
        }
    }
    seen.len() as f64
}

/// Who joins a company: a fresh set's candidate or a typed one. A fresh
/// set's newcomer has no wage: who is better paid is read on Production.
#[derive(Clone, Copy)]
struct Newcomer {
    nationality: u32,
    female: bool,
    production: f64,
    wage: Option<f64>,
}

/// A company seen by a newcomer who joins it (`joinSetup`): their context,
/// the company's bonus and the happiness they would lose, if known.
struct Join {
    context: Context,
    bonus: f64,
    happiness_loss: Option<f64>,
}

/// A fresh set's group: candidates of one nationality.
struct Group {
    nationality: u32,
    weight: f64,
    setting: Setting,
}

/// What the session reads from the snapshot.
struct Data {
    pp: f64,
    management: f64,
    management_pct: f64,
    members: Vec<Member>,
    places: Vec<Place>,
    /// Candidates' nationalities: those hired so far, by how many hold
    /// them, the first seen first.
    mix: Vec<(u32, f64)>,
}

/// A roster: a company, and the employee left out (by place), if any.
type RosterKey = (usize, Option<usize>);

impl Data {
    fn new(s: &Snapshot) -> Option<Data> {
        let pp = s.pp_value?;
        let mut places: Vec<Place> = s
            .companies
            .iter()
            .map(|c| {
                let r = &c.record;
                Place {
                    members: Vec::new(),
                    sell_ratio: if r.margin.is_finite() { r.margin / pp } else { 1.0 },
                    engine_daily_prod: r.engine_daily_prod,
                    engine_bonus: r.engine_bonus,
                    country: r.country,
                    core_country: r.core_country,
                    item_type: Some(
                        r.item_type_text
                            .clone()
                            .filter(|t| !t.is_empty())
                            .unwrap_or("product".into()),
                    ),
                    product: r.product_text.clone().filter(|t| !t.is_empty()),
                    small_storage: r.storage.unwrap_or(0.0) <= 2.0,
                    full: r.full,
                    tax: r.tax,
                    bonus: r.bonus,
                    manager_pct: c.manager_pct,
                }
            })
            .collect();
        let d = RulesEmployee::default();
        let members = s
            .employees
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let r = &e.record;
                let company = s.first_company(r.company);
                if let Some(c) = company {
                    places[c].members.push(i);
                }
                let observed = e.observed;
                let production = if r.production.is_finite() { r.production } else { 0.0 };
                let nationality = text_of(r.nationality);
                let listed = RulesEmployee {
                    age: or(r.age, d.age),
                    retire_in_days: r.retire_in_days,
                    nationality: nationality.clone(),
                    ..RulesEmployee::default()
                };
                let compared =
                    RulesEmployee { production, traits: Some(e.held.clone()), ..listed.clone() };
                // The model. The API's `base` includes trained points; the
                // wage is paid on it (plus the own traits' flat Production
                // with `traitProductionPaid`), the rest (Rival, Mentor,
                // coworkers) is unpaid. The wage expectation is read off the
                // wage itself, so Greedy, Modest and Climber are in it.
                let total = observed.and_then(|o| o.production).unwrap_or(production);
                let responsibility = observed
                    .and_then(|o| o.responsibility)
                    .or(Some(r.responsibility).filter(|v| v.is_finite()))
                    .unwrap_or(0.0);
                let bonus_pct =
                    js_round(observed.and_then(|o| o.bonus).unwrap_or(0.0) * 10.0) / 10.0;
                let product = company.map_or(0, |c| s.companies[c].record.product);
                let spec_pct = f64::min(20.0, e.saved_days(product).unwrap_or(0.0));
                let paid_per_hour =
                    crate::project::paid_production(production, r.trait_production) / 4.0 * pp;
                let expectation = if paid_per_hour > 0.0 {
                    r.wage / paid_per_hour
                } else {
                    e.negotiation_expectation.unwrap_or(f64::NAN)
                };
                let wage_pct = (expectation - 1.0) * 100.0;
                let potential_left = r.potential_left.unwrap_or(0.0);
                // The draw spends the potential, so a hand waiting has already used its own.
                let left = (potential_left - if e.pending_training { 0.0 } else { 1.0 }).max(0.0);
                // Timed events only, in whole hours.
                let events: Rc<[ProductionEvent]> = r
                    .production_events
                    .iter()
                    .filter(|x| x.hours_left.is_finite())
                    .map(|x| ProductionEvent { delta: x.delta, hours_left: js_round(x.hours_left) })
                    .collect();
                let employee = RulesEmployee {
                    age: or(r.age, d.age),
                    retire_in_days: r.retire_in_days,
                    production,
                    trait_production: r.trait_production,
                    extra_production: or(
                        total - production - r.trait_production,
                        d.extra_production,
                    ),
                    responsibility: or(responsibility, d.responsibility),
                    luck: or(r.observed_luck.unwrap_or(r.luck), d.luck),
                    bonus: or(bonus_pct / 100.0, d.bonus),
                    specialization: or(spec_pct, d.specialization),
                    wage_expectation: or(1.0 + wage_pct / 100.0, d.wage_expectation),
                    happiness_loss: e.life_loss.unwrap_or(d.happiness_loss),
                    happiness: observed.and_then(|o| o.happiness),
                    potential_left: or(left, d.potential_left),
                    potential_max: None,
                    trainings_per_day: r
                        .observed_trainings_per_day
                        .filter(|&n| n > 0.0)
                        .unwrap_or(d.trainings_per_day),
                    wage: None,
                    negotiation_expectation: e.negotiation_expectation,
                    climber_raise: None,
                    events,
                    traits: Some(e.shown.clone()),
                    nationality,
                };
                let whole = |days: f64| if days.is_finite() { days.max(0.0).floor() } else { 0.0 };
                Member {
                    person: Person {
                        id: string(r.id).unwrap_or_else(|| "".into()),
                        nationality: r.nationality,
                        female: r.female,
                        production,
                        wage: r.wage,
                        tenure_days: whole(r.tenure),
                        employed_days: whole(r.employed_days),
                        happiness: observed.and_then(|o| o.happiness),
                        output: observed.and_then(|o| o.output),
                        compared: Rc::new(compared),
                        listed: Rc::new(listed),
                    },
                    company,
                    employee,
                    potential_max: e.potential_max,
                    potential_left,
                    shared_loss: e.shared_loss,
                    tax_loss: e.tax_loss,
                    has_tool: e.has_tool,
                    recruiter: e.held.iter().any(|h| h.code.is(Trait::Recruiter)),
                }
            })
            .collect::<Vec<Member>>();
        let mut mix: Vec<(u32, f64)> = Vec::new();
        for m in &members {
            let n = m.person.nationality;
            if !truthy_string(n) {
                continue;
            }
            match mix.iter_mut().find(|(x, _)| *x == n) {
                Some((_, count)) => *count += 1.0,
                None => mix.push((n, 1.0)),
            }
        }
        Some(Data {
            pp,
            management: s.management,
            management_pct: s.management_pct,
            members,
            places,
            mix,
        })
    }

    /// The traits of `company`'s coworkers that `employee` holds back on
    /// `day` (from now): each coworker still working that day, valued with
    /// them and without them, by trait, where they cost half a PP or more.
    fn held_back(&self, company: usize, employee: usize, day: f64) -> Vec<Note> {
        let c = &self.places[company];
        let rest: Vec<usize> = c
            .members
            .iter()
            .copied()
            .filter(|&i| i != employee && working_days(&self.members[i].employee) > day + 0.5)
            .collect();
        let without = self.persons(&rest);
        let mut with = without.clone();
        with.push(&self.members[employee].person);
        let mut notes = Vec::new();
        for (at, &i) in rest.iter().enumerate() {
            let m = &self.members[i];
            let alone = self.context(c, m, &without, at, None, Energy::Number(0.0));
            let among = self.context(c, m, &with, at, None, Energy::Number(0.0));
            for t in m.traits() {
                let value = |context: &Context| {
                    trait_value(&t.code, &m.employee, context, t.arg.clone(), true).value
                };
                if let (Some(a), Some(b)) = (value(&among), value(&alone))
                    && a - b <= -0.5
                {
                    notes.push(Note { employee: i, code: t.code.clone() });
                }
            }
        }
        notes
    }

    /// The roster's employees, by place.
    fn roster(&self, (company, without): RosterKey) -> Vec<usize> {
        self.places[company].members.iter().copied().filter(|&i| Some(i) != without).collect()
    }
    fn persons(&self, employees: &[usize]) -> Vec<&Person> {
        employees.iter().map(|&i| &self.members[i].person).collect()
    }

    /// `productionPeer`: `roster[at]` as Rival and Mentor compare them among
    /// the rest, with their wage.
    fn peer(&self, c: &Place, roster: &[&Person], at: usize) -> Peer {
        let x = roster[at];
        let others = || roster.iter().enumerate().filter(move |&(j, _)| j != at).map(|(_, &p)| p);
        let (place, home_core) = location(c, x.nationality);
        let situation = Situation {
            coworkers: (roster.len() - 1) as f64,
            same_nationality_coworkers: Some(others().any(|o| o.nationality == x.nationality)),
            other_nationalities: other_nationalities(x.nationality, others()),
            home_core: Some(home_core),
            place: Some(place),
            item_type: c.item_type.clone(),
            product: c.product.clone(),
            tenure_days: x.tenure_days,
            peers: Some(
                others()
                    .map(|o| Peer {
                        production: 0.0,
                        wage_pp: None,
                        model: Some(o.listed.clone()),
                        situation: None,
                        is_self: false,
                    })
                    .collect(),
            ),
            ..Situation::default()
        };
        Peer {
            production: comparison_production(&x.compared, &situation, 0.0),
            wage_pp: Some(x.wage / self.pp).filter(|w| w.is_finite()),
            model: Some(x.compared.clone()),
            situation: Some(Rc::new(situation)),
            is_self: false,
        }
    }

    /// `m`'s context without coworker models: `m` is `roster[at]`, in
    /// company `c`, and `roster[priced]`, if given, is the employee priced
    /// among their peers (`m` is then a coworker model of theirs).
    fn context(
        &self,
        c: &Place,
        m: &Member,
        roster: &[&Person],
        at: usize,
        priced: Option<usize>,
        energy: Energy,
    ) -> Context {
        let x = roster[at];
        let own = self.peer(c, roster, at).production;
        let others: Vec<&Person> =
            roster.iter().enumerate().filter(|&(j, _)| j != at).map(|(_, &p)| p).collect();
        let peers: Vec<Peer> = (0..roster.len())
            .filter(|&j| j != at)
            .map(|j| Peer { is_self: Some(j) == priced, ..self.peer(c, roster, j) })
            .collect();
        let outputs: Vec<f64> = others.iter().filter_map(|o| o.output).collect();
        let happiness: Option<Vec<f64>> = others.iter().map(|o| o.happiness).collect();
        let (place, home_core) = location(c, x.nationality);
        let situation = Situation {
            gender: Some(gender(x.female)),
            engine_daily_prod: c.engine_daily_prod,
            engine_bonus: c.engine_bonus,
            coworkers: others.len() as f64,
            female_coworkers: others.iter().filter(|o| o.female).count() as f64,
            same_nationality_coworkers: Some(others.iter().any(|o| o.nationality == x.nationality)),
            home_core: Some(home_core),
            other_nationalities: other_nationalities(x.nationality, others.iter().copied()),
            stronger_coworker: peers.iter().any(|p| p.production > own),
            weaker_coworker: peers.iter().any(|p| p.production < own),
            weaker_count: 0.0,
            peers: Some(peers.into()),
            coworker_models: None,
            coworker_ids: others.iter().map(|o| o.id.clone()).collect(),
            better_paid: others.iter().filter(|o| o.wage > x.wage).count() as f64,
            coworker_happiness: happiness.filter(|h| !h.is_empty()).map(|h| mean(&h)),
            place: Some(place),
            item_type: c.item_type.clone(),
            product: c.product.clone(),
            income_tax: m.tax_loss,
            tenure_days: x.tenure_days,
            employed_days: x.employed_days,
            has_tool: m.has_tool,
            small_storage: c.small_storage,
            storage_full: c.full,
            nationality: text_of(x.nationality),
        };
        Context {
            sell_ratio: c.sell_ratio,
            toolbox_value: 0.0,
            management: self.management,
            coworker_output: (!outputs.is_empty())
                .then(|| mean(&outputs) * c.sell_ratio)
                .filter(|v| v.is_finite()),
            pp_value: None,
            energy,
            future_training: true,
            situation: Rc::new(situation),
        }
    }

    /// The newcomer as a member of the roster they join: 20 years old, no
    /// traits, no history.
    fn newcomer(&self, n: &Newcomer) -> Person {
        let listed = RulesEmployee {
            age: 20.0,
            retire_in_days: None,
            nationality: text_of(n.nationality),
            ..RulesEmployee::default()
        };
        Person {
            id: "newcomer".into(),
            nationality: n.nationality,
            female: n.female,
            production: n.production,
            wage: n.wage.unwrap_or(n.production / 4.0 * self.pp),
            tenure_days: 0.0,
            employed_days: 0.0,
            happiness: None,
            output: None,
            compared: Rc::new(RulesEmployee {
                production: n.production,
                traits: Some(Rc::from([])),
                ..listed.clone()
            }),
            listed: Rc::new(listed),
        }
    }

    /// `joinSetup`: company `c` with `employees` seen by newcomer `n`. An
    /// empty company gets the region's income tax and full storage's -10,
    /// and its bonus is the owner's management with the manager's and the
    /// core region's.
    fn join(&self, c: &Place, employees: &[usize], n: &Newcomer) -> Join {
        let newcomer = self.newcomer(n);
        let mut joined = self.persons(employees);
        joined.push(&newcomer);
        let peers: Vec<Peer> = (0..employees.len()).map(|j| self.peer(c, &joined, j)).collect();
        let staff = &joined[..employees.len()];
        let outputs: Vec<f64> = staff.iter().filter_map(|o| o.output).collect();
        // A newcomer shares the company's lasting losses, not a coworker's temporary ones.
        let mut losses: Vec<f64> = employees.iter().map(|&i| self.members[i].shared_loss).collect();
        let mut tax: Vec<f64> = employees.iter().map(|&i| self.members[i].tax_loss).collect();
        if employees.is_empty() && c.tax.is_finite() {
            tax.push(c.tax);
            losses.push(c.tax + if c.full { 10.0 } else { 0.0 });
        }
        let (place, home_core) = location(c, n.nationality);
        let better_paid = match n.wage {
            None => staff.iter().filter(|o| o.production > n.production).count(),
            Some(wage) => staff.iter().filter(|o| o.wage > wage).count(),
        };
        let situation = Situation {
            gender: Some(gender(n.female)),
            engine_daily_prod: c.engine_daily_prod,
            engine_bonus: c.engine_bonus,
            coworkers: staff.len() as f64,
            female_coworkers: staff.iter().filter(|o| o.female).count() as f64,
            same_nationality_coworkers: Some(staff.iter().any(|o| o.nationality == n.nationality)),
            home_core: Some(home_core),
            other_nationalities: other_nationalities(n.nationality, staff.iter().copied()),
            stronger_coworker: peers.iter().any(|p| p.production > n.production),
            weaker_coworker: peers.iter().any(|p| p.production < n.production),
            peers: Some(peers.into()),
            coworker_ids: staff.iter().map(|o| o.id.clone()).collect(),
            better_paid: better_paid as f64,
            place: Some(place),
            item_type: c.item_type.clone(),
            product: c.product.clone(),
            income_tax: if tax.is_empty() { 0.0 } else { or(js_max(&tax), 0.0) },
            small_storage: c.small_storage,
            storage_full: c.full,
            nationality: text_of(n.nationality),
            ..Situation::default()
        };
        let context = Context {
            sell_ratio: c.sell_ratio,
            management: self.management,
            coworker_output: (!outputs.is_empty())
                .then(|| mean(&outputs) * c.sell_ratio)
                .filter(|v| v.is_finite()),
            situation: Rc::new(situation),
            ..Context::default()
        };
        let core = truthy_string(c.country) && c.country == c.core_country;
        let bonus = if employees.is_empty() {
            self.management_pct + c.manager_pct + if core { 5.0 } else { 0.0 }
        } else {
            c.bonus
        };
        Join {
            context,
            bonus: bonus / 100.0,
            happiness_loss: (!losses.is_empty()).then(|| js_round(mean(&losses))),
        }
    }

    /// A fresh set's groups in roster `employees` of `c`: a candidate's
    /// nationality is drawn from those hired so far (a citizen of the
    /// company's country when nobody is hired yet). Rules read it only
    /// against the coworkers' and the region's, so every nationality nobody
    /// here holds, foreign to the region, takes the first of them and
    /// shares its tables and coworker impacts; each keeps its own weight
    /// and place in the draws.
    fn groups(&self, c: &Place, employees: &[usize]) -> Vec<Group> {
        let fallback = [(c.country, 1.0)];
        let mix: &[(u32, f64)] = if self.mix.is_empty() { &fallback } else { &self.mix };
        let own = |n: u32| {
            employees.iter().any(|&i| self.members[i].person.nationality == n)
                || n == c.country
                || n == c.core_country
        };
        let mut other = None;
        mix.iter()
            .map(|&(actual, count)| {
                let nationality = if own(actual) { actual } else { *other.get_or_insert(actual) };
                let newcomer = Newcomer {
                    nationality,
                    female: false,
                    production: Hire::AVERAGE_STAT,
                    wage: None,
                };
                let join = self.join(c, employees, &newcomer);
                Group { nationality, weight: count, setting: setting_of(join) }
            })
            .collect()
    }
}

/// The newcomer's own tables' setting, decoded as a fresh set's group is.
fn setting_of(join: Join) -> Setting {
    Setting {
        context: join.context,
        bonus: or(join.bonus, 0.0),
        happiness_loss: join.happiness_loss.map_or(RulesEmployee::default().happiness_loss, |v| {
            or(v, RulesEmployee::default().happiness_loss)
        }),
    }
}

/// A coworker's traits before a newcomer: their values held now, in the
/// roster as it is.
struct Base {
    employee: usize,
    was: Vec<Option<f64>>,
}
/// A roster's coworkers before a newcomer, and whether any holds a trait
/// that reads the newcomer's wage.
struct Bases {
    coworkers: Vec<Base>,
    by_wage: bool,
}

/// What a newcomer does to the coworkers' traits: `{ value, notes }`, the
/// change and the traits it moves by half a PP or more.
#[derive(Serialize)]
pub struct Impact {
    value: f64,
    notes: Vec<Note>,
}
/// A coworker's trait a newcomer moves: `{ employee, trait }`, the employee
/// by place.
#[derive(Serialize)]
struct Note {
    employee: usize,
    #[serde(rename = "trait")]
    code: Code,
}

/// A trait that reads the newcomer's wage: who is better paid.
fn reads_wage(code: &Code) -> bool {
    code.is(Trait::PrimaDonna) || code.is(Trait::Envious)
}

/// A newcomer as impacts are kept: nationality, gender, Production and
/// wage, by bits.
type NewcomerKey = (u32, bool, u64, Option<u64>);

/// What the session keeps between calls.
struct Stores {
    bases: HashMap<RosterKey, Rc<Bases>>,
    impacts: HashMap<(RosterKey, NewcomerKey), Rc<Impact>>,
    /// A coworker's trait value with a newcomer: by roster, coworker,
    /// trait, and the newcomer, whose wage only the wage traits read.
    after: HashMap<(RosterKey, usize, usize, NewcomerKey), Option<f64>>,
    sets: Recent<(RosterKey, u64, u32), Rc<FreshSet>>,
    /// What `row` reads of each employee's retention.
    retained: HashMap<usize, Retained>,
}

/// An employee's retention as `row` reads it: its value, own part and value
/// by day, in money.
struct Retained {
    value: f64,
    own: f64,
    by_day: Vec<f64>,
}

/// What firing someone later must gain over both firing them now and
/// keeping them to retirement: a twentieth of what keeping them is worth,
/// and at least 1 PP.
fn leave_margin(stay: f64) -> f64 {
    (0.05 * stay.abs()).max(1.0)
}

/// Fresh sets kept: a keep pass prices one per employee, and the page asks
/// again on the next pass (a new `alt` is a new set) and from the Hire tab;
/// each holds its 6,000 ranked draws (96 KB).
const SETS_KEPT: usize = 128;

/// One employee's fresh set being built ahead of their row, a step at a
/// time: each group's own tables, then its coworker grid a Production at a
/// time (`GENDERS` x 1..=4).
struct Warming {
    employee: usize,
    groups: Vec<Group>,
    group: usize,
    builder: Option<OwnTablesBuilder>,
    tables_done: bool,
    row: usize,
}

/// The keep step's feed: `{ alt, trainingValue, energyValue }`, what 10
/// energy earns elsewhere now, the employee's next training's value in the
/// feed (the model's own when unknown) and by day (`energyCurve`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    alt: Option<f64>,
    training_value: Option<f64>,
    energy_value: Option<Energy>,
}

/// A keep row's figures, in PP: what keeping them earns (`own`, retention's
/// own part, and `potential`, their trainings) and what their leaving costs
/// the rest (`leaving`, negative when it costs); `stay` = keep - leaving.
/// The slot earns `fresh.rate` a day anyway, so keeping is charged `held`
/// for their `days`: `surplus`. A candidate must beat `bar` (surplus plus
/// the hire's energy) to replace them: `chance` of a fresh set's pick does,
/// by `gain` on average. `left` is the potential left, `slots` the fresh
/// set's. `leave`: firing them later beats both firing them now and keeping
/// them to retirement, and the bar is then the better of the two keeps.
/// `harm`: the coworkers' traits they hold back on the day they cost the
/// company most, when they cost it something that day.
#[derive(Serialize)]
pub struct Row {
    own: f64,
    potential: f64,
    keep: f64,
    leaving: f64,
    stay: f64,
    days: f64,
    held: f64,
    surplus: f64,
    bar: f64,
    gain: f64,
    chance: f64,
    left: f64,
    slots: u32,
    fresh: Summary,
    leave: Option<Leave>,
    harm: Vec<Note>,
}

/// Firing them after `day` whole days instead of keeping them to
/// retirement: worth `value` (what they add until then, in PP, their
/// trainings left out), `surplus` once the slot's rate is charged for those
/// days. `retires`: the coworker, by place, whose retirement in the day
/// before starts what they cost, if any.
#[derive(Serialize)]
pub struct Leave {
    day: f64,
    value: f64,
    surplus: f64,
    retires: Option<usize>,
}

/// `{ energyValue, coworkers }` of an employee's model: what 10 energy earns
/// elsewhere (0 when unknown), and whether the context lists each coworker
/// as a model (yes when unknown).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptions {
    energy_value: Option<Energy>,
    coworkers: Option<bool>,
}

/// An employee as the rules read them, in their company: `{ employee,
/// context }`.
#[derive(Serialize)]
pub struct Model {
    employee: RulesEmployee,
    context: Context,
}

/// A roster: `{ company, without }`, by place; `without` an employee of the
/// company, or none for all of them.
#[derive(Deserialize)]
pub struct RosterInput {
    company: usize,
    without: Option<usize>,
}

/// `{ alt, slots }`: what 10 energy earns elsewhere (0 when unknown) and
/// the candidates in a set (3 when unknown).
#[derive(Deserialize)]
pub struct SetOptions {
    alt: Option<f64>,
    slots: Option<f64>,
}

/// Who joins: `{ nationality, gender, production, wage }`, the wage per
/// hour in money (Production 2.5 and no wage when unknown).
#[derive(Deserialize)]
pub struct NewcomerInput {
    nationality: Option<String>,
    gender: Option<String>,
    production: Option<f64>,
    wage: Option<f64>,
}

impl From<NewcomerInput> for Newcomer {
    fn from(n: NewcomerInput) -> Newcomer {
        Newcomer {
            nationality: intern_optional(n.nationality.as_deref()),
            female: n.gender.as_deref() == Some("female"),
            production: n.production.filter(|p| p.is_finite()).unwrap_or(Hire::AVERAGE_STAT),
            wage: n.wage.filter(|w| w.is_finite()),
        }
    }
}

/// `{ alt }` of a typed candidate: what a slot-day earns otherwise.
#[derive(Deserialize)]
pub struct CandidateInput {
    alt: Option<f64>,
}

/// A typed candidate in a company: their value (`candidateValue`) and where
/// they would work (`place`).
#[derive(Serialize)]
pub struct Priced {
    value: CandidateValue,
    place: Option<Rc<str>>,
}

/// The session (`KeepSession`).
pub struct Session {
    data: Data,
    retention: Retention,
    kept: Stores,
    warming: Option<Warming>,
}

impl Session {
    /// Over `snapshot` (with its exclusions, which retention reads); None
    /// without the PP's value.
    pub fn new(snapshot: &Snapshot) -> Option<Session> {
        Some(Session {
            data: Data::new(snapshot)?,
            retention: Retention::new(Roster::new(snapshot)),
            kept: Stores {
                bases: HashMap::new(),
                impacts: HashMap::new(),
                after: HashMap::new(),
                sets: Recent::new(SETS_KEPT),
                retained: HashMap::new(),
            },
            warming: None,
        })
    }

    fn company_of(&self, employee: usize) -> Result<usize, &'static str> {
        self.data
            .members
            .get(employee)
            .ok_or("No such employee.")?
            .company
            .ok_or("The employee's company isn't in the snapshot.")
    }
    /// The roster `r` names, checked.
    pub fn roster(&self, r: RosterInput) -> Result<RosterKey, &'static str> {
        if r.company >= self.data.places.len() {
            return Err("No such company.");
        }
        if let Some(e) = r.without
            && self.company_of(e)? != r.company
        {
            return Err("The employee left out isn't in the company.");
        }
        Ok((r.company, r.without))
    }

    /// Employee `employee` in their company as it is. With coworkers, each
    /// coworker is a model in their own context, where `employee` is the
    /// priced peer, so a card's rules can value what this employee's
    /// Production and wage do to the coworkers' traits.
    pub fn model(&self, employee: usize, options: ModelOptions) -> Result<Model, &'static str> {
        let company = self.company_of(employee)?;
        let data = &self.data;
        let c = &data.places[company];
        let roster = data.persons(&c.members);
        let at = c
            .members
            .iter()
            .position(|&i| i == employee)
            .ok_or("The employee isn't in their company.")?;
        let energy = options.energy_value.unwrap_or(Energy::Number(0.0));
        let m = &data.members[employee];
        let mut context = data.context(c, m, &roster, at, None, energy.clone());
        if options.coworkers != Some(false) {
            let coworkers = c
                .members
                .iter()
                .enumerate()
                .filter(|&(j, _)| j != at)
                .map(|(j, &i)| {
                    let x = &data.members[i];
                    Coworker {
                        employee: Rc::new(x.employee.clone()),
                        context: Rc::new(data.context(c, x, &roster, j, Some(at), energy.clone())),
                    }
                })
                .collect();
            Rc::make_mut(&mut context.situation).coworker_models = Some(coworkers);
        }
        Ok(Model { employee: m.employee.clone(), context })
    }

    /// Employee `employee`'s company with and without them (retention's
    /// price), kept for their row.
    pub fn retention(&mut self, employee: usize) -> Result<Kept, &'static str> {
        let kept = self.retention.price(employee).map_err(|f| f.message())?;
        let retained = Retained { value: kept.value, own: kept.own, by_day: kept.by_day.clone() };
        self.kept.retained.insert(employee, retained);
        Ok(kept)
    }

    /// The coworkers of roster `key` before a newcomer.
    fn bases(&mut self, key: RosterKey) -> Rc<Bases> {
        if let Some(b) = self.kept.bases.get(&key) {
            return b.clone();
        }
        let data = &self.data;
        let c = &data.places[key.0];
        let employees = data.roster(key);
        let persons = data.persons(&employees);
        let coworkers = employees
            .iter()
            .enumerate()
            .map(|(at, &i)| {
                let m = &data.members[i];
                let context = data.context(c, m, &persons, at, None, Energy::Number(0.0));
                let was = m
                    .traits()
                    .iter()
                    .map(|t| trait_value(&t.code, &m.employee, &context, t.arg.clone(), true).value)
                    .collect();
                Base { employee: i, was }
            })
            .collect();
        let by_wage =
            employees.iter().any(|&i| data.members[i].traits().iter().any(|t| reads_wage(&t.code)));
        let bases = Rc::new(Bases { coworkers, by_wage });
        self.kept.bases.insert(key, bases.clone());
        bases
    }

    /// What newcomer `n` (with a wage) does to the traits of roster `key`'s
    /// coworkers. Their traits are valued with the newcomer among them, each
    /// once per newcomer it can tell apart: the wage reaches them only
    /// through who is better paid, which only the wage traits read.
    fn impact_of(&mut self, key: RosterKey, n: &Newcomer) -> Rc<Impact> {
        let bases = self.bases(key);
        let wage = n.wage.unwrap_or(f64::NAN).to_bits();
        let newcomer_key =
            (n.nationality, n.female, n.production.to_bits(), bases.by_wage.then_some(wage));
        if let Some(impact) = self.kept.impacts.get(&(key, newcomer_key)) {
            return impact.clone();
        }
        let data = &self.data;
        let c = &data.places[key.0];
        let employees = data.roster(key);
        let newcomer = data.newcomer(n);
        let mut joined = data.persons(&employees);
        joined.push(&newcomer);
        let (mut value, mut notes) = (0.0, Vec::new());
        for (k, base) in bases.coworkers.iter().enumerate() {
            let m = &data.members[base.employee];
            let mut after: Option<Context> = None;
            for (i, t) in m.traits().iter().enumerate() {
                let trait_key = (
                    n.nationality,
                    n.female,
                    n.production.to_bits(),
                    reads_wage(&t.code).then_some(wage),
                );
                let now = match self.kept.after.get(&(key, k, i, trait_key)) {
                    Some(&now) => now,
                    None => {
                        let context = after.get_or_insert_with(|| {
                            data.context(c, m, &joined, k, None, Energy::Number(0.0))
                        });
                        let now =
                            trait_value(&t.code, &m.employee, context, t.arg.clone(), true).value;
                        self.kept.after.insert((key, k, i, trait_key), now);
                        now
                    }
                };
                let (Some(was), Some(now)) = (base.was[i], now) else { continue };
                if (now - was).abs() < 0.5 {
                    continue;
                }
                value += now - was;
                notes.push(Note { employee: base.employee, code: t.code.clone() });
            }
        }
        let impact = Rc::new(Impact { value, notes });
        self.kept.impacts.insert((key, newcomer_key), impact.clone());
        impact
    }

    /// `impact_of` for the page.
    pub fn impact(&mut self, key: RosterKey, n: NewcomerInput) -> Rc<Impact> {
        self.impact_of(key, &n.into())
    }

    /// What newcomers of `group` in roster `key` do to the coworkers, on the
    /// wage grid at Production `p` (1 to 4) for one gender.
    fn grid_row(&mut self, key: RosterKey, nationality: u32, female: bool, p: usize) -> Vec<f64> {
        let production = p as f64;
        fresh::wage_grid()
            .iter()
            .map(|&x| {
                let wage_pp = production / crate::cfg::CFG.output_divisor * x;
                let n = Newcomer {
                    nationality,
                    female,
                    production,
                    wage: Some(wage_pp * self.data.pp),
                };
                self.impact_of(key, &n).value
            })
            .collect()
    }

    /// A fresh set in roster `key` (`rate: 'slot'`, 6,000 draws, seed 1).
    pub fn fresh_set(&mut self, key: RosterKey, alt: f64, slots: u32) -> Rc<FreshSet> {
        let set_key = (key, alt.to_bits(), slots);
        if let Some(set) = self.kept.sets.get(&set_key) {
            return set;
        }
        let employees = self.data.roster(key);
        let groups = self.data.groups(&self.data.places[key.0], &employees);
        let mut coworkers = Vec::with_capacity(groups.len());
        for g in &groups {
            let mut rows: [[Option<Vec<f64>>; 5]; 2] = Default::default();
            if !employees.is_empty() {
                for (female, by_production) in [false, true].into_iter().zip(&mut rows) {
                    for (p, row) in by_production.iter_mut().enumerate().skip(1) {
                        *row = Some(self.grid_row(key, g.nationality, female, p));
                    }
                }
            }
            coworkers.push(rows);
        }
        let read = groups
            .iter()
            .zip(coworkers)
            .map(|(g, coworkers)| SetGroup { setting: &g.setting, weight: g.weight, coworkers })
            .collect();
        let options = FreshSetOptions { alt, slots, draws: 6000, seed: 1, rate: Rate::Slot };
        let set = Rc::new(fresh::fresh_set_of(read, &options));
        self.kept.sets.insert(set_key, set.clone());
        set
    }

    /// `fresh_set` for the page.
    pub fn fresh_set_for(&mut self, key: RosterKey, options: SetOptions) -> Rc<FreshSet> {
        let alt = options.alt.filter(|a| a.is_finite()).unwrap_or(0.0);
        let slots = options.slots.filter(|s| s.is_finite()).map_or(3, |n| n as u32);
        self.fresh_set(key, alt, slots)
    }

    /// One step of building employee `employee`'s fresh set (the company
    /// without them) ahead of their row; true once it is ready.
    pub fn prepare(&mut self, employee: usize) -> Result<bool, &'static str> {
        let company = self.company_of(employee)?;
        let key = (company, Some(employee));
        let mut w = match self.warming.take() {
            Some(w) if w.employee == employee => w,
            _ => {
                let employees = self.data.roster(key);
                let groups = self.data.groups(&self.data.places[company], &employees);
                Warming { employee, groups, group: 0, builder: None, tables_done: false, row: 0 }
            }
        };
        let coworkers = self.data.places[company].members.len() > 1;
        loop {
            let Some(g) = w.groups.get(w.group) else { return Ok(true) };
            if !w.tables_done {
                if w.builder.is_none() {
                    if fresh::own_tables_cached(&g.setting).is_some() {
                        w.tables_done = true;
                        continue;
                    }
                    w.builder = Some(OwnTablesBuilder::new(&g.setting));
                }
                if w.builder.as_mut().is_some_and(|b| b.step().is_some()) {
                    w.builder = None;
                    w.tables_done = true;
                }
                break;
            }
            if !coworkers || w.row >= 8 {
                w.group += 1;
                w.tables_done = false;
                w.row = 0;
                continue;
            }
            let (female, p) = (w.row >= 4, w.row % 4 + 1);
            let nationality = g.nationality;
            w.row += 1;
            self.grid_row(key, nationality, female, p);
            break;
        }
        self.warming = Some(w);
        Ok(false)
    }

    /// Employee `employee`'s keep row (after `retention(employee)`).
    pub fn row(&mut self, employee: usize, feed: Feed) -> Result<Row, &'static str> {
        let company = self.company_of(employee)?;
        let (value, own, by_day) = match self.kept.retained.get(&employee) {
            Some(kept) => (kept.value, kept.own, kept.by_day.clone()),
            None => {
                let kept = self.retention(employee)?;
                (kept.value, kept.own, kept.by_day)
            }
        };
        let alt = feed.alt.filter(|a| a.is_finite()).unwrap_or(0.0);
        let data = &self.data;
        let (pp, c, m) = (data.pp, &data.places[company], &data.members[employee]);
        // Retention is in money: its own part, and the rest the coworkers'.
        let coworkers = (value - own) / pp;
        let own = own / pp;
        let roster = data.persons(&c.members);
        let at = c
            .members
            .iter()
            .position(|&i| i == employee)
            .ok_or("The employee isn't in their company.")?;
        let energy = feed.energy_value.unwrap_or(Energy::Number(0.0));
        let context = data.context(c, m, &roster, at, None, energy);
        let e = RulesEmployee { potential_max: m.potential_max, ..m.employee.clone() };
        let left = m.potential_left;
        let training_value = feed.training_value.filter(|v| v.is_finite());
        let potential = potential_value(&e, &context, left, alt, training_value, &Memo::default());
        let days = working_days(&e);
        let rest = data.roster((company, Some(employee)));
        // 3 candidate slots, plus 1 per Recruiter in the company, up to 3 extra.
        let slots = 3 + rest.iter().filter(|&&i| data.members[i].recruiter).count().min(3) as u32;
        let fresh = self.fresh_set((company, Some(employee)), alt, slots);
        let keep = own + potential;
        let leaving = -coworkers;
        let stay = keep - leaving;
        let held = fresh.rate * days;
        let surplus = stay - held;
        let data = &self.data;
        // Firing them after d whole days, short of retirement: what they add
        // until then. Their trainings count only when kept to the end.
        let worked = (days.ceil() as usize).min(by_day.len());
        let (mut sum, mut best) = (0.0, None::<(usize, f64)>);
        for (d, v) in by_day[..worked.saturating_sub(1)].iter().enumerate() {
            sum += v / data.pp;
            if best.is_none_or(|(_, b)| sum > b) {
                best = Some((d + 1, sum));
            }
        }
        let others = || data.places[company].members.iter().copied().filter(|&i| i != employee);
        let leave =
            best.filter(|&(_, v)| v >= stay.max(0.0) + leave_margin(stay)).map(|(d, value)| {
                let day = d as f64;
                let retires = others()
                    .map(|i| (i, working_days(&data.members[i].employee)))
                    .filter(|&(_, w)| w > day - 1.0 && w <= day)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(i, _)| i);
                Leave { day, value, surplus: value - fresh.rate * day, retires }
            });
        let worst = by_day[..worked]
            .iter()
            .enumerate()
            .filter(|&(_, &v)| v < 0.0)
            .min_by(|a, b| a.1.total_cmp(b.1))
            .map(|(d, _)| d as f64);
        let harm = worst.map_or_else(Vec::new, |d| data.held_back(company, employee, d));
        let bar = leave.as_ref().map_or(surplus, |l| l.surplus.max(surplus)) + alt;
        Ok(Row {
            own,
            potential,
            keep,
            leaving,
            stay,
            days,
            held,
            surplus,
            bar,
            gain: fresh.best - bar,
            chance: fresh.beat(bar),
            left,
            slots,
            fresh: fresh.summary(),
            leave,
            harm,
        })
    }

    /// A typed candidate joining roster `key`: their value in the company as
    /// they'd see it (the coworkers' side is `impact`).
    pub fn candidate(
        &mut self,
        key: RosterKey,
        n: NewcomerInput,
        candidate: &Candidate,
        options: CandidateInput,
    ) -> Priced {
        let employees = self.data.roster(key);
        let join = self.data.join(&self.data.places[key.0], &employees, &n.into());
        let place = join.context.situation.place.clone();
        let Setting { context, bonus, happiness_loss } = setting_of(join);
        let alt = options.alt.filter(|a| a.is_finite()).unwrap_or(0.0);
        let options = CandidateOptions { context, bonus, happiness_loss, alt };
        Priced { value: fresh::candidate_value(candidate, &options), place }
    }
}
