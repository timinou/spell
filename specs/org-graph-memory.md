# Org-Native Graph Memory — Architecture Spec

Cross-session reference for the v1 cutover that turns Spell's org subsystem
into a fully-featured graph with first-class episodic + semantic memory,
hybrid recall, live subscriptions, and atomic cross-file edits — all
without introducing SurrealDB or any external daemon.

This document is the source of truth for vocabulary, file layout, and crate
boundaries. Each PLAN child item is self-contained, but disagreements
between an item and this spec are resolved in favor of this spec.

## Vision

Org files remain the on-disk representation. They stay diffable, editable
in any editor, version-controllable. A native engine layer parses them,
maintains derived indexes (HNSW vectors + Tantivy BM25 + typed-edge graph)
in `~/.cache/spell/recall/<repo-hash>/`, and broadcasts patch events over
the existing `pi-edit-broker` Unix socket so QML/TUI/recall-cache
subscribers see live updates.

Memory becomes first-class org items: episodes (what happened) and concepts
(distilled knowledge) with provenance edges back to source episodes and
sessions. The two-stage SQLite memory pipeline survives as a job queue;
its outputs become typed org items via a new `remember()` op instead of
prose blobs in `MEMORY.md`.

## File layout (per repo)

```
<repo>/.spell/memory/                                 (gitignored)
├── episodes/<YYYY-MM-DD>.org                         level-1 = rollout
│                                                     level-2 = episode
├── concepts/<slug>.org                               one file per concept
└── cache/memory_summary.md                           regenerated projection
                                                      (replaces old MEMORY.md)

~/.spell/personal/                                    cross-repo brain
├── concepts/<slug>.org
├── entities/<kind>/<slug>.org
└── actors/<handle>.org

~/.cache/spell/recall/<repo-hash>/                    derived, regenerable
├── fts/                                              tantivy index dir
└── vec.bin                                           hnswlib-rs dump
```

## Item kinds (`:KIND:` property)

| Kind        | Where                                      | Notes                                            |
|-------------|--------------------------------------------|--------------------------------------------------|
| `episode`   | `<repo>/.spell/memory/episodes/`           | bound to a rollout; ABOUT/INVOLVED/PRODUCED      |
| `concept`   | `<repo>/.spell/memory/concepts/` or personal | distilled; DISTILLED_FROM points at episodes   |
| `playbook`  | `~/.spell/personal/concepts/`              | concept with `:TAGS: playbook`                   |
| `entity`    | `~/.spell/personal/entities/<kind>/`       | domain noun; persona, lead, asset                |
| `actor`     | `~/.spell/personal/actors/`                | founder, agent, system, external                 |
| `session`   | `<repo>/!tasks/sessions/` (existing)       | rollout record; carries CLOCK + tokens           |
| `workflow`  | unchanged                                   | review-policy state machine; ACTION edges        |
| `artifact`  | reserved; FUP                              | tool-log, subagent, export — not v1              |

## Edge kinds (`:RELATIONS:` drawer)

```
:RELATIONS:
INVOLVED:       ACT-founder-sam
ABOUT:          ENT-article-a1b2
ABOUT:          ENT-company-acme
PRODUCED:       ART-tool-log-42
DISTILLED_FROM: EP-01HX7Q...
SUPERSEDES:     CON-cold-outreach-v1
:END:
```

Multiple lines with the same kind = multiple targets (same idiom as
multi-value PROPERTIES). Targets are bare CUSTOM_IDs (no `[[id:…]]` wrap).
Drawer follows `:PROPERTIES:` if both present.

| Edge             | from        | to          | Semantics                                      |
|------------------|-------------|-------------|------------------------------------------------|
| `INVOLVED`       | episode     | actor       | who participated                               |
| `ABOUT`          | episode/cpt | entity      | what it is about                               |
| `PRODUCED`       | episode     | artifact    | what it produced                               |
| `DISTILLED_FROM` | concept     | episode     | provenance for distilled knowledge             |
| `MENTIONS`       | concept     | entity      | concept references entity                      |
| `SUPERSEDES`     | concept     | concept     | newer replaces older (dedupe trail)            |
| `DERIVED_FROM`   | artifact    | artifact    | lineage                                        |
| `BLOCKS`         | task        | task        | DAG; subsumes legacy `BLOCKERS` property       |
| `ACTION`         | workflow    | workflow    | state transition (audit edge)                  |

