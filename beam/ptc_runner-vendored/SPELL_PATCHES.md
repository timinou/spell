# Spell-fork patches to ptc_runner 0.11.0

This file documents the deliberate divergence between `beam/ptc_runner-vendored/`
and upstream `ptc_runner` 0.11.0 (hex / github.com/andreasronge/ptc_runner).
Re-apply these on every upstream rebase. Mirrors the
`crates/brush-core-vendored/SPELL_PATCHES.md` precedent.

Design context: `specs/beam-orchestrator/06-execute-substrate.md` (D-1 fork
decision and the patch roadmap D-2/D-4/D-5).

## PATCH-0 (F0): vendoring scaffold

**Disposition**: spell-specific (not upstreamable).

- `mix.exs` rewritten: dev-only deps dropped (`ptc_viewer` path dep, credo,
  dialyxir, ex_doc, benchee, ex_dna, recon, usage_rules, stream_data), hex
  packaging/docs config dropped, version `0.11.0-spell`. Optional integrations
  (`req`, `req_llm`, `kino`) remain optional and unfetched.
- `lib/mix/` (upstream's mix tasks: ptc.repl, ptc.smoke, ptc.dna, ...) deleted —
  they assume upstream's dev tree and are dead weight as a path dep.
- Upstream `test/` was never shipped in the hex package; the fork's behavior
  is covered by `beam/ptc_runtime/test/` (peer/bridge/robustness suites)
  plus fork-targeted tests added alongside each patch below.

## PATCH-1 (W1, D-4): `psettled` — settled parallel map ✅ LANDED

**Disposition**: upstreamable (PR candidate).

`psettled` is `pmap` with a SETTLED collector: a per-element *logical* failure
(tool error, raised exception, `(fail …)`, `(return …)`) becomes a settled
value instead of aborting the whole run. Successes are `{"ok" => v}`, failures
`{"err" => reason-string}`. `pmap` semantics are unchanged.

Resource-exhaustion kills (per-worker heap cap, shared deadline,
`:parallel_capacity_exceeded`) STILL abort both modes — a program must not be
able to settle past a global safety limit. On a heap/timeout kill the worker
process is dead and cannot settle anyway; the one nested-`ExecutionError`
rescue explicitly re-raises stable resource reasons.

Prelude predicates ship with it — errors as data, no exception primitive:
`ok?`, `err?` (classify settled maps), `unwrap-or` (settled `{"ok"=>v}` → v,
else default).

### Files touched

```
lib/ptc_runner/lisp/eval.ex          — :psettled do_eval clause; shared
                                       eval_parallel_map/4 (pmap+psettled);
                                       parallel_worker_fun/3 + settle_ok/_err
                                       + settled_reason_string +
                                       stable_resource_error?; mode threaded
                                       into collect_runner_results +
                                       parallel_error_type(:psettled)
lib/ptc_runner/lisp/analyze.ex       — dispatch + analyze_psettled/2;
                                       :psettled in the special-form list
lib/ptc_runner/lisp/source_atoms.ex  — psettled in the bounded atom vocab
lib/ptc_runner/lisp.ex               — collect_tool_names +
                                       collect_undefined_vars :psettled clauses
lib/ptc_runner/lisp/core_to_source.ex— format + collect_var_refs :psettled
lib/ptc_runner/lisp/runtime/predicates.ex — ok?/err?/unwrap_or
lib/ptc_runner/lisp/runtime.ex       — defdelegate ok?/err?/unwrap_or
lib/ptc_runner/lisp/env.ex           — register :ok? :err? :"unwrap-or"
priv/functions.exs                   — psettled, ok?, err?, unwrap-or docs
```

Tests: `beam/ptc_runtime/test/psettled_test.exs` (12, direct `Lisp.run`).
Gotcha: group the `:psettled` do_eval clause WITH `:pmap`; keep helpers in the
parallel-helper region — a helper between do_eval clauses trips Elixir's
clause-grouping warning.

Review fixes (W1 reviewer swarm):
- `pmap_call` is tagged `type: :psettled`, so `SubAgent.Loop.emit_pmap_telemetry`'s
  `case` needed a `:psettled -> [:pmap]` clause (it's a pmap variant; emits
  under the established `[:pmap, ...]` event family). Without it a psettled
  program crashed `CaseClauseError` on the SubAgent path (the PR consumer).
- `ok?`/`err?`/`unwrap-or` route key access through `FlexAccess.flex_fetch/2`
  (like `get`/`contains?`), NOT a bare `%{"ok" => _}` pattern: a hand-built
  `{:ok v}` literal is `%LispKeyword{name: "ok"}`-keyed mid-eval (only
  normalized to a binary at final output), so the bare pattern silently
  returned false. psettled's own output is binary-keyed and worked either way;
  the FlexAccess path makes both forms classify identically.
- Added the highest-stakes test: a per-worker heap-cap kill must ABORT a
  psettled run (`:memory_exceeded`), never settle as `{"err"}`.

## PATCH-2 (W1, D-5): preflight lint hints ✅ LANDED

**Disposition**: upstreamable (PR candidate).

Key finding: the unbound-var gate ALREADY runs pre-effect. `execute_program`'s
`compile_fn` does parse → symbol-limit → analyze → `check_undefined_vars` →
`check_undefined_tools` BEFORE any tool executes, so a hallucinated builtin
(`map-vals`) fails with 0 tool calls already. No separate Peer pre-pass is
needed (it would double-parse); the value-add is HINTS.

The rich hint logic (`Helpers.format_closure_error/1`: special-form, known
Clojure-name alternative, hyphen-vs-underscore, jaro-nearest-builtin) existed
but only fired on the *runtime* closure path. This patch routes the
pre-execution gate AND `validate/2` through it:

- `check_undefined_vars` builds per-var hinted messages (single var → one
  rich line; multiple → a bulleted block).
- `validate/2` returns hinted strings instead of bare names.
- Names are resolved to atoms via `SourceAtoms.intern/1` (the bounded-vocab
  interner) — NOT `String.to_atom/1`, which would reopen the atom-table
  growth vuln (#953). Unknown names stay binaries; the jaro path handles them.
- Added high-frequency hallucinations to `@clojure_alternatives` that jaro
  distance misses: `map-vals`→update-vals, `map-keys`→update-keys,
  `dedupe-by`, `group-by-vals`.

### Files touched

```
lib/ptc_runner/lisp.ex               — undefined_vars_message/1 +
                                       undefined_var_hint/1; check_undefined_vars
                                       and validate/2 route through them
lib/ptc_runner/lisp/eval/helpers.ex  — @clojure_alternatives gains the
                                       map-vals/map-keys/dedupe-by/group-by-vals
                                       entries
```

Tests: `beam/ptc_runtime/test/preflight_lint_test.exs` (7 — pre-effect proof
via a tool-call tracker + hint coverage).

## PATCH-3 (W2, D-2): handle-aware builtins ✅ LANDED (navigation/slice subset)

**Disposition**: spell-specific.

A tool result is copied onto the sandbox worker's heap the instant the Peer
replies it (`GenServer.reply`, peer.ex) — that's the E1 / BUG-426 OOM point. A
large result now PARKS in a `HandleStore` process BEFORE the reply; the worker
gets a small `%Handle{}`. Handle-aware builtins run their projection IN the
store process (where the term lives) and copy back ONLY the slice. Heap then
charges the program for what it computes on, never for what a tool returned.

Key correctness point: NOT an ETS handle. `:ets.lookup` copies the whole term
to the caller, re-landing it on the sandbox heap — defeated. Projection must
run where the term lives, so the store is a process and projections are a
`GenServer.call` whose REPLY is the (small) slice.

Sizing uses `:erlang.external_size/1` (serialized bytes), NOT
`:erts_debug.flat_size` — the latter excludes off-heap binary payloads, and an
org dashboard is mostly string bodies, so flat_size would never trip the park
threshold (the exact payload this targets). Threshold 256KB.

Projectable (navigation/slice) builtins this wave: `count get get-in keys vals
select-keys contains? first nth take`. A NON-projectable builtin over a handle
realizes it first (correctness fallback). Transform-over-handle
(`map`/`filter`/`group-by`/`reduce`) is DEFERRED — a program projects to a
slice first. Oversized projection results re-park as nested handles.

GC is exec-scoped: one `release(exec_id)` at execute teardown drops every term
that execute parked. A handle cannot escape its execute — `ensure_encodable`
runs inside the execute proc and a `%Handle{}` is not JSON-encodable, so a raw
handle return fails as an unencodable return rather than leaking a stale ref.

### Files touched

```
NEW lib/ptc_runner/lisp/handle.ex        — %Handle{} struct + describe/meta
NEW lib/ptc_runner/lisp/handle_store.ex  — owner GenServer: put/project/realize/
                                           release, in-store projections, repark
NEW lib/ptc_runner/lisp/handle_ops.ex    — builtin name + args → projection tuple
lib/ptc_runner/lisp/eval/apply.ex        — handle-aware %Builtin{} dispatch +
                                           apply_handle_projection/realize_handle
lib/ptc_runner/lisp/eval/context.ex      — handle_store + exec_id fields
lib/ptc_runner/lisp.ex                   — thread handle_store/exec_id run→eval
(ptc_runtime) lib/ptc_runtime/application.ex — start HandleStore under supervisor
(ptc_runtime) lib/ptc_runtime/peer.ex    — park large results pre-reply
                                           (maybe_park), exec_id in pending,
                                           release bucket on execute_done,
                                           handle_store+exec_id into run_opts
```

W2b cost observability: `handle?` / `handle-meta` builtins read the handle
struct directly (no store roundtrip, no realize — proven under a 1MB heap) so a
program can inspect a parked value's bytes/shape/keys before projecting.
`HandleStore.stats/2` + a Peer log line on execute_done report offloaded bytes.

Review fixes (W2 reviewer swarm):
- [P1] `apply_handle_projection` located the handle positionally (`[handle|_]`),
  which is wrong for seq ops: `(take n h)` puts the handle LAST, so `take`
  crashed `FunctionClauseError`. Now located by `Enum.find(&Handle.handle?/1)`.
- [P2] closure contexts (`eval_closure_args`, `do_execute_closure`) built fresh
  `EvalContext.new` WITHOUT `exec_id`/`handle_store`, so an oversized re-park
  from inside a `(map #(get h %) ks)` closure bucketed under `nil` — a bucket
  `release/1` never sweeps → unbounded cross-execute leak. Both now propagate
  them. (pmap workers were already safe: they struct-UPDATE the ctx.)
- [P2] `maybe_park` excluded bare binaries, so a multi-MB STRING tool result
  (file body / HTML) bypassed offload onto the sandbox heap. Now parks
  binaries too; added a string `take` projection in the store.

Tests: `handle_store_test.exs` (11 unit), `handle_offload_test.exs` (12 e2e):
the DECISIVE control (same program OOMs `:memory_exceeded` without offload at a
1MB heap, succeeds with it), the `take`-handle-last regression, large-string
parking, and the nil-bucket leak guard (asserts the unreleasable bucket stays
empty after an in-closure re-park).

## PATCH-4 (W3, D-6): session bindings ✅ LANDED

**Disposition**: mostly spell-specific (the rehome store op is reusable). The
binding mechanism itself reuses upstream's `def`→memory machinery unchanged.

Key decision: NO parallel `bind/<key>` namespace. ptc_runner already persists
`(def x v)` into `step.memory`, surviving across runs IF the caller threads
memory back. The Peer simply does that threading — `st.memory` seeds each
execute's `:memory` opt; a successful run's `step.memory` is captured back into
session state. One need, one implementation.

Commit rules (all in ptc_runtime peer.ex, not the fork):
- Bindings commit on a SUCCESSFUL run regardless of whether the RETURN encodes
  — bare `(def x v)` returns a non-encodable Var yet must bind.
- A program that ended via `(fail ...)` (return `{:__ptc_fail__, _}` inside the
  `:ok` tuple) does NOT commit — a failed program leaves bindings untouched,
  same as the `{:error, step}` path.
- Capture runs in the serialized GenServer, so concurrent executes can't
  interleave the merge (last-completed wins — fine for a sequential REPL cache).

Handle interaction (the subtle part): a `(def x (tool/big {}))` binds a
%Handle{} whose per-execute store bucket is released at THIS execute's
teardown. Realizing it would (a) lose the D-2 offload benefit and (b) copy a
multi-MB term onto the NEXT execute's bounded compile heap, OOMing the compile
phase. Instead `persist_bindings` RE-HOMES bound handles into a persistent
`@session_bindings` bucket (never released by an execute; swept at BEAM exit)
via the new `HandleStore.rehome/3` — the binding stays a small handle, projects
lazily next execute, keeps the offload benefit. A rebind leaves the prior term
in the session bucket until teardown (bounded session-scoped cost).

### Files touched

```
lib/ptc_runner/lisp/handle_store.ex      — rehome/3 + {:rehome} handler +
                                           drop_from_bucket/3
(ptc_runtime) lib/ptc_runtime/peer.ex    — State.memory; seed :memory per
                                           execute; capture on execute_done
                                           (4-tuple {:execute_done,id,res,mem});
                                           persist_bindings + @session_bindings;
                                           run_program returns {wire, memory};
                                           fail-signal guard
```

Review fixes (W3 + holistic reviewer swarm):
- [P2] Binding capture now MERGES into session memory (`Map.merge(st.memory,
  …)`) instead of replacing it wholesale. Two concurrent executes binding
  DIFFERENT names both survive; a wholesale replace silently dropped the
  earlier non-conflicting binding (executes can overlap — admission ceiling 8).
- [P2] `persist_bindings` now also parks a LARGE non-handle computed binding
  (e.g. `(def x (range 0 200000))` — never a tool result, so offload never saw
  it). Seeded verbatim it would OOM the NEXT execute's smaller bounded compile
  heap (~10MB), poisoning every later execute. Parking it into the session
  bucket keeps the binding a small handle. Same `external_size >= 256KB` gate.

Tests: `session_bindings_test.exs` (9): cross-execute reuse, accumulation,
shadowing, bare-def-still-binds, fail-doesn't-commit, unbound-still-errors, the
merge guard (a binding survives a later different-name commit), the
large-computed-binding park (a def'd 200k-int list doesn't compile-OOM the next
execute), and the handle case (a def'd 400-item dashboard reusable next execute
via rehome — no compile OOM, no stale handle).


## PATCH-5: Session-store reaper (LRU + ceiling)

**Disposition**: spell-specific (eviction policy atop the upstreamable handle protocol).

**Rationale**: The  (PATCH-4) is NEVER released by an execute
teardown — values parked there survive indefinitely. Without a ceiling, a long
session (or W4 unattended re-execution) leaks unbounded heap (each tick parks
every binding again). The reaper adds LRU eviction when the session bucket's
total  exceeds a configurable ceiling.

### Design

- **Last-access timestamps**: a parallel  map () tracks
   per session-bucket term id, updated on
  every project/realize/rehome touch. Exec-bucket terms are NOT tracked — the
   sweep is their GC. A parallel map (not an extended tuple) keeps
  the pattern match on  unchanged everywhere.
- **Eviction**: on / INTO the session bucket, after inserting,
  while total  exceeds the ceiling, the COLDEST session-bucket
  term (min access_ts) is evicted, and the check recurses.
- **Tombstone set**: evicted ids are retained in a bounded MapSet (max 100
  entries, FIFO eviction on overflow) so // of a
  reaped handle returns  — distinguishable from
   (released exec bucket) or never-existed.
- **Ceiling**: default 64 MB. Configurable via  call. The Peer
  sends the operator's  setting (converted from MB
  to bytes at the Node boundary) in the  frame → .
- **Bytes live in the HandleStore** (the session bucket holds all parked
  values).  is only the binding INDEX (small Handle structs).
  When a Handle is evicted, the index entry remains; the next read fails loud
  with the evicted typed error.

### Evicted-read semantics

Reading an evicted session binding fails LOUD on BOTH access paths — there is
no silent degradation (that would be the plausible-but-wrong class the E7
hardening removes):
- projection path (count/get/take over the handle) → `{:error, {:evicted, id}}`
  from `HandleStore.project`, mapped in `apply.ex apply_handle_projection` to the
  runtime error `"binding evicted (session store ceiling); re-run to rebind"`.
- realize path (a NON-projectable builtin like `reverse`/`frequencies` over the
  handle) → `apply.ex realize_handle` RAISES the same `ExecutionError`. (Review
  fix: this clause originally degraded to nil; corrected to raise so both paths
  are loud. Regression test: "a non-projectable builtin over an evicted binding
  fails LOUD".)
- rehome-time (the reaper evicts a handle that `persist_bindings` is about to
  re-home) → `peer.ex persist_bindings` keeps the original handle as a stable
  tombstone (was an unhandled case → CaseClauseError crashing the Peer; review
  fix keeps the binding loud-on-next-read instead of crashing).

The bounded evicted/tombstone set gives a distinguishable `{:evicted, id}` at
the HandleStore boundary, separate from `:stale_handle` (a released exec bucket)
and from a never-existed binding (unbound var).


### Settings plumbing (mirrors FEAT-791 exec-max-heap-mb exactly)



### Files touched



### Tests

beam/ptc_runtime/test/session_store_eviction_test.exs (4):
1. Mass park (~1000 large values at 1MB ceiling) stays bounded
2. Park past ceiling evicts the coldest binding
3. Reading an evicted binding yields a typed error (not stale value, not crash)
4. A hot (repeatedly read) binding survives while cold ones are evicted
## PATCH-6: Strict accessors `get!`/`get-in!` (E7 nil-poison opt-in)

**Disposition**: upstreamable.

**Rationale**: verified that default access (`get`/`get-in`) already resolves
keyword→string keys correctly — `(:items {"items" 5})` => 5. The REAL runtime
poison is a genuinely MISSING key returning `nil`, which collection ops silently
absorb: `(count (:absent m))` → 0, `(map f (:absent m))` → []. Arithmetic
already fails loud (`(+ 1 nil)` → type_error). nil-punning is RELIED UPON across
`priv/functions.exs`, so default access MUST stay nil-returning.

The fix is a NEW opt-in strict accessor, NOT a change to `get`/`get-in`:
- `get!/2` — like `get/2` but fails loud on missing key (uses `flex_fetch` to
distinguish `{:ok, nil}` from `:error`, so a present nil-valued key returns nil).
- `get-in!/2` — like `get-in/2` but fails loud on first absent path segment.

Both register as `{:normal, ...}` (fixed-arity) builtins in env.ex, not
`multi_arity` (no default argument — the point is to fail, not default).

### Files touched

```
lib/ptc_runner/lisp/runtime/map_ops.ex  — get!/2, get_in!/2 + step helpers
lib/ptc_runner/lisp/runtime.ex           — defdelegate get!/2, get_in!/2
lib/ptc_runner/lisp/env.ex               — args_specs + builtin registrations
priv/functions.exs                       — catalog entries (ptc_extension?: true)
(ptc_runtime) test/nil_poison_test.exs   — 8+ tests covering present/absent/
                                           nil-value/back-compat/psettled compose
```

## PATCH-7 (W4, FEAT-810): parse-only `validate` peer method ✅ LANDED

**Disposition**: spell-specific (the Peer protocol method; the underlying
`PtcRunner.Lisp.validate/2` is upstream and unchanged).

Stored programs (W4) need a STORE-time check that a program parses and uses no
unknown builtins/vars, running ZERO tool calls and ZERO effects — so a typo can
never be persisted as a live tile and then fail effectfully on a later re-run.

`PtcRunner.Lisp.validate/2` already does exactly this (parse + Analyze +
`collect_undefined_vars`, with the PATCH-2 "Did you mean" hints, all inside
`Sandbox.run_bounded`). PATCH-7 only EXPOSES it over the Peer protocol:

- `beam/ptc_runtime/lib/ptc_runtime/peer.ex` — new `handle_request("validate",
  id, params, st)` clause: runs `PtcRunner.Lisp.validate(program)` and replies
  `%{"ok" => true}` or `%{"ok" => false, "errors" => [hint, ...]}`. Available
  pre-init (touches no catalog state). Inserted before the method-not-found
  fallback, in the helper region (no clause-grouping warning).

Node side (not in the fork): `client.ts` gains `validate(program)`; `execute.ts`
gains `validateProgram` + `runStored`; the read-only guard + store-time
validation live in `stored-program.ts`. The fork change is solely the Peer
method.

Tests: `packages/coding-agent/src/tools/ptc-runtime/stored-program.test.ts`
(20: read-only guard units + real-BEAM round-trip/validate/signature).

## Upstream rebase procedure

1. Fetch the new hex tarball into a scratch dir.
2. Diff `lib/` against this tree; re-apply PATCH-1..N (each patch lists its
   files when it lands).
3. Re-run `cd beam/ptc_runtime && mix deps.get && mix test`.
4. Update the version suffix in `mix.exs` and this header.
