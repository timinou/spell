# W1 Review — Real Findings (PLAN-318 commit 61214d7a1)

## Files reviewed
- crates/pi-natives/src/code_path/edge_dispatch.rs (new, 307 LOC)
- crates/pi-natives/src/code_path/napi.rs (edge dispatch wiring + glob-prefix diag filter)
- crates/pi-natives/src/code_path/code_resolver/walker.rs (metadata.line addition + kind_aliases head match)
- crates/pi-code-path/src/parser.rs (parse_query trailing-edge synthesis)
- crates/pi-natives/src/code_graph_cache.rs (already shipped earlier in W1, verified integration with edge_dispatch)
- crates/pi-natives/src/code_path/edge_resolver/mod.rs (consumer — to confirm contract)
- crates/pi-natives/tests/edge_dispatch_e2e.rs + tests/fixtures/edge_target.ts

## Verdict: **blocking**

Edge dispatch compiles and the e2e tests pass, but the wire-level locator
format produced by `edge_dispatch::to_graph_locator` cannot be matched by
`EdgeResolverImpl::find_node_index`. Every symbol-level edge query falls into
the `FileNotFound` branch and returns an empty result with a graph diagnostic.
The smoke tests do not catch this because they only assert
`!chunks.is_empty()`, and the dispatcher always emits one terminal chunk.

## Findings

### F1 [P0 / blocking] absolute-vs-relative path mismatch breaks every symbol edge query
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:194-220 (`to_graph_locator`)
- severity: blocking
- evidence chain:
  - `code_resolver::walker.rs:148` sets `locator = file.to_string_lossy()` where
    `file` is the **absolute** path passed in from
    `edge_dispatch::resolve` (built via `root.join(&file_node.locator)`).
  - `to_graph_locator` then builds `format!("{}:{}", abs.display(), line)`
    → absolute `"/abs/.../edge_target.ts:5"`.
  - `pi_code_graph::indexer::indexer.rs:113` inserts every `SymbolNode` and
    `FileNode` with `file = relative_path` / `path = relative_path` (relative
    to the workspace root).
  - `EdgeResolverImpl::find_node_index` (edge_resolver/mod.rs:84-130) tries:
    1. exact `qualified_name` — locator is `file:line`, never a qname → miss.
    2. exact `file.path.to_string_lossy() == locator` — relative vs absolute → miss.
    3. `file.path.ends_with(locator)` — `Path::ends_with` is component-wise;
       a path of "edge_target.ts" cannot end-with "/abs/.../edge_target.ts:5" → miss.
    4. `rsplit_once(':')` → `path_part = "/abs/.../edge_target.ts"`,
       compared against `sym.file.to_string_lossy() = "edge_target.ts"` → miss.
  - Result: `Err(FileNotFound: "node not found for locator: …")` pushed to
    `graph_diagnostics`, `results = []`, function returns a single terminal
    chunk with zero nodes.
- fix: in `to_graph_locator`, strip `root` from `abs` so the formatted locator
  matches the graph's relative form, e.g.
  ```rust
  let rel = abs.strip_prefix(root).unwrap_or(&abs);
  copy.locator = format!("{}:{}", rel.display(), line);
  ```
  (Or, symmetrically, teach `find_node_index` to accept either absolute or
  `<canon_root>/<relative>` locators — but the relative-side fix is local and
  keeps the existing unit tests honest.)

### F2 [P0] e2e harness only smoke-checks chunk presence, hiding F1
- file: crates/pi-natives/tests/edge_dispatch_e2e.rs:41-66
- severity: blocking (gates F1)
- The three `*_returns_chunks_without_error` tests assert
  `!chunks.is_empty()` and explicitly discard `first.nodes.len()` with
  `let _ = ...`. The dispatcher always emits at least one terminal chunk even
  on a fully empty result, so these tests succeed for the broken wire above.
  No test asserts:
  - that `def→` from `compute` surfaces `main` as a referrer (the fixture's
    advertised purpose), or
  - that the first chunk has zero `FileNotFound` diagnostics, or
  - that an explicit `def→§call_expression` returns at least one node of that
    kind.
