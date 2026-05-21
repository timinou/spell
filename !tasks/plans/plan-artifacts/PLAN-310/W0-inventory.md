# PLAN-310 Wave 0 Inventory — Comprehensive Callsite Map

> Generated: 2026-05-21
> Scope: Every symbol/file touched, deleted, or rewired by PLAN-310.

---

## 1. pi-org-recall crate (W5 — whole crate deleted)

**All 12 files in `crates/pi-org-recall/` are deletion targets.**

### Source files (1,595 LOC)
- `crates/pi-org-recall/src/embedder.rs:1` — `Embedder`, `MockEmbedder`, `which_pi_embedding_worker` — jina-code-v2 embedder wrapper; calls `pi_embedding_worker` binary
- `crates/pi-org-recall/src/error.rs:1` — `Error` enum with `tantivy::TantivyError` variant — error type for the crate
- `crates/pi-org-recall/src/fts.rs:1` — `FtsIndex`, `repo_cache_dir`, `repo_cache_dir_at` — Tantivy-backed full-text index
- `crates/pi-org-recall/src/lib.rs:1` — crate root, re-exports
- `crates/pi-org-recall/src/personal.rs:1` — `DualContext`, `FusionWeights`, `recall_dual` — personal-vs-workspace fusion logic
- `crates/pi-org-recall/src/recall.rs:1` — `RecallQuery`, `RecallContext`, `RecallHit`, `recall`, `rrf`, `extract_excerpt` — hybrid recall orchestrator (BM25 + vector + graph RRF)
- `crates/pi-org-recall/src/vec.rs:1` — `VecIndex` (String-keyed wrapper) — hnsw_rs-backed vector index with upsert support

### Test files (1,399 LOC)
- `crates/pi-org-recall/tests/embedder.rs:1` — `Embedder` integration tests
- `crates/pi-org-recall/tests/fts.rs:1` — `FtsIndex` integration tests
- `crates/pi-org-recall/tests/personal.rs:1` — dual-context / personal recall tests
- `crates/pi-org-recall/tests/recall.rs:1` — end-to-end recall tests
- `crates/pi-org-recall/tests/vec.rs:1` — `VecIndex` integration tests

### Manifest
- `crates/pi-org-recall/Cargo.toml:1` — defines `tantivy = "0.26"` and `pi-code-vectors` dep

---

## 2. Tantivy imports outside pi-org-recall

**None found.** Direct `tantivy` imports exist only inside `crates/pi-org-recall/src/`:
- `crates/pi-org-recall/src/error.rs:7` — `tantivy::TantivyError` → `Error` conversion
- `crates/pi-org-recall/src/error.rs:29` — `impl From<tantivy::TantivyError> for Error`
- `crates/pi-org-recall/src/fts.rs:9` — `use tantivy::{...}` (schema, Index, IndexWriter, etc.)
- `crates/pi-org-recall/src/fts.rs:238` — `Box<dyn tantivy::query::Query>` for scoped search

The only `tantivy` entry in any `Cargo.toml` is:
- `crates/pi-org-recall/Cargo.toml:18` — `tantivy = "0.26"`

---

## 3. FtsIndex

### Definition
- `crates/pi-org-recall/src/fts.rs:71` — `pub struct FtsIndex` — Tantivy index wrapper

### Production callers
- `crates/pi-natives/src/recall_engine.rs:47` — `use pi_org_recall::fts::{FtsIndex, repo_cache_dir, repo_cache_dir_at}`
- `crates/pi-natives/src/recall_engine.rs:256` — `fts: FtsIndex` field on `WarmEngine`
- `crates/pi-natives/src/recall_engine.rs:292` — `fn open_fts(&self) -> Result<FtsIndex, String>`
- `crates/pi-natives/src/recall_engine.rs:294` — `FtsIndex::open_at(...)` / `FtsIndex::open(...)`
- `crates/pi-org-recall/src/recall.rs:10` — `use crate::fts::FtsIndex`
- `crates/pi-org-recall/src/recall.rs:79` — `pub fts: &'a FtsIndex` field on `RecallContext`

