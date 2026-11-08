//! Each trait's effect on one working hour (`hourly`): the game's trait
//! table. The rules run it in three passes, each with its own
//! `HourlyEffects`: a trait's value over the working life
//! (`rules::trait_value`), the ordinary Production pass
//! (`rules::ordinary_production`, which only collects Production), and
//! today's output (`rules::trait_output_today`); the projection runs it too
//! (`project::effects`, `project::good_production_of`).
//!
//! A trait calls its helpers in a fixed order, short-circuits included,
//! because a pass may collect side effects; their values add up left to
//! right.

use crate::model::Situation;
use crate::rules::toolbox_rate;
use crate::traits::Trait::{self, *};

/// Which stat `x.stat(arg, k)` moves.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StatArgument {
    Production,
    Responsibility,
    Other,
}

impl StatArgument {
    pub fn of(arg: Option<&str>) -> StatArgument {
        match arg {
            Some("production") => StatArgument::Production,
            Some("responsibility") => StatArgument::Responsibility,
            _ => StatArgument::Other,
        }
    }
}

/// What a trait's hourly effect reads of the employee and their situation
/// (`x`), and where its effects go. Each effect returns its value
/// in the pass's money (0 where a pass only collects it).
pub trait HourlyEffects {
    /// `x.s`.
    fn situation(&self) -> &Situation;
    /// Whether the employee holds the trait now (else it is being gained).
    fn held(&self) -> bool;
    /// `x.male`.
    fn male_coworkers(&self) -> f64;
    /// `x.loss`.
    fn happiness_loss(&self) -> f64;
    fn arg(&self) -> Option<&str>;
    fn age(&self) -> f64;
    /// `x.tenure`.
    fn tenure_days(&self) -> f64;
    /// `x.employed`.
    fn employed_days(&self) -> f64;
    /// `x.e.luck`.
    fn own_luck(&self) -> f64;
    /// `x.prod(d)`: flat Production.
    fn production(&mut self, delta: f64) -> f64;
    /// `x.pct(p)`: output, in %.
    fn output_percent(&mut self, percent: f64) -> f64;
    /// `x.happy(h)`.
    fn happiness(&mut self, delta: f64) -> f64;
    /// `x.resp(d)`.
    fn responsibility(&mut self, delta: f64) -> f64;
    fn luck(&mut self, delta: f64) -> f64;
    /// `x.boxes(rate)`: toolboxes found per hour.
    fn toolboxes(&mut self, rate: f64) -> f64;
    /// `x.wage(f)`: the wage moves by the fraction f.
    fn wage(&mut self, factor: f64) -> f64;
    /// `x.raise(k)`: k Climber raises of +0.02 wage expectation.
    fn raise(&mut self, raises: f64) -> f64;
    /// `x.teamHappy(h)`.
    fn team_happiness(&mut self, delta: f64) -> f64;
    /// `x.teamProd(d)`.
    fn team_production(&mut self, delta: f64) -> f64;
    fn engine(&mut self) -> f64;
    fn quick_study(&mut self) -> f64;
    fn stat(&mut self, stat: StatArgument, delta: f64) -> f64;
}

/// `n` times `each`, capped at `cap` (which has the sign of `each`).
pub fn capped_per(n: f64, each: f64, cap: f64) -> f64 {
    if cap < 0.0 { cap.max(n * each) } else { cap.min(n * each) }
}

/// Whether a trait has an hourly rule (Flight Risk, Anchor, Recruiter and
/// Trainer have none).
pub fn has_hourly(t: Trait) -> bool {
    !matches!(t, FlightRisk | Anchor | Recruiter | Trainer)
}

