# Org-Native Graph Memory — Architecture Spec

Cross-session reference for the v1 cutover that turns Spell's org subsystem
into a fully-featured graph with first-class episodic + semantic memory,
hybrid recall, live subscriptions, and atomic cross-file edits — all
without introducing SurrealDB or any external daemon.

This document is the source of truth for vocabulary, file layout, and crate
boundaries. Each PLAN child item is self-contained, but disagreements
between an item and this spec are resolved in favor of this spec.

> **Shipped state (PLAN-310, 2026-05-22).** PLAN-290's v1 design (tantivy +
> hnsw_rs + `pi-org-recall` + `pi-code-vectors`) was retired before it ever
> shipped to users. The shipped substrate is `pi-knowledge-core` — one
> shared crate carrying pure-Rust BM25, `usearch`-backed HNSW (mmap),
> `petgraph` typed graphs, and an `bge-m3` embedder client. The agent
> surface is the `memory` tool (7 actions). See **Shipped state** callouts
> in each section below for the deltas; the unmarked sections (Vision,
> Item kinds, Edge kinds, Memory pipeline cutover, Verification contracts)
> still describe the live system. Items deferred post-W11 live under
> `FUP-088`.

## Vision

Org files remain the on-disk representation. They stay diffable, editable
in any editor, version-controllable. A native engine layer parses them,
maintains derived indexes (HNSW vectors + Tantivy BM25 + typed-edge graph)
in `~/.cache/spell/recall/<repo-hash>/`, and broadcasts patch events over
the existing `pi-edit-broker` Unix socket so QML/TUI/recall-cache
subscribers see live updates.

> **Shipped state.** Same vision; different machinery. Derived indexes live
> in `~/.cache/spell/knowledge/<repo-hash>/` (not `recall/`) and are built
> by `pi-knowledge-core`: pure-Rust BM25 (no Tantivy), `usearch` HNSW
> (mmap-backed, cross-session readable, no `hnsw_rs`), `petgraph` typed
> edges. Live patch broadcast via `pi-edit-broker` remains the design but
> the recall-cache subscriber wiring is part of the W7.4 projection path
> rather than a generic subscription bus.

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

> **Shipped state.** The derived-cache root is
> `~/.cache/spell/knowledge/<repo-hash>/`, schema-stamped via `meta.bin`,
> with `bm25.bin` (bincode `SearchIndex`), `graph.bin` (petgraph),
> `vectors.uidx` (usearch mmap, multi-session readable), and `items.bin`
> (parsed `OrgItem` / `CodeNode` payloads). The personal store lives at
> `~/.cache/spell/knowledge/personal/`; the code-graph lane uses
> `~/.cache/spell/knowledge/code/<hash>/` with the same schema. The
> embedder owns `$XDG_RUNTIME_DIR/spell/embed.sock` plus an `embed.pid`
> flock pidfile. Old `recall/` caches from PLAN-290 are discarded on
> first run by the schema-stamp check (no migration tool, no rollback).

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

> **Shipped state.** The crate map collapsed. `pi-org-recall` and
> `pi-code-vectors` were deleted; one shared crate now serves both code-
> intelligence and org/memory lanes:
>
> ```
> crates/
> ├── pi-knowledge-core/              NEW — single shared retrieval layer
> │   ├── src/bm25.rs                 pure-Rust BTreeMap inverted index (k1=1.5, b=0.75)
> │   ├── src/vec.rs                  usearch HNSW wrapper, mmap-backed .uidx
> │   ├── src/graph.rs                petgraph wrapper: NodeKey, EdgeKind, BFS, path
> │   ├── src/cache.rs                KnowledgeMeta + save_all atomic writer
> │   ├── src/fusion.rs               RRF + lateral signals (recency, backlinks, confidence)
> │   ├── src/ingest.rs               notify-driven incremental indexer
> │   ├── src/embedder.rs             client to user-scoped pi-embedding-worker
> │   └── src/recall.rs               hybrid pipeline (search + dual + recall)
> ├── pi-code-graph/                  consumes pi-knowledge-core
> ├── pi-org-engine/                  consumes pi-knowledge-core (KIND + RELATIONS parsing)
> ├── pi-embedding-worker/            user-scoped daemon mode (XDG socket, flock pidfile, idle exit)
> ├── pi-edit-broker/                 unchanged from PLAN-290 spec
> └── pi-natives/                     dispatches `memory.*` ops via recall_engine
> ```
>
> Retired in PLAN-310:
> `crates/pi-org-recall/`, `crates/pi-code-vectors/`, `tantivy` (8 subcrates),
> `hnsw_rs`. `libpi_natives.so` shrank by ~19 % (−22.8 MB) and the
> `cargo tree -p pi-natives` edge count fell 30 %.

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