### Test-only callers
- `crates/pi-org-recall/tests/fts.rs:1` — integration tests for `FtsIndex`
- `crates/pi-org-recall/tests/personal.rs:14` — `use pi_org_recall::fts::FtsIndex`
- `crates/pi-org-recall/tests/recall.rs:18` — `use pi_org_recall::fts::FtsIndex`

### No TS references found.

---

## 4. VecIndex (pi-org-recall variant)

*Distinct from `pi-code-vectors::VectorIndex` — this is the String-keyed wrapper in `pi-org-recall::vec`.*

### Definition
- `crates/pi-org-recall/src/vec.rs:30` — `pub struct VecIndex` — wrapper around `pi_code_vectors::VectorIndex`

### Production callers
- `crates/pi-natives/src/recall_engine.rs:49` — `use pi_org_recall::vec::VecIndex`
- `crates/pi-natives/src/recall_engine.rs:111` — `VEC_CACHE_FILE` constant for `VecIndex` disk filename
- `crates/pi-natives/src/recall_engine.rs:257` — `vec: VecIndex` field on `WarmEngine`
- `crates/pi-natives/src/recall_engine.rs:346` — disk fast path: bincode + persisted `VecIndex`
- `crates/pi-natives/src/recall_engine.rs:388` — `VecIndex::from_disk(&vec_path)`
- `crates/pi-natives/src/recall_engine.rs:546` — `fn build_vec_index(items: &[OrgItem]) -> VecIndex`
- `crates/pi-natives/src/recall_engine.rs:547` — `VecIndex::new(DIM)`
- `crates/pi-org-recall/src/recall.rs:10` — `use crate::vec::VecIndex`
- `crates/pi-org-recall/src/recall.rs:80` — `pub vec: &'a VecIndex` field on `RecallContext`

### Test-only callers
- `crates/pi-org-recall/tests/vec.rs:1` — integration tests for `VecIndex`
- `crates/pi-org-recall/tests/personal.rs:15` — `use pi_org_recall::vec::VecIndex`
- `crates/pi-org-recall/tests/recall.rs:18` — `use pi_org_recall::vec::VecIndex`

---

## 5. TypedGraph (pi-org-engine)

### Definitions
- `crates/pi-org-engine/src/graph.rs:570` — `pub struct TypedGraphNode`
- `crates/pi-org-engine/src/graph.rs:580` — `pub struct TypedGraph` — HashMap-of-edges graph
- `crates/pi-org-engine/src/graph.rs:608` — `pub fn build_typed_graph(items: &[OrgItem]) -> TypedGraph`
- `crates/pi-org-engine/src/graph.rs:690` — `pub fn neighborhood(...)` — BFS neighborhood traversal
- `crates/pi-org-engine/src/graph.rs:760` — `pub fn timeline(...)` — chronological episode extraction
- `crates/pi-org-engine/src/graph.rs:807` — `pub fn path(...)` — bidirectional shortest path

### Production callers
- `crates/pi-natives/src/recall_engine.rs:42` — `use pi_org_engine::graph::{TypedGraph, build_typed_graph}`
- `crates/pi-natives/src/recall_engine.rs:258` — `graph: TypedGraph` field on `WarmEngine`
- `crates/pi-natives/src/recall_engine.rs:427` — `let graph = build_typed_graph(&items)`
- `crates/pi-natives/src/recall_engine.rs:445` — `let graph = build_typed_graph(&items)`
- `crates/pi-natives/src/recall_engine.rs:1015` — doc comment referencing `TypedGraph` relations
- `crates/pi-org-recall/src/recall.rs:7` — `use pi_org_engine::graph::TypedGraph`
- `crates/pi-org-recall/src/recall.rs:82` — `pub graph: &'a TypedGraph` field on `RecallContext`
- `crates/pi-org-recall/src/recall.rs:170` — `graph: &TypedGraph` parameter on `recall` helper

### Test callers
- `crates/pi-org-engine/tests/graph_typed.rs:11` — imports `TypedGraphNode`, `build_typed_graph`, `neighborhood`, `path`, `timeline`
- `crates/pi-org-recall/tests/personal.rs:51` — `graph: &'a pi_org_engine::graph::TypedGraph`

