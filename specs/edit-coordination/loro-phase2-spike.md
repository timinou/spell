# Loro Phase-2 Spike

## Summary

Q: what is this spike deciding?
- whether `loro` should become the phase-2 CRDT substrate for edit coordination, after phase-1 skeleton lands
- whether it replaces the current “journal + conflict surface” plan as the next step, or stays a later optimization

A: narrow read
- phase-1 already establishes the coordination boundary: session attribution, peer visibility, commit journal, structured conflict surfacing
- phase-2 would move from “coordination metadata” to “shared concurrent text state” by introducing Loro as the merge/undo substrate
- this is a design decision about the core edit model, not just a library swap

Context from prior work
- current design explicitly defers concurrent character-level merge and says to revisit it once the coordination skeleton stabilizes
- the research pass found Loro strong on rich-text merge semantics, local undo, export/import sync, and production readiness, but it does not by itself solve structural validation or tree-sitter alignment

## API Mapping

### What maps cleanly

1. `LoroDoc` as document root
- docs: `LoroDoc` is the entry point / main coordinator for containers and versioning
- fit: one document per open buffer, or one doc per file under edit coordination
- use: create, branch/fork, import/export, checkout / history traversal
- source: https://docs.rs/loro/latest/loro/struct.LoroDoc.html
- source: https://loro.dev/docs/tutorial/loro_doc

2. `LoroText` / rich-text container as concurrent text layer
- docs: Loro’s text container models plaintext/richtext and uses Fugue-based merge semantics
- fit: concurrent character-level merges with reduced interleaving anomalies compared with RGA-style approaches
- source: https://docs.rs/loro/
- source: https://loro.dev/blog/loro-richtext
- source: https://www.loro.dev/

3. `UndoManager` for local undo
- docs: UndoManager is for undo/redo from the current peer’s perspective; it tracks only one peer and clears stacks when peer id changes
- fit: session-scoped undo in the agent UI, not global cross-session rollback
- source: https://docs.rs/loro/
- source: https://docs.rs/loro/latest/loro/struct.LoroDoc.html

4. `export` / `import` for sync and branch exchange
- docs: Loro exposes `doc.export(mode)` and `doc.import(bytes)` for snapshot / update exchange
- fit: peer replication, replay, and branch materialization
- source: https://www.loro.dev/docs/tutorial/encoding
- source: https://www.loro.dev/docs/tutorial/sync

5. `checkout` / frontier history for time travel
- docs: Loro supports checkout to frontiers for history review / debugging
- fit: inspect historical states, possibly map to revision snapshots in the engine
- source: https://docs.rs/loro/

### What does not map cleanly

1. tree-sitter structural validity
- Loro can preserve text merge semantics, but it does not understand AST constraints
- current engine still needs parse/re-parse, CodePath validation, and structural edit checks after every materialization
- consequence: Loro must be below tree-sitter, not instead of tree-sitter

2. current `History::Revision` model
- current design stores revision attribution, code paths, parent revision, and peer conflicts at the file/edit transaction layer
- Loro can complement this, but cannot replace the engine’s attribution record if org closeout needs session-level auditability

3. journaled peer activity
- phase-1 design treats the journal as the persistent audit record and the broker as live ring buffer only
- phase-2 can attach Loro operations to that journal, but the journal still matters for restart/replay and non-CRDT consumers

4. existing `edit_transaction` critical section
- phase-1 keeps mutating paths short and lock-bounded
- Loro does not remove the need for disk lock + fresh read + AST re-resolve + write
- it only changes the representation of the in-memory concurrent state

### Candidate API fit inside current stack

- `BufferRegistry`
  - add a CRDT-backed document field per mutable buffer
  - keep the read-only cached path for outline/read/navigate/symbols
  - materialize current rope/bytes from the CRDT state before parse / commit

- `edit_transaction`
  - becomes the synchronization point between current disk state and Loro state
  - read latest file bytes → import/reconcile into Loro → apply edit op → export/materialize → parse/validate → write disk

- `History`
  - can continue as the external revision ledger
  - Loro history can sit behind it as the merge engine, not as the sole source of truth

- `UndoManager`
  - maps well to session-scoped undo/redo in `coding-agent`
  - does not map to global multi-session undo semantics

## Tradeoffs

### Upside

- better concurrent text merge semantics than the current “re-read + re-resolve” approach alone
- reduced interleaving anomalies for human/agent concurrent inserts
- built-in local undo/redo semantics that match session-scoped agent behavior
- export/import primitives align with local-first sync and future branch replay
- production-grade ecosystem signal: docs.rs, official docs, and crates.io availability

### Downside

- extra abstraction layer between intent and materialized file bytes
- Loro solves text convergence, not code validity
- if the engine continues to require tree-sitter + CodePath validation, Loro may become a second state machine unless boundaries are strict
- operational complexity: a CRDT state, a file journal, and disk state can diverge if replay rules are unclear
- history semantics need careful mapping so undo/redo does not cross session boundaries accidentally

