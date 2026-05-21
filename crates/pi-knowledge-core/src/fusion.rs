//! Hybrid retrieval fusion: Reciprocal Rank Fusion (k=60) over per-lane ranked
//! lists, plus lateral signal multipliers (recency, backlinks, confidence).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// k constant in the RRF formula (Cormack et al. 2009).
pub const RRF_K: f32 = 60.0;

/// One ranker's output. Each entry's index in the slice is its rank (0 = first).
#[derive(Debug, Clone)]
pub struct RankedList<'a> {
	pub name: &'a str,
	pub ids:  &'a [String],
}

/// Weights for combining lane scores. Each lane's RRF contribution is multiplied
/// by its weight before summation. Lateral signals are multiplied at the end.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FusionWeights {
	/// Per-lane weights. Lookup by `RankedList::name`. Missing entries default to 1.0.
	pub lanes: BTreeMap<String, f32>,
	/// Recency: exponential decay half-life in seconds (0.0 disables). Default: 7 days.
	pub recency_half_life_secs: f32,
	/// Recency weight in [0, 1]. 0 disables the boost.
	pub recency_weight: f32,
	/// Backlink (in-degree) boost. Multiplied by `ln_1p(in_degree)`. 0 disables.
	pub backlinks_weight: f32,
	/// Confidence multiplier (per-item property in [0, 1]). 0 disables.
	pub confidence_weight: f32,
}

impl Default for FusionWeights {
	fn default() -> Self {
		Self {
			lanes: BTreeMap::from([
				("bm25".into(), 0.3),
				("vector".into(), 0.5),
				("graph".into(), 0.2),
			]),
			recency_half_life_secs: 60.0 * 60.0 * 24.0 * 7.0,
			recency_weight: 0.0,
			backlinks_weight: 0.0,
			confidence_weight: 0.0,
		}
	}
}

/// Per-item lateral signals supplied by the caller. Missing entries default to neutral.
#[derive(Debug, Clone, Default)]
pub struct LateralSignals {
	/// id -> mtime (unix seconds). Used with `recency_half_life_secs`.
	pub mtimes:      BTreeMap<String, u64>,
	/// id -> in-degree (backlinks count).
	pub in_degrees:  BTreeMap<String, u32>,
	/// id -> confidence in [0, 1].
	pub confidences: BTreeMap<String, f32>,
	/// `now_secs`: unix seconds reference for recency. Caller-supplied for testability.
	pub now_secs:    u64,
}

/// Output entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FusedHit {
	pub id:    String,
	pub score: f32,
	/// Why this scored as it did: lane ranks (1-indexed for human reading) + applied boosts.
	pub why:   Why,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Why {
	pub lane_ranks: BTreeMap<String, usize>, // lane -> 1-indexed rank
	pub recency:    f32,
	pub backlinks:  f32,
	pub confidence: f32,
}