---

## 6. RecallEngine / RecallEngineHandle / ENGINES

### Definitions (all in `crates/pi-natives/src/recall_engine.rs`)
- `crates/pi-natives/src/recall_engine.rs:78` — doc comment on `ENGINES_CAP`
- `crates/pi-natives/src/recall_engine.rs:84` — `const ENGINES_CAP: usize = 1`
- `crates/pi-natives/src/recall_engine.rs:118` — doc comment on `ENGINES` LRU
- `crates/pi-natives/src/recall_engine.rs:132` — `static ENGINES: OnceLock<Mutex<Vec<LruEntry>>>`
- `crates/pi-natives/src/recall_engine.rs:236` — `pub struct RecallEngineHandle`
- `crates/pi-natives/src/recall_engine.rs:281` — `impl RecallEngineHandle`
- `crates/pi-natives/src/recall_engine.rs:147` — `pub fn get_or_create(...)`
- `crates/pi-natives/src/recall_engine.rs:217` — `pub fn query(...)` — public query API
- `crates/pi-natives/src/recall_engine.rs:224` — `pub fn forget(...)` — cache eviction API

### External callers
- `crates/pi-natives/src/lib.rs:93` — `pub mod recall_engine;`
- `crates/pi-natives/src/org_buffer.rs:781` — doc: "`org recall` command. Thin shim over `pi_natives::recall_engine`"
- `crates/pi-natives/src/org_buffer.rs:835` — `crate::recall_engine::query(&repo_root, query).map_err(org_err)?`

### Tests (in same file)
- `crates/pi-natives/src/recall_engine.rs:96` — `#[cfg(test)]` — module-level tests begin
- `crates/pi-natives/src/recall_engine.rs:666` — `#[cfg(test)]` — production/test boundary; production code ends ~line 665
- Tests cover: fingerprinting, disk fast path, warm restore, TTL eviction, graceful worker fallback, relation drawer preservation

---

## 7. embedding_worker

### Definition
- `crates/pi-natives/src/embedding_worker.rs:1` — `pub(crate) mod` with `embed_query`, `embed_batch`, test env helpers (417 LOC total)

### Production callers
- `crates/pi-natives/src/lib.rs:80` — `pub(crate) mod embedding_worker;`
- `crates/pi-natives/src/recall_engine.rs:22` — doc comment: "Routes embeddings through the production `embedding_worker` subprocess"
- `crates/pi-natives/src/recall_engine.rs:56` — `use crate::embedding_worker`
- `crates/pi-natives/src/recall_engine.rs:559` — `embedding_worker::embed_batch(&refs, None)`
- `crates/pi-natives/src/recall_engine.rs:648` — `embedding_worker::embed_query(text)`
- `crates/pi-natives/src/recall_engine.rs:653` — `embedding_worker::embed_batch(texts, None)`
- `crates/pi-natives/src/code_graph.rs:20` — `use crate::embedding_worker`
- `crates/pi-natives/src/code_graph.rs:239` — `embedding_worker::embed_query(query)` (semantic search query embedding)
- `crates/pi-natives/src/code_graph.rs:362` — `embedding_worker::embed_batch(&texts, None)?` (semantic index build)
- `crates/pi-org-recall/src/embedder.rs:253` — `which_pi_embedding_worker()` — locates the worker binary
- `crates/pi-org-recall/src/embedder.rs:261` — `fn which_pi_embedding_worker() -> Result<PathBuf>`

### Test callers
- `crates/pi-natives/src/recall_engine.rs:743` — `crate::embedding_worker::lock_test_env()`
- `crates/pi-natives/src/code_graph.rs:793` — `crate::embedding_worker::lock_test_env()`
- `crates/pi-natives/src/code_graph.rs:805` — `crate::embedding_worker::reset_for_tests()`
- `crates/pi-natives/src/code_graph.rs:826` — `crate::embedding_worker::reset_for_tests()`
- `crates/pi-natives/src/code_graph.rs:962` — `crate::embedding_worker::lock_test_env()`
- `crates/pi-natives/src/code_graph.rs:969` — `crate::embedding_worker::reset_for_tests()`
- `crates/pi-natives/src/code_graph.rs:997` — `crate::embedding_worker::reset_for_tests()`
- `crates/pi-natives/src/embedding_worker.rs:390` — internal tests for batch/query