- fix: extend one test to assert `chunks.iter().any(|c| !c.nodes.is_empty())`
  and another to assert no `file_not_found` diagnostic shows up.

### F3 [P1] Outer `cp.qualifier` is silently dropped on edge results
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:73-75, 78-79
- The comment claims qualifiers "re-anchor on the edge result instead —
  handled below," but nothing in the function reads `cp.qualifier` after the
  prefix CodePath is built. A query like `foo.ts::Bar def→#hover` silently
  loses `#hover`; the user gets bare NodeRefs with no diagnostic explaining
  why. Default symbol query path passes the qualifier into
  `code_resolver.resolve`, so this is an asymmetric regression for users
  switching from `…::Bar#hover` to `…::Bar def→#hover`.
- fix: either (a) apply `cp.qualifier` to each `results[i]` via the per-node
  qualifier pipeline used in the default branch, or (b) emit a `Diagnostic`
  with `variant: UnsupportedOperation` when the qualifier is set so callers
  know the qualifier was ignored.

### F4 [P1] Multi-edge chains silently truncated without diagnostic
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:17-22 (comment) +
  189-194 (`split_at_edge`)
- The doc-comment acknowledges "The first Edge consumes the rest of the
  chain; subsequent combinators after the edge tail step are ignored. FUP if
  needed." For a query like `foo.ts::Bar def→§call_expression call→`, the
  trailing `call→` is dropped silently — no diagnostic surfaces to the chunk.
  Users will think the resolver chained two edges and produced a real
  zero-result.
- fix: when `cp.query.chain.len() > edge_pos + 1`, push a diagnostic
  (`UnsupportedOperation` or new `Informational`) describing the dropped
  tail steps before returning. Cheap and prevents silent confusion until
  multi-edge is wired.

### F5 [P1] `Locator::Uri(_) + Edge` silently falls through to walker (no-op)
- file: crates/pi-natives/src/code_path/napi.rs:765-779
- The dispatcher only fires when `cp.locator` is `Locator::Fs(_)`. For
  `Locator::Uri(_)` queries with an edge combinator (e.g. user mistakenly
  writes `'memory://something' def→`), execution falls through to the default
  query path. In `walker.rs:382`, `Combinator::Edge(_)` is unhandled and hits
  the `_ => continue` arm — the candidate list ends empty and the user sees
  zero results with no hint that the edge combinator wasn't honoured.
- fix: in the outer `if let Some(edge_pos)` block, when the locator is not
  `Fs`, emit a one-shot diagnostic
  (`"edge combinators require an Fs locator; got <scheme>://"`) and return,
  rather than silently falling through to the walker.

### F6 [P2] Code-resolver errors during prefix resolution are dropped
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:101-107
  ```rust
  Err(_) => { /* silently skip */ }
  ```
- The default symbol path (napi.rs:832-839) attaches the diagnostic to a stub
  file NodeRef so the user can see *why* a file produced no symbols. Edge
  dispatch swallows it. A query that fails to parse one of N files looks
  identical to one that found no matches — which becomes important when
  combined with F1 (everything silently fails).
- fix: mirror the default branch — push a stub NodeRef carrying the
  diagnostic, or extend `graph_diagnostics` with the per-file error.

