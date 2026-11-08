//! Trait ids, their rules and the exclusive pairs: the data half of the
//! trait table. The display half (name, when, note) is the facade's
//! (js/employee-traits.js).
//!
//! A trait id is its place in `Trait`'s order, the order `traitRules` hands
//! over (the facade's `TRAITS` follows it), so a set of traits is a 64-bit
//! mask.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Polarity {
    Positive,
    Mixed,
    Negative,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Gender {
    Male,
    Female,
}

/// What a trait takes when gained: nothing, the company's good, or a stat.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgumentKind {
    None,
    Good,
    Stat,
}

/// How much of a trait's payoff the model prices.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Priced {
    Full,
    Partial,
    Unpriced,
}

#[derive(Serialize)]
pub struct Rule {
    pub code: &'static str,
    pub polarity: Polarity,
    /// Roll weight; 0 never rolls.
    pub weight: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<Gender>,
    /// Linked to another employee (Old Friends, Nemesis, Sweethearts).
    #[serde(skip_serializing_if = "is_false")]
    pub partner: bool,
    #[serde(skip_serializing_if = "is_no_argument")]
    pub arg: ArgumentKind,
    pub priced: Priced,
}
fn is_false(b: &bool) -> bool {
    !*b
}
fn is_no_argument(kind: &ArgumentKind) -> bool {
    *kind == ArgumentKind::None
}

macro_rules! trait_table {
    (@opt) => { None };
    (@opt $v:expr) => { Some($v) };
    (@or $d:expr;) => { $d };
    (@or $d:expr; $v:expr) => { $v };
    ($($variant:ident $code:literal $polarity:ident $weight:literal $(gender=$gender:ident)? $(partner=$partner:literal)? $(arg=$arg:ident)? $(priced=$priced:ident)?;)*) => {
        #[repr(u8)]
        #[derive(Clone, Copy, PartialEq, Eq)]
        pub enum Trait { $($variant),* }
        pub const TRAITS: &[Trait] = &[$(Trait::$variant),*];
        pub const RULES: &[Rule] = &[$(Rule {
            code: $code,
            polarity: Polarity::$polarity,
            weight: $weight,
            gender: trait_table!(@opt $(Gender::$gender)?),
            partner: trait_table!(@or false; $($partner)?),
            arg: trait_table!(@or ArgumentKind::None; $(ArgumentKind::$arg)?),
            priced: trait_table!(@or Priced::Full; $(Priced::$priced)?),
        }),*];
    };
}

trait_table! {
    Handy "handy" Positive 5;
    Improviser "improviser" Positive 5;
    Nationalist "nationalist" Positive 10;
    Xenophobe "xenophobe" Negative 10;
    Cosmopolitan "cosmopolitan" Positive 10;
    TalksToMachines "talksToMachines" Positive 5;
    Loner "loner" Positive 5;
    Sociable "sociable" Mixed 10;
    Comic "comic" Mixed 10;
    Mentor "mentor" Mixed 2;
    Foreman "foreman" Positive 5;
    Rival "rival" Mixed 5;
    PrimaDonna "primaDonna" Mixed 5;
    Bully "bully" Negative 5;
    Envious "envious" Negative 10;
    OldFriends "oldFriends" Positive 2 partner=true;
    Nemesis "nemesis" Negative 2 partner=true;
    Sweethearts "sweethearts" Positive 0 partner=true;
    GirlPower "girlPower" Positive 5 gender=Female;
    BandOfBrothers "bandOfBrothers" Positive 5 gender=Male;
    ManHater "manHater" Negative 5 gender=Female;
    Misogynist "misogynist" Negative 5 gender=Male;
    Specialist "specialist" Positive 10 arg=Good;
    Craftsman "craftsman" Mixed 10;
    Laborer "laborer" Mixed 10;
    QuickStudy "quickStudy" Positive 10;
    Stockpiler "stockpiler" Positive 10;
    Claustrophobe "claustrophobe" Negative 5;
    Veteran "veteran" Positive 5;
    CreatureOfHabit "creatureOfHabit" Negative 10;
    DiamondInTheRough "diamondInTheRough" Positive 2 arg=Stat;
    Burnout "burnout" Negative 2;
    LateBloomer "lateBloomer" Positive 5;
    EarlyBloomer "earlyBloomer" Positive 5;
    WornOut "wornOut" Negative 10;
    Patriot "patriot" Positive 10;
    Homesick "homesick" Negative 10;
    Expat "expat" Positive 10;
    TaxShy "taxShy" Negative 10;
    Statist "statist" Positive 10;
    Greedy "greedy" Negative 10;
    Modest "modest" Positive 10;
    Climber "climber" Negative 10;
    Loyal "loyal" Positive 5;
    FlightRisk "flightRisk" Negative 10 priced=Unpriced;
    Anchor "anchor" Mixed 5 priced=Partial;
    Scavenger "scavenger" Mixed 2;
    Salvager "salvager" Positive 5;
    Gambler "gambler" Mixed 10;
    LuckyCharm "luckyCharm" Positive 5;
    Jinx "jinx" Negative 10;
    Recruiter "recruiter" Positive 2 priced=Unpriced;
    Trainer "trainer" Positive 5 priced=Unpriced;
}

