//! The shapes the rules' results cross in, for the exports in lib.rs.

use crate::model::RulesEmployee;
use crate::rules::{
    ArgumentOutcome, FieldChange, Note, Outcome, OutcomeTrait, TraitResult, WildCardOutcome,
};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};

impl Serialize for TraitResult {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        entries(self, &mut m)?;
        m.end()
    }
}
fn entries<M: SerializeMap>(r: &TraitResult, m: &mut M) -> Result<(), M::Error> {
    m.serialize_entry("value", &r.value)?;
    m.serialize_entry("outcomes", &ArgumentOutcomes(&r.outcomes))?;
    m.serialize_entry("wageBase", &r.wage_base)?;
    // The facade puts the display text in.
    match r.note {
        Note::None => {}
        Note::Unpriced => m.serialize_entry("note", "unpriced")?,
        Note::Partial => m.serialize_entry("note", "partial")?,
    }
    Ok(())
}
struct ArgumentOutcomes<'a>(&'a [ArgumentOutcome]);
impl Serialize for ArgumentOutcomes<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut q = s.serialize_seq(Some(self.0.len()))?;
        for o in self.0 {
            q.serialize_element(&ArgumentOutcomeOut(o))?;
        }
        q.end()
    }
}
/// `{ arg, p, value, wageBase }`.
struct ArgumentOutcomeOut<'a>(&'a ArgumentOutcome);
impl Serialize for ArgumentOutcomeOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(4))?;
        m.serialize_entry("arg", &self.0.arg.as_deref())?;
        m.serialize_entry("p", &self.0.probability)?;
        m.serialize_entry("value", &self.0.value)?;
        m.serialize_entry("wageBase", &self.0.wage_base)?;
        m.end()
    }
}

/// An outcome as `{ p, arg, traits?, set }`: `traits` lists held traits by
/// index and new ones as `[code, arg]`; `set` is what the card changed, in
/// the order the card sets them. The facade builds the employee from them.
impl Serialize for Outcome {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let o = self;
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("p", &o.probability)?;
        m.serialize_entry("arg", &o.arg.as_deref())?;
        if let Some(traits) = &o.traits {
            m.serialize_entry("traits", &OutcomeTraits(traits))?;
        }
        m.serialize_entry("set", &FieldChanges(&o.set))?;
        m.end()
    }
}
struct OutcomeTraits<'a>(&'a [OutcomeTrait]);
impl Serialize for OutcomeTraits<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut q = s.serialize_seq(Some(self.0.len()))?;
        for item in self.0 {
            match item {
                OutcomeTrait::Held(i) => q.serialize_element(&(*i as f64))?,
                OutcomeTrait::New { trait_id, arg } => {
                    q.serialize_element(&(trait_id.code(), arg.as_deref()))?
                }
            }
        }
        q.end()
    }
}
/// `{ [name]: value }`, in the order set.
struct FieldChanges<'a>(&'a [FieldChange]);
impl Serialize for FieldChanges<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for change in self.0 {
            m.serialize_entry(change.name, &change.value)?;
        }
        m.end()
    }
}

/// A Wild Card outcome as `{ p, value, arg, unpriced }`.
impl Serialize for WildCardOutcome {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(4))?;
        m.serialize_entry("p", &self.probability)?;
        m.serialize_entry("value", &self.value)?;
        m.serialize_entry("arg", self.trait_id.code())?;
        m.serialize_entry("unpriced", &self.unpriced)?;
        m.end()
    }
}

/// `RulesEmployee::default()` as the facade's `DEFAULT_EMPLOYEE`.
pub struct DefaultEmployee;
impl Serialize for DefaultEmployee {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let e = RulesEmployee::default();
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("age", &e.age)?;
        m.serialize_entry("production", &e.production)?;
        m.serialize_entry("responsibility", &e.responsibility)?;
        m.serialize_entry("luck", &e.luck)?;
        m.serialize_entry("traitProduction", &e.trait_production)?;
        m.serialize_entry("extraProduction", &e.extra_production)?;
        m.serialize_entry("bonus", &e.bonus)?;
        m.serialize_entry("productionEvents", &[(); 0])?;
        m.serialize_entry("specialization", &e.specialization)?;
        m.serialize_entry("wageExpectation", &e.wage_expectation)?;
        m.serialize_entry("happinessLoss", &e.happiness_loss)?;
        m.serialize_entry("happiness", &e.happiness)?;
        m.serialize_entry("potentialLeft", &e.potential_left)?;
        m.serialize_entry("trainingsPerDay", &e.trainings_per_day)?;
        m.end()
    }
}