---

## 8. pi-code-vectors callers (W2 — crate absorbed into pi-knowledge-core)

**All 5 files in `crates/pi-code-vectors/` are deletion targets.**

### Source files (390 LOC)
- `crates/pi-code-vectors/src/embedding.rs:1` — `CodeEmbedding` — fastembed wrapper for jina-code-v2
- `crates/pi-code-vectors/src/error.rs:1` — error type
- `crates/pi-code-vectors/src/index.rs:1` — `VectorIndex` — hnsw_rs-backed ANN index
- `crates/pi-code-vectors/src/lib.rs:1` — crate root
- `crates/pi-code-vectors/tests/hnsw.rs:1` — `VectorIndex` integration tests

### Cargo.toml dependents
- `crates/pi-code-graph/Cargo.toml:17` — `semantic = ["pi-code-vectors"]` feature gate
- `crates/pi-code-graph/Cargo.toml:36` — `pi-code-vectors = { path = "../pi-code-vectors", optional = true }`
- `crates/pi-embedding-worker/Cargo.toml:17` — `pi-code-vectors = { path = "../pi-code-vectors" }`
- `crates/pi-natives/Cargo.toml:51` — `pi-code-vectors = { path = "../pi-code-vectors" }`
- `crates/pi-org-recall/Cargo.toml:17` — `pi-code-vectors = { path = "../pi-code-vectors" }`

### Code callers (production)
- `crates/pi-natives/src/code_graph.rs:88` — `VectorCacheState::Fresh(pi_code_vectors::PersistedVectorIndex)`
- `crates/pi-natives/src/code_graph.rs:89` — `VectorCacheState::Stale(pi_code_vectors::PersistedVectorIndex)`
- `crates/pi-natives/src/code_graph.rs:245` — `pi_code_vectors::VectorIndex::from_persisted(persisted)`
- `crates/pi-natives/src/code_graph.rs:365` — `pi_code_vectors::VectorIndex::new(entries, dimensions)`
- `crates/pi-natives/src/code_graph.rs:375` — `-> napi::Result<(Vec<pi_code_vectors::VectorEntry>, usize)>`
- `crates/pi-natives/src/code_graph.rs:402` — `pi_code_vectors::VectorEntry { node_index, vector }`
- `crates/pi-natives/src/code_graph.rs:422` — `vectors: &pi_code_vectors::PersistedVectorIndex`
- `crates/pi-natives/src/code_graph.rs:434` — `pi_code_vectors::serialize_index(writer, vectors)`
- `crates/pi-natives/src/code_graph.rs:452` — `pi_code_vectors::deserialize_index(BufReader::new(file))`
- `crates/pi-org-recall/src/vec.rs:17` — `use pi_code_vectors::{VectorEntry, VectorIndex as InnerIndex}`

---

## 9. hnsw_rs imports

### Cargo.toml
- `crates/pi-code-vectors/Cargo.toml:20` — `hnsw_rs = "0.3"`

### Code references
- `crates/pi-code-vectors/src/index.rs:6` — `use hnsw_rs::prelude::*`
- `crates/pi-code-vectors/src/index.rs:30` — doc comment: "In-memory vector index with hnsw_rs-backed approximate nearest neighbor"
- `crates/pi-code-vectors/src/index.rs:62` — doc comment referencing `hnsw_rs::insert_slice`
- `crates/pi-code-vectors/tests/hnsw.rs:1` — doc comment: "Integration tests for the hnsw_rs-backed VectorIndex"
- `crates/pi-code-vectors/tests/hnsw.rs:128` — comment: "In debug mode hnsw_rs graph traversal is slower"
- `crates/pi-org-recall/src/vec.rs:7` — comment: "Duplicate ids trigger an O(n log n) rebuild because `hnsw_rs` has no delete"
- `crates/pi-org-recall/src/vec.rs:53` — comment referencing `hnsw_rs::insert_slice`