### F7 [P2] `filter_by_tail_step` Head::Name branch is a silent no-op
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:228-234
- The comment says "best-effort substring", but the branch returns `nodes`
  unfiltered. A query like `foo.ts::Bar def→Caller` (intending "callers
  named Caller") would not filter at all. Either implement the substring
  filter or emit a diagnostic that name-based tail filtering isn't yet
  supported.

### F8 [P2] `metadata.line` derived from declaration node, not name node
- file: crates/pi-natives/src/code_path/code_resolver/walker.rs:151-156
- The walker emits `node.start_position().row + 1` where `node` is whatever
  matched the step head — for `Head::Name`, this is typically the parent
  declaration node (e.g. `function_declaration`), not the identifier the
  name_lexer matched against. pi-code-graph (e.g.
  `pi-code-graph/src/language/typescript.rs:269,291,311`) records
  `name_node.start_position().row + 1`. For declarations that span newlines
  before the name token (decorators, multi-line `export\nfunction foo`,
  `async\nfn foo`, etc.) the two row numbers diverge and the `file:line`
  locator constructed in F1's `to_graph_locator` will miss even after F1 is
  fixed. Single-line declarations happen to coincide, masking the issue in
  the simple fixture.
- fix: find the matched node's `child_by_field_name("name")` (or the dialect
  anchor) and emit the row of that child instead. Falling back to the
  outer node row is fine when the child can't be located.

### F9 [P3] `let _ = gitignore;` comment is misleading
- file: crates/pi-natives/src/code_path/edge_dispatch.rs:135
- The comment claims "FsResolver consumed it via prefix run" but
  `FsResolver::new` (pi-code-path/src/dialects/fs/mod.rs:36) hardcodes
  `WalkOpts { gitignore: true, hidden: true }`; the `gitignore` parameter
  is never used. This matches the (pre-existing) behaviour of the symbol
  branch in napi.rs:820, so not a regression — but the comment is wrong
  and will mislead the next reader. Drop the comment or wire gitignore
  through.

### F10 [P3] Cold-cache build is synchronous + unbounded
- file: crates/pi-natives/src/code_graph_cache.rs:53-65, called from
  edge_dispatch.rs:114-116
- First edge query on a large workspace blocks the napi task while
  `CodeGraphBuilder::build(...)` walks the tree. There is no cancellation
  point between the walker phase and the build call. `pi_token.is_cancelled()`
  is honoured in the start-node loop above and below, but not while the graph
  is building. Not strictly a W1 regression — graph building was previously
  on no hot path at all — but worth a follow-up since `def→` queries now
  trigger it.

### F11 [P3] code_graph_cache check-then-insert is racy under concurrent first-builds
- file: crates/pi-natives/src/code_graph_cache.rs:57-64
- Two concurrent edge queries against the same cold root will both pass the
  `graphs().get(&canon)` miss, both build, and the second insert overwrites
  the first. No safety issue — `DashMap::insert` is atomic, both `Arc`s are
  valid — but it doubles work on the slow path. Trivial fix: use
  `entry(canon).or_try_insert_with(|| ...)`.

## Coverage gaps
1. No e2e test asserts that `def→`/`call→` actually return nodes from the
   graph (F2). One asserting `chunks[0].nodes.len() >= 1` for
   `edge_target.ts::compute def→` would fail today and force F1.
2. No test exercises the `Locator::Uri(_) + Edge` path (F5).
3. No test exercises multi-edge truncation (F4).
4. No test exercises `qualifier + edge` interaction (F3).
5. No unit test for `to_graph_locator` — would have caught the
   absolute-vs-relative path bug immediately.
6. No test exercising the new walker `kind_aliases` fallback against a real
   dialect (walker.rs:446-456); the change is uncovered.

## Confidence
0.92 — F1 reproduced via static trace through walker → to_graph_locator →
find_node_index against indexer-stored relative paths; smoke test
re-confirmed via `cargo test -p pi-natives --test edge_dispatch_e2e`.
The only uncertainty is whether a path-normalisation layer elsewhere
implicitly relativises before `find_node_index` runs — exhaustive grep over
`pi-natives/src/code_path/` and `pi-code-graph/src/` finds none.

---

# W1R-1: Client + Diagnostics (PLAN-319 W1, commit 0ba7261a0)

## Files reviewed
- crates/pi-code-graph/src/semantic/lsp/client.rs (582 LOC)
- crates/pi-code-graph/src/semantic/lsp/diagnostics.rs (42 LOC)
- crates/pi-code-graph/src/semantic/lsp/backend.rs (context only)
- crates/pi-code-graph/src/semantic/mod.rs (type definitions)

