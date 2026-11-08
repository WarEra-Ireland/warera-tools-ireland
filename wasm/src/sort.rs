//! Stable sorts through one instantiation of the standard library's sort:
//! each `sort_by` instantiation costs ~4 KB of code.

use std::cmp::Ordering;

/// A stable sort of places (indices).
pub fn sort_places(v: &mut [usize], cmp: &dyn Fn(usize, usize) -> Ordering) {
    v.sort_by(|&a, &b| cmp(a, b));
}

/// Numbers in ascending order (`total_cmp`).
pub fn sort_numbers(v: &mut [f64]) {
    v.sort_by(f64::total_cmp);
}

/// A stable sort of any list: its places are sorted, then the items moved.
pub fn sort_list<T>(v: &mut Vec<T>, cmp: &dyn Fn(&T, &T) -> Ordering) {
    let mut order: Vec<usize> = (0..v.len()).collect();
    sort_places(&mut order, &|a, b| cmp(&v[a], &v[b]));
    let mut items: Vec<Option<T>> = std::mem::take(v).into_iter().map(Some).collect();
    v.extend(order.into_iter().filter_map(|i| items[i].take()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable() {
        let mut v: Vec<(f64, usize)> = (0..100).map(|i| (((i * 37) % 11) as f64, i)).collect();
        sort_list(&mut v, &|a, b| a.0.total_cmp(&b.0));
        assert!(v.windows(2).all(|p| p[0].0 < p[1].0 || p[0].0 == p[1].0 && p[0].1 < p[1].1));
    }
}