---

## 10. fastembed imports

### Cargo.toml
- `crates/pi-code-vectors/Cargo.toml:16` — `fastembed = "5"`

### Code references
- `crates/pi-code-vectors/src/embedding.rs:3` — `use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions}`
- `crates/pi-code-vectors/src/embedding.rs:7` — doc: "Wraps fastembed's `TextEmbedding` for jina-code-v2 model lifecycle"
- `crates/pi-code-vectors/src/embedding.rs:31` — doc: "fastembed handles tokenization and batching internally"

---

## 11. TS-side org subcommands

### Dispatch definitions in `packages/org/src/tool.ts`
- `packages/org/src/tool.ts:1125` — `command: "recall"` — JSON schema for recall subcommand
- `packages/org/src/tool.ts:1151` — `command: "remember"` — JSON schema for remember subcommand
- `packages/org/src/tool.ts:1173` — `command: "timeline"` — JSON schema for timeline subcommand
- `packages/org/src/tool.ts:1190` — `command: "subgraph"` — JSON schema for subgraph subcommand
- `packages/org/src/tool.ts:1209` — `command: "link"` — JSON schema for link subcommand
- `packages/org/src/tool.ts:1232` — description string listing all 5 subcommands (prompt-facing)
- `packages/org/src/tool.ts:1254-1258` — `"recall"`, `"remember"`, `"timeline"`, `"subgraph"`, `"link"` in enum array
- `packages/org/src/tool.ts:1364` — `case "recall":` — dispatch to native recall_engine
- `packages/org/src/tool.ts:1373` — `case "remember":` — dispatch to native recall_engine
- `packages/org/src/tool.ts:1383` — `case "timeline":` — dispatch to native recall_engine
- `packages/org/src/tool.ts:1388` — `case "subgraph":` — dispatch to native recall_engine
- `packages/org/src/tool.ts:1394` — `case "link":` — dispatch to native recall_engine

### Test files
- `packages/org/test/recall.test.ts:1` — Tests for `recall` org command
- `packages/org/test/remember.test.ts:1` — Tests for `remember` org command
- `packages/org/test/timeline.test.ts:1` — Tests for `timeline` org command
- `packages/org/test/subgraph.test.ts:1` — Tests for `subgraph` org command
- `packages/org/test/link.test.ts:1` — Tests for `link` org command

### Prompt references
- `packages/org/src/tool.ts:1232` — description field (prompt): `"recall      Hybrid recall search across tasks and memory\n  remember    Save an episode or concept to memory\n  timeline    Show timeline entries for a target\n  subgraph    Show neighborhood subgraph around a node\n  link        Add a typed edge between two items\n"`

---

## 12. Dead code referenced by the plan

### `renderSessionStartSummary`
- `packages/coding-agent/src/memories/projection.ts:20` — `export async function renderSessionStartSummary(cwd: string): Promise<string>`
  - **Zero non-test callers confirmed.** No imports outside `projection.ts` itself.
  - Only exercised by its own test file:
    - `packages/coding-agent/test/memories/projection.test.ts:13` — dynamic import
    - `packages/coding-agent/test/memories/projection.test.ts:19` — test suite
    - `packages/coding-agent/test/memories/projection.test.ts:57` — direct call
    - `packages/coding-agent/test/memories/projection.test.ts:104-105` — direct calls

### Other recall-adjacent dead code discovered
- `packages/coding-agent/src/memories/projection.ts:17-18` — doc comments describe the function as "Render the session-start memory_summary.md from a recall projection", but the function is unused in production.

---

## 13. memory_summary.md writers