## Verdict: correct with two P2 findings

The client is well-structured. The synchronous-over-threads design is coherent,
the JSON-RPC framing is correct for the LSP base protocol, and the Drop impl
has no deadlock potential. Two findings below; neither blocks merge.

## Findings

### F1 [P2] Orphaned pending entries on parameter serialization failure
- file: crates/pi-code-graph/src/semantic/lsp/client.rs:205-215
- severity: P2
- `request()` inserts `tx` into `self.pending` (line 209) *before* the
  fallible `serde_json::to_value(params)` call (line 213). If parameter
  serialization fails, `?` returns early with `LspClientError::Serde`, but
  the `mpsc::Sender` remains in the `pending` HashMap.
- The request was never written to the pipe, so the reader thread will never
  receive a matching response → entry is permanently orphaned. Accumulates
  with each serialization failure.
- Standard `lsp-types` params always serialize successfully, but the trait
  bound `R::Params: Serialize` admits custom types — maps with non-string
  keys cause `serde_json::to_value` to fail.
- fix: move the `pending.insert()` call to after serialization succeeds, or
  add a `self.pending.lock().unwrap().remove(&id);` on the error path:

```suggestion
    let body = serde_json::to_value(JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method: R::METHOD,
        params: serde_json::to_value(params)
            .map_err(|e| LspClientError::Serde(e.to_string()))?,
    })
    .map_err(|e| LspClientError::Serde(e.to_string()))?;
    // Insert only after serialization succeeds:
    let (tx, rx) = mpsc::channel();
    self.pending.lock().unwrap().insert(id, tx);
    self.write_frame(&body)?;
```

### F2 [P2] Missing Content-Length bound in read_frame allows OOM allocation
- file: crates/pi-code-graph/src/semantic/lsp/client.rs:393-395
- severity: P2
- `read_frame` parses `Content-Length: N` and unconditionally allocates
  `vec![0u8; len]` with no upper bound. A buggy or malicious LSP server
  sending `Content-Length: 18446744073709551615` causes either the OOM
  killer to terminate the process or a panic from allocation failure.
- The LSP spec does not define a maximum frame size, but realistic payloads
  are bounded (~1 MB for hover, ~10 MB for large workspace/symbol results).
- fix: enforce a maximum frame size (e.g., 10 MB):

```suggestion
    const MAX_FRAME_SIZE: usize = 10 * 1024 * 1024;
    let len = content_length
        .ok_or_else(|| ReadFrameError::Protocol("missing Content-Length".into()))?;
    if len > MAX_FRAME_SIZE {
        return Err(ReadFrameError::Protocol(
            format!("Content-Length {len} exceeds maximum {MAX_FRAME_SIZE}")
        ));
    }
    let mut buf = vec![0u8; len];
```

## Scrutiny points — verified correct

|#|Question|Verdict|Why|
|---|---|---|---|
|1|read_frame CRLF handling|✓ correct|`read_line` + `trim_end_matches(['\r', '\n'])` handles CRLF and bare LF. Missing Content-Length returns Protocol error (not silent).|
|2|Reader thread termination|✓ correct|`Eof` and `Io` errors both break the loop; thread joins cleanly. Orphaned pending entries are resolved by recv_timeout on the request side.|
|3|Timeout orphans in pending|✓ bounded|Response eventually arrives → reader removes entry. Only permanently orphaned if reader thread dies before response (rare, bounded to inflight requests at crash time). F1 addresses the serialization-failure variant.|
|4|write_frame stdin Mutex blocking|✓ intentional|Serialized writes prevent frame interleaving on the pipe. Correct for synchronous client.|
|5|shutdown() response type|✓ correct|lsp-types 0.95.1: `Shutdown::Result = ()`. `serde_json::from_value::<()>(Value::Null)` succeeds.|
|6|process_id narrowing|✓ safe|lsp-types 0.95.1 defines `process_id: Option<u32>`, not `Option<i32>`. Matches `std::process::id() -> u32`. No narrowing.|
|7|capabilities() before handshake|✓ impossible|`spawn()` calls `capabilities.set()` before returning `Arc<LspClient>` to caller. No race window.|
|8|Drop deadlock potential|✓ none|Lock order: `shutdown()` acquires `pending`+`stdin` (releases both before recv_timeout block), `Drop` acquires `child` only after shutdown returns. Reader thread acquires `pending`+`diagnostics` only. No cycle.|
|9|stderr eprintln! spam|N/A design|Intentional — forwards server stderr to host process. Chatty servers are noisy, but this is the standard LSP client pattern (cf. rust-analyzer, vscode-languageclient).|
|10|lsp_uri_to_pathbuf fallback|✓ best-effort|`uri::to_file_path()` handles `file://` correctly. Non-`file:` URIs produce non-fs paths — callers should guard but the fallback is explicit.|
|11|path_to_uri(None) for relative|✓ correct|`Url::from_file_path` correctly rejects relative paths per RFC 8089. Caller returns empty Vec — silent no-op is acceptable for a "no diagnostics" answer.|

