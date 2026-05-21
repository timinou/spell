//! Integration test: two `view()` handles to the same .uidx file read consistent
//! results in parallel. Models the cross-session shared-index path W3 enables.

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use pi_knowledge_core::vec::{VectorEntry, VectorIndex};
use tempfile::TempDir;

fn build_corpus(dim: usize, n: usize) -> Vec<VectorEntry> {
    // Deterministic synthetic corpus: vector k has 1.0 at dimension (k mod dim).
    (0..n)
        .map(|k| {
            let mut v = vec![0.0f32; dim];
            v[k as usize % dim] = 1.0;
            VectorEntry { node_id: k as u64, vector: v }
        })
        .collect()
}

#[test]
fn two_view_handles_read_same_results() {
    let dim = 32;
    let n = 256;
    let tmp = TempDir::new().unwrap();
    let path: PathBuf = tmp.path().join("vectors.uidx");

    // Writer process: build + save.
    let idx = VectorIndex::from_entries(&build_corpus(dim, n), dim).unwrap();
    idx.save(&path).unwrap();
    drop(idx);

    // Open via view twice (simulates two sessions sharing one .uidx file).
    let view_a = Arc::new(VectorIndex::view(&path).unwrap());
    let view_b = Arc::new(VectorIndex::view(&path).unwrap());

    // Query both in parallel; assert identical top-1 per query.
    let mut handles = Vec::new();
    for k in 0..n {
        let va = view_a.clone();
        let vb = view_b.clone();
        let mut q = vec![0.0f32; dim];
        q[(k as usize) % dim] = 1.0;
        let h = thread::spawn(move || {
            let ha = va.search(&q, 1).unwrap();
            let hb = vb.search(&q, 1).unwrap();
            assert_eq!(ha.len(), 1);
            assert_eq!(hb.len(), 1);
            assert_eq!(ha[0].node_id, hb[0].node_id, "divergent top-1 for query {k}");
        });
        handles.push(h);
    }
    for h in handles { h.join().unwrap(); }
}

#[test]
fn many_concurrent_queries_against_one_view() {
    let dim = 16;
    let n = 128;
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("vectors.uidx");

    let idx = VectorIndex::from_entries(&build_corpus(dim, n), dim).unwrap();
    idx.save(&path).unwrap();

    let view = Arc::new(VectorIndex::view(&path).unwrap());

    let mut handles = Vec::new();
    for k in 0..n {
        let v = view.clone();
        let mut q = vec![0.0f32; dim];
        q[(k as usize) % dim] = 1.0;
        let h = thread::spawn(move || {
            for _ in 0..16 {
                let hits = v.search(&q, 5).unwrap();
                assert!(!hits.is_empty(), "non-empty result for query {k}");
            }
        });
        handles.push(h);
    }
    for h in handles { h.join().unwrap(); }
}

#[test]
fn metadata_consistent_with_size() {
    let dim = 8;
    let n = 50;
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("vectors.uidx");

    let idx = VectorIndex::from_entries(&build_corpus(dim, n), dim).unwrap();
    idx.save(&path).unwrap();

    let (md_dim, md_count) = VectorIndex::metadata(&path).unwrap();
    assert_eq!(md_dim, dim);
    assert_eq!(md_count, n);
}
