//! A cache of what was used lately, for values that are pure functions of
//! their key (career states, card pricing's projections).
//!
//! Two generations of up to half the capacity each: new entries go into the
//! current one, a hit in the older one moves the entry up, and once the
//! current one is full it becomes the older one (the old older one is
//! dropped). So the entries used since the last turnover survive it, and
//! memory stays under the capacity, at the cost of a second lookup on a miss.

use std::collections::HashMap;
use std::collections::hash_map::{Entry, RandomState};
use std::hash::{BuildHasher, Hash};

pub struct Recent<K, V, S = RandomState> {
    current: HashMap<K, V, S>,
    older: HashMap<K, V, S>,
    half: usize,
}

impl<K: Hash + Eq, V, S: BuildHasher + Default> Recent<K, V, S> {
    /// A cache that keeps at most `capacity` entries.
    pub fn new(capacity: usize) -> Self {
        Recent {
            current: HashMap::default(),
            older: HashMap::default(),
            half: (capacity / 2).max(1),
        }
    }

    /// The value under `key`, if it is kept.
    pub fn get(&mut self, key: &K) -> Option<V>
    where
        V: Clone,
    {
        if let Some(value) = self.current.get(key) {
            return Some(value.clone());
        }
        let (key, value) = self.older.remove_entry(key)?;
        Some(self.insert(key, value).clone())
    }

    /// The value under `key`, made with `make` if it isn't kept.
    pub fn get_or_insert_with(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        if self.current.len() >= self.half && !self.current.contains_key(&key) {
            let value = self.older.remove(&key);
            self.older = std::mem::take(&mut self.current);
            return self.current.entry(key).or_insert_with(|| value.unwrap_or_else(make));
        }
        match self.current.entry(key) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let value = self.older.remove(entry.key()).unwrap_or_else(make);
                entry.insert(value)
            }
        }
    }

    /// Keeps `value` under `key`.
    pub fn insert(&mut self, key: K, value: V) -> &mut V {
        if self.current.len() >= self.half && !self.current.contains_key(&key) {
            self.older = std::mem::take(&mut self.current);
        }
        match self.current.entry(key) {
            Entry::Occupied(entry) => {
                let kept = entry.into_mut();
                *kept = value;
                kept
            }
            Entry::Vacant(entry) => entry.insert(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_was_used_since_the_turnover() {
        let mut cache: Recent<u32, u32> = Recent::new(4);
        cache.insert(1, 10);
        cache.insert(2, 20);
        // Full: 1 and 2 become the older generation.
        cache.insert(3, 30);
        assert_eq!(cache.get(&1), Some(10));
        // 1 moved up; 3 and 1 fill the current one, which turns over.
        cache.insert(4, 40);
        assert_eq!(cache.get(&2), None);
        assert_eq!(cache.get(&1), Some(10));
        assert_eq!(cache.get(&3), Some(30));
        assert!(cache.current.len() + cache.older.len() <= 4);
        assert_eq!(*cache.get_or_insert_with(5, || 50), 50);
        assert_eq!(*cache.get_or_insert_with(5, || 0), 50);
    }
}