/// The fusion function. Cap the output at `limit`. Stable sort by descending score,
/// then by ascending id for tie-break.
pub fn fuse(
	lanes:   &[RankedList<'_>],
	weights: &FusionWeights,
	signals: &LateralSignals,
	limit:   usize,
) -> Vec<FusedHit> {
	#[derive(Debug, Default)]
	struct Working {
		score: f32,
		why:   Why,
	}

	let mut work: BTreeMap<String, Working> = BTreeMap::new();

	for lane in lanes {
		let lane_weight = weights.lanes.get(lane.name).copied().unwrap_or(1.0);
		for (rank, id) in lane.ids.iter().enumerate() {
			let contribution = lane_weight / (RRF_K + rank as f32);
			let w = work.entry(id.clone()).or_default();
			w.score += contribution;
			w.why.lane_ranks.insert(lane.name.to_string(), rank + 1);
		}
	}

	let mut hits: Vec<FusedHit> = work
		.into_iter()
		.map(|(id, mut w)| {
			let recency_mult = if weights.recency_weight > 0.0 && weights.recency_half_life_secs > 0.0
			{
				if let Some(&mtime) = signals.mtimes.get(&id) {
					let elapsed = signals.now_secs.saturating_sub(mtime) as f32;
					let decay = (-elapsed / weights.recency_half_life_secs).exp2();
					weights.recency_weight.mul_add(decay, 1.0)
				} else {
					1.0
				}
			} else {
				1.0
			};

			let backlinks_mult = if weights.backlinks_weight > 0.0 {
				if let Some(&deg) = signals.in_degrees.get(&id) {
					weights.backlinks_weight.mul_add((deg as f32).ln_1p(), 1.0)
				} else {
					1.0
				}
			} else {
				1.0
			};

			let confidence_mult = if weights.confidence_weight > 0.0 {
				if let Some(&conf) = signals.confidences.get(&id) {
					weights.confidence_weight.mul_add(conf, 1.0)
				} else {
					1.0
				}
			} else {
				1.0
			};

			w.score *= recency_mult * backlinks_mult * confidence_mult;
			w.why.recency = recency_mult;
			w.why.backlinks = backlinks_mult;
			w.why.confidence = confidence_mult;

			FusedHit { id, score: w.score, why: w.why }
		})
		.collect();

	hits.sort_by(|a, b| {
		b.score
			.total_cmp(&a.score)
			.then_with(|| a.id.cmp(&b.id))
	});

	hits.truncate(limit);
	hits
}

#[cfg(test)]
mod tests {
	use super::*;

	fn s(id: &str) -> String {
		id.into()
	}

	#[test]
	fn rrf_no_signals_matches_textbook() {
		let lanes = [
			RankedList { name: "bm25", ids: &[s("a"), s("b"), s("c")] },
			RankedList { name: "vector", ids: &[s("a"), s("d"), s("e")] },
		];
		let weights = FusionWeights::default();
		let signals = LateralSignals::default();
		let hits = fuse(&lanes, &weights, &signals, 10);

		assert_eq!(hits[0].id, "a");
		let expected = 0.3 / (RRF_K + 0.0) + 0.5 / (RRF_K + 0.0);
		assert!((hits[0].score - expected).abs() < 1e-6);
	}

	#[test]
	fn rrf_single_lane_yields_ordered() {
		let lanes = [RankedList { name: "bm25", ids: &[s("x"), s("y"), s("z")] }];
		let weights = FusionWeights::default();
		let signals = LateralSignals::default();
		let hits = fuse(&lanes, &weights, &signals, 10);

		assert_eq!(hits.len(), 3);
		assert_eq!(hits[0].id, "x");
		assert_eq!(hits[1].id, "y");
		assert_eq!(hits[2].id, "z");
	}

	#[test]
	fn lane_weights_respected() {
		let lanes = [
			RankedList { name: "heavy", ids: &[s("a")] },
			RankedList { name: "light", ids: &[s("c"), s("d")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("heavy".into(), 0.9),
			("light".into(), 0.1),
		]);
		let signals = LateralSignals::default();
		let hits = fuse(&lanes, &weights, &signals, 10);

		// "a" (rank 0 in heavy) should outrank "c" (rank 0 in light).
		assert_eq!(hits[0].id, "a");
		assert_eq!(hits[1].id, "c");
	}

	#[test]
	fn recency_boost_recent_wins() {
		// Identical RRF scores: swapped across two equally-weighted lanes.
		let lanes = [
			RankedList { name: "lane1", ids: &[s("recent"), s("stale")] },
			RankedList { name: "lane2", ids: &[s("stale"), s("recent")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("lane1".into(), 1.0),
			("lane2".into(), 1.0),
		]);
		weights.recency_weight = 1.0;
		weights.recency_half_life_secs = 60.0 * 60.0 * 24.0 * 7.0; // 7 days

		let now = 10_000_000_u64;
		let signals = LateralSignals {
			mtimes: BTreeMap::from([
				("recent".into(), now),
				("stale".into(), now.saturating_sub(30 * 24 * 60 * 60)),
			]),
			now_secs: now,
			..Default::default()
		};

		let hits = fuse(&lanes, &weights, &signals, 10);
		assert_eq!(hits[0].id, "recent");
		assert!(hits[0].score > hits[1].score);
	}

	#[test]
	fn recency_disabled_no_change() {
		let lanes = [
			RankedList { name: "lane1", ids: &[s("recent"), s("stale")] },
			RankedList { name: "lane2", ids: &[s("stale"), s("recent")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("lane1".into(), 1.0),
			("lane2".into(), 1.0),
		]);
		weights.recency_weight = 0.0;

		let now = 10_000_000_u64;
		let signals = LateralSignals {
			mtimes: BTreeMap::from([
				("recent".into(), now),
				("stale".into(), now.saturating_sub(30 * 24 * 60 * 60)),
			]),
			now_secs: now,
			..Default::default()
		};

		let hits = fuse(&lanes, &weights, &signals, 10);
		// Scores are identical without recency; tie-break by id ascending.
		assert_eq!(hits[0].id, "recent");
		assert_eq!(hits[1].id, "stale");
		assert!((hits[0].score - hits[1].score).abs() < 1e-9);
	}

	#[test]
	fn backlinks_boost_proportional_to_ln() {
		let lanes = [
			RankedList { name: "lane1", ids: &[s("high"), s("low")] },
			RankedList { name: "lane2", ids: &[s("low"), s("high")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("lane1".into(), 1.0),
			("lane2".into(), 1.0),
		]);
		weights.backlinks_weight = 0.5;

		let signals = LateralSignals {
			in_degrees: BTreeMap::from([("high".into(), 10), ("low".into(), 1)]),
			..Default::default()
		};

		let hits = fuse(&lanes, &weights, &signals, 10);
		let high = hits.iter().find(|h| h.id == "high").unwrap();
		let low = hits.iter().find(|h| h.id == "low").unwrap();

		// Boost amount (multiplier - 1.0) is proportional to ln_1p(in_degree).
		let high_boost = high.why.backlinks - 1.0;
		let low_boost = low.why.backlinks - 1.0;
		let expected_ratio = (10.0_f32).ln_1p() / (1.0_f32).ln_1p();
		let actual_ratio = high_boost / low_boost;
		assert!((actual_ratio - expected_ratio).abs() < 1e-4);
	}

	#[test]
	fn confidence_boost_multiplicative() {
		let lanes = [
			RankedList { name: "lane1", ids: &[s("sure"), s("unsure")] },
			RankedList { name: "lane2", ids: &[s("unsure"), s("sure")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("lane1".into(), 1.0),
			("lane2".into(), 1.0),
		]);
		weights.confidence_weight = 0.5;

		let signals = LateralSignals {
			confidences: BTreeMap::from([("sure".into(), 1.0), ("unsure".into(), 0.0)]),
			..Default::default()
		};

		let hits = fuse(&lanes, &weights, &signals, 10);
		let sure = hits.iter().find(|h| h.id == "sure").unwrap();
		let unsure = hits.iter().find(|h| h.id == "unsure").unwrap();

		let ratio = sure.score / unsure.score;
		let expected = 1.0 + weights.confidence_weight;
		assert!((ratio - expected).abs() < 1e-6);
	}

	#[test]
	fn missing_signal_neutral() {
		let lanes = [RankedList { name: "lane1", ids: &[s("x"), s("y")] }];
		let mut weights = FusionWeights::default();
		weights.recency_weight = 1.0;
		weights.backlinks_weight = 1.0;
		weights.confidence_weight = 1.0;

		let empty_signals = LateralSignals::default();
		let hits_empty = fuse(&lanes, &weights, &empty_signals, 10);

		let partial_signals = LateralSignals {
			mtimes: BTreeMap::from([("z".into(), 1_000_000)]),
			in_degrees: BTreeMap::from([("z".into(), 5)]),
			confidences: BTreeMap::from([("z".into(), 0.5)]),
			now_secs: 1_000_000,
		};
		let hits_partial = fuse(&lanes, &weights, &partial_signals, 10);

		assert_eq!(hits_empty, hits_partial);
	}

	#[test]
	fn empty_lanes_returns_empty() {
		let hits = fuse(&[], &FusionWeights::default(), &LateralSignals::default(), 10);
		assert!(hits.is_empty());
	}

	#[test]
	fn tie_break_by_id_ascending() {
		let lanes = [
			RankedList { name: "lane1", ids: &[s("b"), s("a")] },
			RankedList { name: "lane2", ids: &[s("a"), s("b")] },
		];
		let mut weights = FusionWeights::default();
		weights.lanes = BTreeMap::from([
			("lane1".into(), 1.0),
			("lane2".into(), 1.0),
		]);

		let hits = fuse(&lanes, &weights, &LateralSignals::default(), 10);
		assert_eq!(hits[0].id, "a");
		assert_eq!(hits[1].id, "b");
		assert!((hits[0].score - hits[1].score).abs() < 1e-9);
	}

	#[test]
	fn limit_caps_output() {
		let lanes = [RankedList {
			name: "lane1",
			ids: &[s("a"), s("b"), s("c"), s("d"), s("e")],
		}];
		let hits = fuse(&lanes, &FusionWeights::default(), &LateralSignals::default(), 3);
		assert_eq!(hits.len(), 3);
		assert_eq!(hits[0].id, "a");
		assert_eq!(hits[1].id, "b");
		assert_eq!(hits[2].id, "c");
	}
}