const _: () = assert!(TRAITS.len() == RULES.len() && TRAITS.len() <= 64);

impl Trait {
    pub const fn id(self) -> u8 {
        self as u8
    }
    pub const fn rule(self) -> &'static Rule {
        &RULES[self as usize]
    }
    pub fn code(self) -> &'static str {
        self.rule().code
    }
    pub fn from_code(code: &str) -> Option<Trait> {
        RULES.iter().position(|r| r.code == code).map(|i| TRAITS[i])
    }
}

/// A set of traits as a bitmask over trait ids.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct TraitSet(pub u64);

impl TraitSet {
    pub const EMPTY: TraitSet = TraitSet(0);
    pub const fn with(self, t: Trait) -> TraitSet {
        TraitSet(self.0 | 1 << t as u8)
    }
    pub const fn has(self, t: Trait) -> bool {
        self.0 & 1 << t as u8 != 0
    }
    pub fn iter(self) -> impl Iterator<Item = Trait> {
        TRAITS.iter().copied().filter(move |&t| self.has(t))
    }
}

/// An employee can't hold both of a pair.
pub const EXCLUSIVE: &[(Trait, Trait)] = {
    use Trait::*;
    &[
        (Handy, Improviser),
        (TalksToMachines, Sociable),
        (TalksToMachines, Comic),
        (TalksToMachines, Foreman),
        (TalksToMachines, Mentor),
        (TalksToMachines, Trainer),
        (TalksToMachines, LuckyCharm),
        (Loner, Sociable),
        (Cosmopolitan, Xenophobe),
        (Comic, Bully),
        (Craftsman, Laborer),
        (Expat, Homesick),
        (Statist, TaxShy),
        (DiamondInTheRough, Burnout),
        (Greedy, Modest),
        (FlightRisk, Anchor),
        (LuckyCharm, Jinx),
        (Scavenger, Handy),
        (Nationalist, Cosmopolitan),
        (Loyal, FlightRisk),
        (LateBloomer, WornOut),
        (EarlyBloomer, LateBloomer),
        (Veteran, Burnout),
        (Foreman, Bully),
        (Mentor, Bully),
        (PrimaDonna, Modest),
        (Climber, Modest),
        (Envious, Modest),
        (Patriot, Expat),
        (Xenophobe, Expat),
        (Stockpiler, Claustrophobe),
        (Loner, Comic),
        (Loner, Foreman),
        (Loner, Mentor),
        (Loner, Trainer),
        (Loner, LuckyCharm),
    ]
};

/// Per trait, the traits it can't be held with.
pub const CONFLICTS: [TraitSet; TRAITS.len()] = {
    let mut out = [TraitSet::EMPTY; TRAITS.len()];
    let mut i = 0;
    while i < EXCLUSIVE.len() {
        let (a, b) = EXCLUSIVE[i];
        out[a as usize] = out[a as usize].with(b);
        out[b as usize] = out[b as usize].with(a);
        i += 1;
    }
    out
};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_follow_the_table() {
        for (i, &t) in TRAITS.iter().enumerate() {
            assert_eq!(t.id() as usize, i);
            assert!(Trait::from_code(t.code()) == Some(t));
        }
        assert!(Trait::from_code("sprinter").is_none());
    }
    #[test]
    fn conflicts_are_symmetric() {
        use Trait::*;
        assert!(
            CONFLICTS[Handy as usize].has(Improviser) && CONFLICTS[Improviser as usize].has(Handy)
        );
        assert!(CONFLICTS[Handy as usize].has(Scavenger));
        assert!(!CONFLICTS[Handy as usize].has(Loner));
    }
}
