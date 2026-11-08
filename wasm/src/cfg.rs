//! The game constants (`CFG`, handed over by `config()`). Numbers come from
//! the game bundle.

use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

impl Rarity {
    pub const ALL: [Rarity; 5] =
        [Rarity::Common, Rarity::Uncommon, Rarity::Rare, Rarity::Epic, Rarity::Legendary];
    pub fn code(self) -> &'static str {
        match self {
            Rarity::Common => "common",
            Rarity::Uncommon => "uncommon",
            Rarity::Rare => "rare",
            Rarity::Epic => "epic",
            Rarity::Legendary => "legendary",
        }
    }
}

#[derive(Serialize)]
pub struct RarityWeights {
    pub common: f64,
    pub uncommon: f64,
    pub rare: f64,
    pub epic: f64,
    pub legendary: f64,
}

/// A shift of the rarity odds, per point (Management level or Luck).
#[derive(Serialize)]
pub struct Shift {
    pub uncommon: f64,
    pub rare: f64,
    pub epic: f64,
    pub legendary: f64,
}

/// The game constants; `config()` serializes them as the facade's `CFG`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub retire_age: f64,
    pub output_divisor: f64,
    pub wage_floor: f64,
    pub potential_max_cap: f64,
    pub hand_size: f64,
    /// A Wild Card's random stat gain (v0.27.4: 1 -> 2).
    pub wild_card_stat_gain: f64,
    /// Whether the wage is paid on the employee's own traits' flat Production
    /// too. v0.27.4 paid it for a few hours, then the server
    /// went back to base (hired + trained) Production only.
    pub trait_production_paid: bool,
    /// Happiness per point of Responsibility, always on.
    #[serde(rename = "respHappiness")]
    pub responsibility_happiness: f64,
    pub happiness_max: f64,
    /// % bonus, gained 1% a day on one product.
    pub specialization_max: f64,
    pub toolbox_chance_per_luck: f64,
    pub max_toolbox_chance_per_hour: f64,
    pub rarity_weights: RarityWeights,
    /// Per owner Management level.
    pub management_shift: Shift,
    pub luck_shift: Shift,
}

/// `CFG.traitProductionPaid` as set now (`setTraitProductionPaid`): a
/// switch for the paid rule, off as the game has it.
static TRAIT_PRODUCTION_PAID: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(CFG.trait_production_paid);
pub fn trait_production_paid() -> bool {
    TRAIT_PRODUCTION_PAID.load(std::sync::atomic::Ordering::Relaxed)
}
pub fn set_trait_production_paid(on: bool) {
    TRAIT_PRODUCTION_PAID.store(on, std::sync::atomic::Ordering::Relaxed)
}

pub const CFG: Config = Config {
    retire_age: 65.0,
    output_divisor: 4.0,
    wage_floor: 0.7,
    potential_max_cap: 15.0,
    hand_size: 3.0,
    wild_card_stat_gain: 2.0,
    trait_production_paid: false,
    responsibility_happiness: 3.0,
    happiness_max: 100.0,
    specialization_max: 20.0,
    toolbox_chance_per_luck: 0.001,
    max_toolbox_chance_per_hour: 0.02,
    rarity_weights: RarityWeights {
        common: 55.0,
        uncommon: 25.0,
        rare: 13.0,
        epic: 5.0,
        legendary: 2.0,
    },
    management_shift: Shift { uncommon: 1.0, rare: 0.6, epic: 0.3, legendary: 0.1 },
    luck_shift: Shift { uncommon: 0.5, rare: 0.3, epic: 0.15, legendary: 0.05 },
};
