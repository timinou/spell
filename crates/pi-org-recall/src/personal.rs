//! Cross-repo personal store recall (`~/.spell/personal/`).
//!
//! Provides `DualContext` and `recall_dual()` that fuse results from a
//! cwd-local and an optional personal recall context, deduplicating by id.
//!
//! Landing for FEAT-642::personal-context.

use std::collections::BTreeMap;

use crate::{
    Result,
    recall::{RecallContext, RecallHit, RecallQuery, recall},
};

/// Bundles two recall contexts for dual-root recall.
pub struct DualContext<'a> {
    pub cwd:      RecallContext<'a>,
    pub personal: Option<RecallContext<'a>>,
}

/// Run `recall` against both contexts, fuse results, dedupe by id (cwd wins
/// on collision), truncate to `query.limit`.
///
/// Returns early with only cwd results when `query.include_personal == false`
/// or `ctx.personal.is_none()`.
pub fn recall_dual(query: RecallQuery, ctx: &DualContext) -> Result<Vec<RecallHit>> {
    if !query.include_personal || ctx.personal.is_none() {
        return recall(query, &ctx.cwd);
    }

    let limit = query.limit;
    let cwd_hits = recall(query.clone(), &ctx.cwd)?;
    let personal_hits = recall(query, ctx.personal.as_ref().unwrap())?;

    // Dedupe: insert cwd hits first (they win on collision), then personal
    // hits that don't collide.
    let mut by_id: BTreeMap<String, RecallHit> = BTreeMap::new();
    for h in cwd_hits {
        by_id.insert(h.id.clone(), h);
    }
    for h in personal_hits {
        by_id.entry(h.id.clone()).or_insert(h);
    }

    // Collect, sort by score descending then id ascending, truncate.
    let mut fused: Vec<RecallHit> = by_id.into_values().collect();
    fused.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    fused.truncate(limit);
    Ok(fused)
}