Legacy `BLOCKERS: a b c` property is read by the parser and surfaced as
`Blocks` edges so existing wave/DAG code keeps working.

## Crates

```
crates/
├── pi-org-engine/                  parse, query, graph, edit (existing; extended)
│   ├── src/buffer.rs               + :RELATIONS: drawer
│   ├── src/item.rs                 + relations: Vec<(EdgeKind, ItemId)>
│   ├── src/graph.rs                + neighborhood / timeline / path / typed edges
│   ├── src/diff.rs                 NEW — OrgItemPatch from before/after item sets
│   └── src/coord.rs                NEW — broker client for org edits
├── pi-code-vectors/                in-process embedder (existing)
│   └── src/index.rs                hnswlib-rs swap (flat code path deleted)
├── pi-embedding-worker/            subprocess embedder (existing)
│   └── src/main.rs                 + JSON-RPC verbs for org concepts
├── pi-edit-broker/                 unix-socket coord (existing; extended)
│   ├── src/protocol.rs             + MultiIntent / MultiCommit / OrgItemPatch on PeerCommitted
│   ├── src/state.rs                + txn tracking
│   └── src/conn.rs                 + handle multi-intent
├── pi-org-recall/                  NEW
│   ├── src/fts.rs                  tantivy BM25 index
│   ├── src/vec.rs                  hnswlib-rs query wrapper
│   ├── src/embedder.rs             pi-embedding-worker client
│   ├── src/recall.rs               hybrid pipeline + RRF fusion
│   └── src/personal.rs             cross-repo store merge
└── pi-natives/
    └── src/org_buffer.rs           + recall / remember / timeline / graph / link / subscribe ops
```

## Hybrid recall pipeline

```
RecallQuery { text?, scope?, focus?, graphHops?, graphKinds?, limit, weights }
  │
  ├─ tantivy.search(text, scope filter)              → bm25_ranked: Vec<NodeId>
  ├─ embed_query(text); hnsw.knn(scope filter)        → vec_ranked:  Vec<NodeId>
  └─ if focus: graph.neighborhood(focus, hops, kinds) → seed_ids:    Vec<NodeId>
                              │
                              ▼
              RRF fuse with weights {bm25: 0.3, vector: 0.5, graph: 0.2}
              RRF(doc) = Σ 1 / (K + rank), K = 60
                              │
                              ▼
                     Vec<RecallHit { id, kind, score, title, excerpt, why }>
```

## New executeOrg ops

| Op           | Input                                                           | Output                          |
|--------------|------------------------------------------------------------------|---------------------------------|
| `recall`     | `RecallQuery`                                                    | `Vec<RecallHit>`                |
| `remember`   | `{ kind, summary, involves[], about[], produced[]?, payload? }`  | `EpisodeRef { id, file }`       |
| `timeline`   | `{ about: ItemId, limit? }`                                      | `Vec<TimelineEntry>`            |
| `graph`      | `{ root: ItemId, hops, kinds? }`                                 | `Subgraph { nodes, edges }`     |
| `link`       | `{ from: ItemId, to: ItemId, kind: EdgeKind }`                   | `Ack { rev }`                   |
| `subscribe`  | `{ query: OrgQlFilter, callback }`                               | `Subscription { id }`           |

`remember` is a transactional op that (a) appends or creates an episode/concept
item, (b) creates relation edges in the same item, (c) optionally writes a
referenced concept item in another file. It uses broker MultiIntent so
multi-file remembers are atomic.

## Live subscriptions

```
executeOrg::editSection
  └─ pi-org-engine::coord
       ├─ broker.intent({ file, codePaths: [item_id], baseRev })
       ├─ apply edit, hash diff, compute OrgItemPatch
       ├─ broker.commit({ file, codePaths, rev, diffHash, orgItems: [...] })
       └─ broker broadcasts PeerCommitted with org_items field
              │
              ▼
       subscribers (QML, TUI agenda, recall cache invalidator)
       receive only when touched_props ∩ query_inputs ≠ ∅
```

`OrgItemPatch { id, kind: "added"|"modified"|"deleted", touched_props: Vec<String>, touched_relations: Vec<EdgeKind> }`.

## Memory pipeline cutover