### Writers (code paths that create or overwrite the file)
- `packages/coding-agent/src/memories/projection.ts:50` — `writeFile(path.join(cacheDir, "memory_summary.md"), rendered, "utf8")` — writes cache projection
- `packages/coding-agent/src/memories/index.ts:186` — `const summaryPath = path.join(memoryRoot, "memory_summary.md")` — read path in `loadMemoryFiles`
- `packages/coding-agent/src/memories/index.ts:801` — `await fs.rm(path.join(memoryRoot, "memory_summary.md"), { force: true })` — deletion during reset
- `packages/coding-agent/src/memories/index.ts:929` — `await Bun.write(path.join(memoryRoot, "memory_summary.md"), ...)` — write during consolidation

### Constants / doc references
- `packages/coding-agent/src/internal-urls/memory-protocol.ts:7` — `const DEFAULT_MEMORY_FILE = "memory_summary.md"`
- `packages/coding-agent/src/internal-urls/memory-protocol.ts:68` — doc: "`memory://root/memory_summary.md` - Reads memory_summary.md"
- `packages/coding-agent/src/memories/layout.ts:7` — doc: "cache/memory_summary.md — deterministic projection (replaces MEMORY.md)"
- `packages/coding-agent/src/internal-urls/router.ts:9` — doc referencing `memory://root/memory_summary.md`

### Test references
- `packages/coding-agent/test/memories-runtime.test.ts:218` — reads `memory_summary.md`
- `packages/coding-agent/test/memories-runtime.test.ts:303` — writes legacy summary
- `packages/coding-agent/test/memories-runtime.test.ts:322` — checks deletion
- `packages/coding-agent/test/memories-runtime.test.ts:673` — writes empty file
- `packages/coding-agent/test/memories-runtime.test.ts:686` — reads path
- `packages/coding-agent/test/memories-runtime.test.ts:692` — asserts URL in payload
- `packages/coding-agent/test/memories/instructions.test.ts:23` — writes test summary
- `packages/coding-agent/test/internal-urls/memory-protocol.test.ts:27` — resolves `memory://root/memory_summary.md`
- `packages/coding-agent/test/internal-urls/handler-contract.test.ts:83` — URL contract test
- `packages/coding-agent/test/get.test.ts:837` — writes file for get-tool test
- `packages/coding-agent/test/tools/bash-skill-urls.test.ts:159` — URL resolution test

---

## Summary

| Metric | Value |
|--------|-------|
| **Total unique files touched by PLAN-310** | **41** |
| **Total LOC to delete** | **1,985** |
| **Total LOC to migrate (estimated production)** | **~1,947** |

### Breakdown

**Deletion (1,985 LOC)**
- `crates/pi-org-recall/src/` — 1,595 LOC (7 files: embedder, error, fts, lib, personal, recall, vec)
- `crates/pi-code-vectors/src/` — 390 LOC (4 files: embedding, error, index, lib)

**Migration (~1,947 LOC)**
- `crates/pi-natives/src/recall_engine.rs` — ~665 LOC production (absorbed into pi-knowledge-core)
- `crates/pi-natives/src/embedding_worker.rs` — 417 LOC (retargeted to user-scoped lifecycle in W3)
- `crates/pi-natives/src/code_graph.rs` — ~180 LOC semantic search / vector cache (retargets to unified bge-m3 embedder)
- `crates/pi-org-engine/src/graph.rs` — ~360 LOC TypedGraph + `build_typed_graph` + `neighborhood` / `path` / `timeline` (migrates into knowledge core)
- `crates/pi-natives/src/org_buffer.rs` — ~55 LOC recall shim (rewired to `memory` tool surface in W6)
- `packages/org/src/tool.ts` — ~270 LOC recall/remember/timeline/subgraph/link dispatch (rewired to `memory` tool)

**Tests accompanying deletion targets**
- `crates/pi-org-recall/tests/` — 1,399 LOC
- `crates/pi-code-vectors/tests/` — 281 LOC
- `crates/pi-org-engine/tests/graph_typed.rs` — 304 LOC
- `crates/pi-natives/src/recall_engine.rs` tests — ~542 LOC (lines 666–1207)

**Dead code flagged**
- `packages/coding-agent/src/memories/projection.ts:20` — `renderSessionStartSummary` (38 LOC, zero production callers)