> **Shipped state.** Same fusion shape; the lanes are now
> `pi_knowledge_core::bm25::SearchIndex::search` (pure-Rust BM25,
> camelCase/snake_case tokenization, exact-match boost),
> `usearch::Index::search` against the mmap'd `.uidx`, and
> `pi_knowledge_core::graph::neighborhood` over the petgraph typed graph.
> Embeddings come from the user-scoped `pi-embedding-worker` (`bge-m3`,
> 1024-dim, one process per user across all sessions). RRF + lateral
> signals live in `pi_knowledge_core::fusion`; the dual-recall personal
> store union is wired through the schema but **dispatch is deferred to
> FUP-088** — see W9 in the PLAN-310 manifest.

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

> **Shipped state — Memory tool surface.** The `org recall / remember /
> timeline / subgraph / link` subcommands were deleted from
> `packages/org/src/tool.ts` in W5. The agent-facing surface is now the
> top-level **`memory`** tool with 7 actions; `memory://` URIs resolve in
> any prompt:
>
> | action       | does                                                       | key args                                                       |
> |--------------|------------------------------------------------------------|----------------------------------------------------------------|
> | `search`     | hybrid recall (BM25 + vector + graph) over tasks & memory  | `text`, `scope[]`, `focus`, `hops`, `limit`, `profile`, `include_personal`, `scope_personal_only` |
> | `about`      | one node + 1-hop neighbours + distillation lineage         | `id` → `{ node, neighbors[], lineage[] }`                      |
> | `neighbors`  | typed subgraph walk from a focus node                       | `focus` (or `id`), `hops`, `kinds[]`                          |
> | `note`       | append an episode (in-flight observation, day-grouped)     | `text`, `about[]`, `involved[]`                                |
> | `save`       | persist a concept / playbook / decision (distilled)        | `kind`, `title`, `body`, `distilled_from[]`, `relations[]`     |
> | `link`       | add a typed edge between two items                          | `from`, `to`, `kind`                                          |
> | `since`      | diff of memory state since a timestamp                      | `ts` (ISO-8601 or epoch-ms)                                   |
>
> URIs: `memory://search?…`, `memory://item/<id>`, `memory://since/<ts>`,
> `memory://browse`, `memory://root`. The dispatch flows TS → `executeOrg`
> NAPI → `recall_engine` → `pi-knowledge-core`. `memory.note` /
> `memory.save` go through the broker for atomic multi-file writes when a
> relation drawer crosses files.

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

> **Shipped state — producers and deferrals (PLAN-310).**
>
> *Producers wired:* compaction (Stage 2 consolidator calls
> `memory.save kind:concept`), task-completion (org item state → DONE
> with non-trivial work writes a `memory.note` episode), and elective
> (agent invokes `memory.note` / `memory.save` directly).
> `renderSessionStartSummary` is live and writes
> `<repo>/.spell/memory/cache/memory_summary.md` deterministically from
> the recall projection.
>
> *Deferred to FUP-088:*
> - **TUI memory browser** (`/memory` panel, ambient Ctrl-M) — schema is
>   in place; the QML/TUI panel itself is the FUP.
> - **Dual-recall personal store wiring** — `RecallHit.source` and the
>   `include_personal` / `scope_personal_only` flags ship in the schema,
>   but `recall_engine::query` needs to acquire the personal `WarmEngine`
>   and call `recall_dual` instead of `recall`. Loop test T10.10 stays
>   red until that lands.
> - **`:RELATIONS:` drawer round-trip via `cmd_link`** and a few related
>   T10.* loop gaps (T10.3, T10.5, T10.9, T10.11) — see
>   `!tasks/plans/plan-artifacts/PLAN-310/W10-acceptance.md` for the
>   root-cause breakdown.

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