The `bun:sqlite` job queue in `packages/coding-agent/src/memories/storage.ts`
stays — it's just a queue with claim/lease/heartbeat semantics. What
changes:

- **Stage 1** (per-rollout extract): output schema becomes a list of
  `memory_entries`; each entry calls `remember({ kind: "episode", ... })`,
  producing one level-2 item under today's `<YYYY-MM-DD>.org`.
- **Stage 2** (cross-rollout consolidate): vector cosim ≥ 0.92 dedupe;
  consolidator calls `remember({ kind: "concept", ..., distilled_from: [...] })`
  to write or update concept items in `concepts/<slug>.org`.
- **`MEMORY.md` deletion**: `applyConsolidation` no longer writes
  `MEMORY.md`. The `cleanupConsolidatedArtifacts` path also unlinks any
  pre-existing `MEMORY.md` once.
- **`memory_summary.md` regeneration**: replaced by a deterministic
  projection. New prompt template `prompts/memories/session-start.md.hbs`
  rendered with the result of:
  ```ts
  recall({
    profile: "session-start",
    scope: ["concept"],
    limit: 12,
    weights: { bm25: 0.0, vector: 0.0, graph: 0.0, recency: 0.5, confidence: 0.3, backlinks: 0.2 }
  })
  ```
  plus a small lateral query for active workflow items and last-24h
  episodes about the cwd. Output written to
  `<repo>/.spell/memory/cache/memory_summary.md` (regenerable, gitignored).
  Existing `memory://root/memory_summary.md` URL keeps resolving.

## Atomic cross-file edits

`pi-edit-broker` gains:

```rust
ClientMessage::MultiIntent { txn_id, files: Vec<FileIntent>, ttl_ms }
ClientMessage::MultiCommit  { txn_id, files: Vec<FileCommit> }
ServerMessage::MultiIntentAck { txn_id, granted: bool, conflicts: Vec<...> }
ServerMessage::MultiCommitAck { txn_id, revisions: Vec<(PathBuf, u64)> }
ServerMessage::MultiPeerCommitted { txn_id, files: Vec<PeerCommittedFile> }
```

Stage to `.tmp` paths first; rename all atomically on commit. Crash
recovery: a journal entry per uncommitted MultiIntent in
`pi-code-engine::coord::journal`; on broker restart, replay or rollback.

## Cross-repo personal store

`~/.spell/personal/` is just another org root. The id-resolver in
`pi-org-engine::locate` is extended to span personal + per-cwd; collision
policy: per-cwd shadows personal if the same `CUSTOM_ID` exists in both
(so a repo can override a personal concept). Recall scope unions personal
+ per-cwd by default, configurable via `RecallQuery.includePersonal`.

No namespacing, no daemon, no cross-machine sync. Sync is the user's
responsibility (rsync, git in `~/.spell/personal/.git`, or none).

## What's out of v1

- **Artifact unification + blake3 cutover** → `FUP-1`. v1 keeps the
  existing `artifact://`/`agent://` stores intact. Reserved `:KIND: artifact`
  is unused until the FUP lands.
- **Telegram/QML panel-as-live-query bindings** — broker fires events; UI
  consumers are out of v1.
- **Workflow audit as edges** — `:LOGBOOK:` drawer keeps being the audit
  source. `ACTION` edge kind is reserved for the next iteration.

## Verification (system-level)

`bun check:rs && bun check:ts` clean. The following user-observable
contracts are enforced by the per-FEAT acceptance criteria:

1. Editing an episode in `<repo>/.spell/memory/episodes/2026-05-02.org`
   triggers exactly one `PeerCommitted` event with the changed item's
   `OrgItemPatch`. A subscribed QML panel re-renders without polling.
2. `recall({ text: "auth refactor blockers", limit: 5 })` returns hits
   ranked by RRF fusion of BM25 + vector + graph in < 200 ms on a 10k
   concept index.
3. `remember({ kind: "episode", ... })` that touches two files commits
   atomically; a mid-commit kill leaves no half-applied state.
4. Killing the embedding worker subprocess and restarting recall returns
   correct results within 2 s.
5. `<repo>/.spell/memory/cache/memory_summary.md` deletion + next session
   start regenerates the file from concept queries deterministically.
6. A concept defined in `~/.spell/personal/concepts/cold-outreach.org`
   resolves via `[[id:CON-cold-outreach]]` from any repo.