## Test coverage assessment

Unit tests cover:
- read_frame: basic header, multiple headers, EOF (3 tests)
- value_as_u64: number, string, null (1 test)
- convert_lsp_diagnostics: 1-indexing, source fallback (2 tests)

**Gap**: No test for `read_frame` with:
- Missing Content-Length → Protocol error
- Content-Length with leading/trailing whitespace (e.g., `" 7 "`)
- Content-Length with non-numeric value (e.g., `"abc"`)
- LF-only line endings (`\n\n` instead of `\r\n\r\n`)

These are low-risk — the parsing logic is simple and the happy-path tests validate the framing contract. Integration testing against real LSP servers (planned for W3) would catch wire-format edge cases more effectively than unit tests.

## Confidence
0.88 — the client follows the LSP base protocol correctly. Both findings are defensive-programming gaps, not logic errors. No crash, deadlock, or data-corruption paths found in the request/response cycle. The `Drop` impl is sound. Diagnostics.rs has no bugs (it's a thin wrapper).


---

# W1R-2: Registry + Sync (PLAN-319 W1, commit 0ba7261a0)

## Files reviewed
- crates/pi-code-graph/src/semantic/lsp/registry.rs (276 LOC)
- crates/pi-code-graph/src/semantic/lsp/sync.rs (195 LOC)
- crates/pi-code-graph/src/semantic/lsp/client.rs (context: spawn/drop/capabilities)
- crates/pi-code-graph/src/semantic/lsp/backend.rs (context: derive_capabilities)
- crates/pi-code-graph/src/semantic/lsp/diagnostics.rs (context: path_to_uri)

## Verdict: correct with one P1 and four P2 findings

The P1 key-collision bug means any workspace with subdirectory-based callers
will spawn duplicate LSP processes for the same project. All other issues are
defensive-programming gaps or test coverage gaps; none block merge but all
deserve attention before W2 wiring.

## Findings

### F1 [P1] get_or_spawn uses caller workspace path as key instead of detected root, spawning duplicate LSP processes
- file: crates/pi-code-graph/src/semantic/lsp/registry.rs:127-153
- severity: P1 (blocking for W2 wiring)
- `get_or_spawn` constructs `key = (workspace, server_name)` from the caller's
  raw workspace path (line 127), then calls `spec.detect_root(workspace)` to
  find the actual project root (line 141). The LSP server spawns with
  `root_uri` set to the detected root. However, the slot is inserted (line
  156-162) with the original raw workspace as key, not the detected root.
- Two callers in different subdirectories of the same project (e.g.
  `/proj/lib` and `/proj/src`) both detect the same root (e.g. `/proj` via
  `mix.exs`) but produce different keys → both miss the cache → two separate
  LSP processes are spawned for the same project, each consuming significant
  RAM (rust-analyzer ~500 MB, Expert ~200 MB). At cap=6, a workspace with 3
  subdirectories could spawn 3 copies of the same server.
- No external callers exist yet (W2 work), so this hasn't manifested in
  production — but any W2 wiring that passes per-file workspaces will hit it.
- fix: two options — simplest is to use `workspace_root` (post-detect_root)
  as the key component, which requires reordering: lookup spec and detect root
  before the cache check. Alternatively, keep the raw workspace key but add a
  secondary normalisation map `workspace → root` to avoid the spec lookup on
  cache hit.

```suggestion
    let spec = self.lookup_spec(server_name)
        .ok_or_else(|| LspClientError::SpawnFailed(format!("no spec for {server_name}")))?;
    let workspace_root = spec.detect_root(workspace);
    let key = (workspace_root.clone(), server_name.to_string());
    // Now check cache with root-based key...
```

### F2 [P2] TOCTOU double-spawn race in get_or_spawn wastes LSP process on concurrent miss
- file: crates/pi-code-graph/src/semantic/lsp/registry.rs:127-162
- `get_or_spawn` releases the slots lock between the miss check (line 132-136)
  and the insert (line 154-162). Two concurrent calls for the same key both
  see the miss, both spawn an LSP process, then both insert. The second insert
  overwrites the first `WarmSlot`; the first `Arc<LspClient>` drops, killing
  the first process via `LspClient::drop` (shutdown+kill+wait). Result: wasted
  process spawn and immediate kill. At cap=6 and single-user agent workloads
  the probability is low, but LSP servers are heavyweight.
- fix: hold the slots lock across the miss check and insert, or use an
  `entry().or_insert_with()` pattern that spawns under the lock. Spawn latency
  (~100-500 ms) is tolerable under a registry lock since only cold-path
  callers block.

### F3 [P2] send_change emits didChange without prior didOpen for unknown paths — LSP protocol violation
- file: crates/pi-code-graph/src/semantic/lsp/sync.rs:85-103
- `send_change` uses `versions.entry(path).or_insert(0)` (line 93). If called
  without a prior `send_open` — e.g. if the upstream event stream emits
  `BufferEvent::Changed` before `BufferEvent::Opened` — the version starts at
  0→1 and a `textDocument/didChange` notification is sent for a document the
  server has never seen. The LSP spec (3.17) states that `didChange` must
  reference a document previously opened via `didOpen`. No guard enforces the
  invariant.
- The `send_open` idempotency path (repeat open → downgrade to change) is
  correct, but the inverse (change before open) is unprotected. The upstream
  event source is not yet implemented (W2), so this depends on the contract
  between the event stream and DocumentSync.
- fix: in `send_change`, check `versions.contains_key(path)`; if absent,
  either no-op (silently drop) or auto-issue `send_open` first with an empty
  text to register the document, then proceed with the change. The no-op
  approach is simpler and makes the invariant explicit.

```suggestion
    let mut versions = self.versions.lock().unwrap();
    if !versions.contains_key(path) {
        // No prior didOpen — drop the change to avoid protocol violation.
        return;
    }
    let v = versions.get_mut(path).unwrap();
    *v += 1;
    let version = *v;
    drop(versions);
```

### F4 [P2] registry_evict_idle_drops_expired_slots test is a no-op — eviction path untested
- file: crates/pi-code-graph/src/semantic/lsp/registry.rs:265-272
- The test `registry_evict_idle_drops_expired_slots` creates an empty registry
  (no slots inserted), asserts `warm_count()==0`, asserts `evict_idle()==0`.
  No slots are inserted, so no eviction occurs. The comment says "We can't
  actually spawn an LSP here" — but eviction doesn't require an LSP process.
- A `#[cfg(test)]` helper to insert mock `WarmSlot` values into `reg.slots`
  (with a known-old `last_accessed`) would let the test verify actual eviction
  and cover `pick_lru_victim`. Both functions currently have zero coverage.
- fix: add a `#[cfg(test)]` constructor or `pub(crate)` visibility for
  `WarmSlot` so tests can populate the slot map directly.

### F5 [P3] WarmSlot.workspace field is written but never read — dead code
- file: crates/pi-code-graph/src/semantic/lsp/registry.rs:88-92
- `WarmSlot.workspace` is set during `get_or_spawn` insertion (line 159:
  `workspace: workspace_root`) but never read anywhere in the codebase. No
  method returns it, no eviction logic uses it, and `WarmSlot` is private.
  Appears vestigial from an earlier design where slots tracked their detected
  root separately. Remove the field or add a read path.

### F6 [P3] DocumentSync::reset() invariant "call only after server restart" is unenforced
- file: crates/pi-code-graph/src/semantic/lsp/sync.rs:131-134
- `reset()` clears all version state without sending `didClose` notifications
  to the LSP server. The doc comment says "call on server restart" — correct
  for that case: a restarted server has no open documents. But if `reset()` is
  ever called without a corresponding server restart (e.g. test helper,
  reconnection scenario), the server still tracks the documents as open and
  future `didChange` notifications reference unknown documents.
- fix: rename to `reset_after_restart` or add `debug_assert!` documentation
  to make the contract explicit. No runtime change needed.

### F7 [P2] evict_idle TOCTOU — slot can be removed after concurrent get_or_spawn bumps last_accessed
- file: crates/pi-code-graph/src/semantic/lsp/registry.rs:182-196
- `evict_idle` snapshots stale keys into a `Vec` (line 186-190), then
  iterates and removes (line 192-194). A concurrent `get_or_spawn` can bump
  `last_accessed` on a "stale" slot between the snapshot and removal. The slot
  is removed anyway, forcing a re-spawn on the next access. No resource leak
  (Arc Drop cleans up the killed process), but the user experiences a
  gratuitous re-spawn + re-initialize delay on the next query. Acceptable
  trade-off for TTL eviction — standard LRU-TTL behavior — but the method
  comment should note this as a known race.

## Scrutiny points — verified correct

| # | Question | Verdict | Why |
|---|---|---|---|
| 4 | detect_root with from='/' | ✓ correct | `is_dir() → true`, cursor walks `/` (no markers), `parent()=None`, returns `/`. Bounded. |
| 5 | detect_root from file at root | ✓ correct | `/foo.rs` → `parent()=Some("/")`, same as above. Bounded. |
| 7 | send_open re-open after close | ✓ correct | `send_close` removes from versions map. Next `send_open` sees miss → fresh `didOpen` with version=1. |
| 9 | path_to_uri silently drops non-absolute | ✓ design | Same pattern as `diagnostics.rs::path_to_uri`. Caller contract: only absolute paths. W1R-1 already validated this. |
| 10 | reset() with server restart | ✓ documented | Doc comment says "call on server restart." F6 captures the unenforced invariant. |
| 11 | LRU eviction O(n) iteration | ✓ acceptable | O(n) at cap=6 (6 iterations). trivially fast. Not worth a BTreeMap migration. |
| 12 | install_hint vs install-hint KDL | ✓ forward-ref | W2 work noted. Struct uses underscores; KDL uses hyphens; config layer handles conversion. |

## Coverage gaps
1. `registry_evict_idle_drops_expired_slots` is a no-op — no eviction path tested (F4).
2. `pick_lru_victim` has zero test coverage — only exercised by the no-op test above.
3. `DocumentSync::send_open` idempotency (repeat open → change) is untested.
4. `DocumentSync::send_change` cold-start path (`or_insert(0)`) is untested.
5. No test for `get_or_spawn` with the same workspace+server key twice (cache-hit path).
6. No test for LRU eviction when `slots.len() >= max_warm_servers`.

## Confidence
0.90 — The P1 key collision is provable from static analysis of the key
construction vs. root detection. No external callers of `get_or_spawn` exist
yet (confirmed via grep), so it hasn't manifested. The P2 findings are
defensive gaps, not logic errors — the code is correct for the single-threaded
path. The `evict_idle` and `pick_lru_victim` logic is correct but untested.