### Risk table

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| CRDT overreach | A text CRDT can hide structural corruption until parse time | Keep AST validation after every materialization |
| Dual source of truth | Loro state + journal + disk can drift | Make disk the commit result; journal remains audit/replay; CRDT is derived mutable state |
| Undo ambiguity | Multi-session undo is a footgun | Use Loro UndoManager only for local/session undo |
| API mismatch | Loro APIs fit text, not code nodes | Limit Loro to text layer; keep CodePath and tree-sitter above it |
| Rollout cost | New dependency path across Rust + NAPI + TS | Gate behind phase-2 spike and contract tests before broad use |

## Migration Path

### Phase 0: keep the phase-1 skeleton

- land the coordination skeleton first: session IDs, journal, conflict surface, broker plumbing
- do not replace the phase-1 design with Loro during skeleton stabilization
- reason: the current plan already isolates mutation into a short critical section; that invariant should be proven before introducing CRDT state

### Phase 1: introduce Loro behind the engine boundary

- add a buffer-local Loro document as the concurrent editing substrate
- keep the existing external file commit path intact
- on each mutating transaction:
  - read latest disk bytes under lock
  - reconcile/import into Loro if needed
  - apply the edit intent in Loro
  - materialize to rope/bytes
  - re-parse with tree-sitter
  - validate CodePath target and structural constraints
  - write disk + journal

### Phase 2: map session semantics explicitly

- wire session-scoped `UndoManager`
- preserve per-session attribution in the journal and revision history
- ensure peer edits remain visible as structured conflicts or peer activity, not as hidden merges

### Phase 3: broaden only if tests prove the boundary

- only expand CRDT coverage after proving:
  - no stale write path
  - no cross-session undo leakage
  - no loss of revision attribution
  - no AST validity regressions

### What should not migrate

- do not migrate read-only paths (`outline`, `read`, `navigate`, `symbols`) to CRDT-driven reads
- do not migrate broker/session identity to Loro
- do not replace journaling with CRDT history alone
- do not treat Loro as a substitute for tree-sitter structural validation

## Recommendation (GO/NO-GO/GO-WITH-CONDITIONS)

GO-WITH-CONDITIONS

Rationale:
- Loro is a credible phase-2 candidate for concurrent text merge and session-local undo
- it aligns with the project’s stated need to revisit character-level merge after the coordination skeleton stabilizes
- but the repo’s core invariant is structural correctness of code edits, and Loro does not provide AST-aware safety on its own
- therefore the move is justified only if the integration keeps Loro strictly below tree-sitter/CodePath validation and preserves the existing journal-based audit trail

Decision rule:
- GO if the spike is being used to prototype the text layer under the current coordination stack
- NO-GO if the proposal is to replace the journal + validation path with CRDT-only editing
- GO-WITH-CONDITIONS for the actual repo direction: proceed, but only with explicit boundaries, contract tests, and preserved auditability

## Open Questions

Q1: what is the authoritative source of truth after a successful edit: disk bytes, journal, or Loro state?
- proposed answer: disk bytes remain the commit result; Loro is the merge substrate; journal is audit/replay

Q2: should Loro live per file, per buffer, or per session?
- proposed answer: per mutable file/buffer, keyed by canonical path, with session-scoped undo views

Q3: how are CodePath targets revalidated after CRDT materialization?
- proposed answer: always after materialization, before write, using the existing tree-sitter/CodePath pipeline

Q4: how do we prevent the CRDT from becoming a second hidden history system?
- proposed answer: forbid Loro from being the only history record; keep journal + revision attribution mandatory

Q5: what is the minimal API surface needed from Loro for phase-2?
- proposed answer: document create/import/export, local undo, and branch/materialization support; avoid broader container proliferation until needed

Q6: does Loro add enough value over the current re-read/re-resolve plan to justify the dependency cost?
- proposed answer: yes for concurrent text merge quality and session-local undo; no if the product only needs serialized edits

Q7: how will peer conflicts surface to the agent UI when the underlying merge is CRDT-based?
- proposed answer: keep structured peer activity/conflict panels; surface merges as peer events, not silent success

Q8: what are the rollback semantics if Loro integration regresses structural safety?
- proposed answer: disable the Loro-backed path and fall back to the phase-1 coordination path without changing the on-disk file format

Q9: what test proves the boundary is correct?
- proposed answer: concurrent edits from two sessions to the same region, then assert merged text, preserved CodePath validity, scoped undo, and journal attribution after replay

## URLs referenced

- https://docs.rs/loro/
- https://docs.rs/loro/latest/loro/struct.LoroDoc.html
- https://loro.dev/docs/tutorial/loro_doc
- https://loro.dev/docs/tutorial/encoding
- https://loro.dev/docs/tutorial/sync
- https://loro.dev/blog/loro-richtext
- https://www.loro.dev/
- https://github.com/loro-dev/loro
- https://crates.io/crates/loro