/// The trait's effect on this hour, in the pass's money: 0 for a trait
/// without an hourly rule (`has_hourly`).
pub fn hourly(t: Trait, x: &mut dyn HourlyEffects) -> f64 {
    match t {
        Handy => {
            if x.situation().has_tool {
                x.output_percent(40.0)
            } else {
                0.0
            }
        }
        Improviser => {
            if x.situation().has_tool {
                0.0
            } else {
                x.output_percent(25.0)
            }
        }
        Nationalist => {
            let s = x.situation();
            let with = s
                .same_nationality_coworkers
                .unwrap_or(s.coworkers != 0.0 && s.other_nationalities == 0.0);
            if with { x.happiness(10.0) } else { 0.0 }
        }
        Xenophobe => {
            if x.situation().other_nationalities != 0.0 {
                x.production(-2.0) + x.happiness(-5.0)
            } else {
                0.0
            }
        }
        Cosmopolitan => {
            let n = capped_per(x.situation().other_nationalities, 2.0, 4.0);
            x.production(n)
        }
        TalksToMachines => {
            if x.situation().coworkers == 0.0 {
                x.engine()
            } else {
                0.0
            }
        }
        Loner => {
            if x.situation().coworkers != 0.0 {
                0.0
            } else {
                x.output_percent(100.0) + x.happiness(5.0)
            }
        }
        Sociable => {
            let c = x.situation().coworkers;
            if c != 0.0 { x.output_percent(capped_per(c, 25.0, 50.0)) } else { x.happiness(-10.0) }
        }
        Comic => {
            if x.situation().coworkers != 0.0 {
                x.production(-1.0) + x.team_happiness(10.0)
            } else {
                0.0
            }
        }
        Mentor => {
            if x.situation().weaker_coworker {
                x.team_production(2.0) + x.production(-1.0)
            } else {
                0.0
            }
        }
        Foreman => {
            if x.situation().coworkers != 0.0 {
                x.team_happiness(9.0)
            } else {
                0.0
            }
        }
        Rival => {
            let s = x.situation();
            if s.coworkers != 0.0 {
                let d = if s.stronger_coworker { 3.0 } else { -1.0 };
                x.production(d)
            } else {
                0.0
            }
        }
        PrimaDonna => {
            let s = x.situation();
            if s.coworkers == 0.0 {
                0.0
            } else if s.better_paid != 0.0 {
                x.happiness(-10.0)
            } else {
                x.output_percent(20.0)
            }
        }
        Bully => {
            if x.situation().coworkers != 0.0 {
                x.production(2.0) + x.team_happiness(-10.0)
            } else {
                0.0
            }
        }
        Envious => {
            let n = capped_per(x.situation().better_paid, -5.0, -10.0);
            x.happiness(n)
        }
        OldFriends => x.output_percent(15.0),
        Nemesis => x.output_percent(-15.0),
        Sweethearts => x.output_percent(20.0),
        GirlPower => {
            let n = capped_per(x.situation().female_coworkers, 15.0, 30.0);
            x.output_percent(n)
        }
        BandOfBrothers => {
            let n = capped_per(x.male_coworkers(), 15.0, 30.0);
            x.output_percent(n)
        }
        ManHater => {
            let n = capped_per(x.male_coworkers(), -15.0, -30.0);
            x.output_percent(n)
        }
        Misogynist => {
            let n = capped_per(x.situation().female_coworkers, -15.0, -30.0);
            x.output_percent(n)
        }
        Specialist => {
            let on = match x.arg() {
                Some("match") => true,
                Some(a) => x.situation().product.as_deref() == Some(a),
                None => false,
            };
            if on { x.production(3.0) + x.happiness(5.0) } else { 0.0 }
        }
        Craftsman => {
            let d = if x.situation().item_type.as_deref() == Some("raw") { -1.0 } else { 3.0 };
            x.production(d)
        }
        Laborer => {
            let d = if x.situation().item_type.as_deref() == Some("raw") { 3.0 } else { -1.0 };
            x.production(d)
        }
        QuickStudy => x.quick_study(),
        Stockpiler => {
            if x.situation().storage_full {
                x.happiness(10.0)
            } else {
                0.0
            }
        }
        Claustrophobe => {
            if x.situation().small_storage {
                x.output_percent(-20.0)
            } else {
                0.0
            }
        }
        Veteran => {
            if x.tenure_days() >= 30.0 {
                x.output_percent(20.0)
            } else {
                0.0
            }
        }
        CreatureOfHabit => 0.0,
        DiamondInTheRough => {
            let stat = StatArgument::of(x.arg());
            let k = (x.tenure_days() / 10.0).floor().min(4.0);
            x.stat(stat, k)
        }
        Burnout => {
            let k = -(x.tenure_days() / 20.0).floor().min(3.0);
            x.production(k) + x.responsibility(k) + x.luck(k)
        }
        LateBloomer => {
            let d = (2.0 * ((x.age() - 40.0).max(0.0) / 10.0).floor()).min(6.0);
            x.production(d)
        }
        EarlyBloomer => {
            let d = (6.0 - 2.0 * ((x.age() - 30.0).max(0.0) / 10.0).floor()).max(0.0);
            x.production(d)
        }
        WornOut => {
            let d = -(2.0 * ((x.age() - 50.0).max(0.0) / 10.0).floor()).min(6.0);
            x.production(d)
        }
        Patriot => {
            let s = x.situation();
            let home = s.home_core.unwrap_or_else(|| s.place.as_deref() == Some("homeCore"));
            if home { x.production(2.0) + x.happiness(10.0) } else { 0.0 }
        }
        Homesick => {
            let s = x.situation();
            if s.place.as_deref() == Some("abroad") && !s.home_core.unwrap_or(false) {
                x.production(-2.0) + x.happiness(-10.0)
            } else {
                0.0
            }
        }
        Expat => {
            if x.situation().place.as_deref() == Some("abroad") {
                x.production(2.0)
            } else {
                0.0
            }
        }
        TaxShy => {
            let p = -x.situation().income_tax.min(30.0);
            x.output_percent(p)
        }
        Statist => {
            if x.situation().income_tax >= 20.0 {
                x.happiness(6.0)
            } else {
                0.0
            }
        }
        // Held, the wage already includes it; gained, it applies on top.
        Greedy => {
            let f = if x.held() { 1.0 - 1.0 / 1.2 } else { 0.2 };
            x.wage(f)
        }
        Modest => {
            let f = if x.held() { 1.0 - 1.0 / 0.85 } else { -0.15 };
            x.wage(f)
        }
        Climber => {
            let k = (x.employed_days() / 7.0).floor() - (x.situation().employed_days / 7.0).floor();
            x.raise(k)
        }
        Loyal => {
            let h = -x.happiness_loss() / 2.0;
            -x.happiness(h)
        }
        FlightRisk | Anchor | Recruiter | Trainer => 0.0,
        Scavenger => {
            let r = toolbox_rate(x.own_luck());
            x.output_percent(-25.0) + x.toolboxes(r)
        }
        Salvager => {
            if x.situation().storage_full {
                let r = toolbox_rate(x.own_luck());
                x.toolboxes(r)
            } else {
                0.0
            }
        }
        Gambler => x.luck(3.0) + x.output_percent(-15.0),
        LuckyCharm => {
            let n = x.situation().coworkers;
            n * x.luck(3.0)
        }
        Jinx => {
            let n = x.situation().coworkers;
            n * x.luck(-2.0)
        }
    }
}
