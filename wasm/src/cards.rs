//! Training cards: the ones the model prices by number (`NUMERIC_CARDS`).

use crate::cfg::Rarity;
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stat {
    Production,
    Responsibility,
    Luck,
}

impl Stat {
    pub const ALL: [Stat; 3] = [Stat::Production, Stat::Responsibility, Stat::Luck];
    pub fn of(s: &str) -> Option<Stat> {
        match s {
            "production" => Some(Stat::Production),
            "responsibility" => Some(Stat::Responsibility),
            "luck" => Some(Stat::Luck),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Stat::Production => "production",
            Stat::Responsibility => "responsibility",
            Stat::Luck => "luck",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "card", rename_all = "camelCase")]
pub enum Card {
    Drill {
        stat: Stat,
        delta: f64,
    },
    /// Lowers the wage expectation by `drop`.
    Negotiation {
        drop: f64,
    },
    /// `gain` more trainings.
    SecondWind {
        gain: f64,
    },
}

/// The three drills of one size.
const fn drills(delta: f64) -> [Card; 3] {
    [
        Card::Drill { stat: Stat::Production, delta },
        Card::Drill { stat: Stat::Responsibility, delta },
        Card::Drill { stat: Stat::Luck, delta },
    ]
}
const fn negotiation(drop: f64) -> Card {
    Card::Negotiation { drop }
}
const fn second_wind(gain: f64) -> Card {
    Card::SecondWind { gain }
}

const COMMON: [Card; 4] = {
    let d = drills(1.0);
    [d[0], d[1], d[2], negotiation(0.05)]
};
const UNCOMMON: [Card; 4] = {
    let d = drills(2.0);
    [d[0], d[1], d[2], negotiation(0.10)]
};
const RARE: [Card; 2] = [negotiation(0.20), second_wind(2.0)];
const EPIC: [Card; 4] = {
    let d = drills(3.0);
    [d[0], d[1], d[2], second_wind(3.0)]
};
const LEGENDARY: [Card; 4] = {
    let d = drills(4.0);
    [d[0], d[1], d[2], second_wind(4.0)]
};

/// The cards the model prices by number, per rarity (`NUMERIC_CARDS`).
pub const fn numeric_cards(r: Rarity) -> &'static [Card] {
    match r {
        Rarity::Common => &COMMON,
        Rarity::Uncommon => &UNCOMMON,
        Rarity::Rare => &RARE,
        Rarity::Epic => &EPIC,
        Rarity::Legendary => &LEGENDARY,
    }
}
