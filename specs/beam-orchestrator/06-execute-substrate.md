# Execute Substrate: Handles, Settled Fan-Out, and the Path to NIF Zero-Copy

**Date**: 2026-06-10
**Status**: Decided. This doc freezes the substrate decisions for the `execute`
tool's next growth phase. Build order at the bottom is the commitment.
**Reads with**: `01-vision.md` (destination), `02-v1-compute-coprocessor.md`
(shipped V1), `03-roadmap.md` (P-phases), `05-fup-execute-capability-policy.md`
(policy seams).
**Supersedes**: nothing — extends V1. FEAT-790's "requires a Hex fork" scoping
is resolved by the fork decision here (D-1).

---

## Why this doc exists: the error inventory of substantial use

V1 shipped and got used. Substantial use surfaced a coherent failure class:

```
E1  memory_exceeded (10MB)      tool result materializes FULLY in sandbox heap
                                before the program can project — BUG-426:
                                (tool/org {:command "dashboard"}) OOMs on org
                                bodies the program never asked for
E2  heap ceiling hardcoded      max_n never threaded Node→peer (FEAT-791)
E3  pmap all-or-nothing         collect_parallel_results short-circuits on first
                                element error; 6-way fan-out, #4 fails → ALL lost
                                (FEAT-790)
E4  no try/catch                ptc_runner marks exceptions :not_relevant; any
                                mid-program error discards completed work — and
                                completed WRITES already happened (partial effects)
E5  exits code=1 at boot        beam deps not compiled (install.sh now handles)
E6  hallucinated builtins       map-vals / dedupe-by / (tool/call …) don't exist;
                                each discovery costs a full effectful round-trip
E7  nil-poisoning               (:items r) on string-keyed results → silent nil
E8  size/backpressure/abort/    PLAN-322..325 — SHIPPED
    concurrency ceilings
```

**Keystone insight**: E1/E2 are not config bugs. They are symptoms of
**copy-in-everything semantics** — every tool result is fully hydrated into the
sandbox heap whether the program needs 3 fields or 38MB of org bodies. Raising
`max_n` treats the symptom; leaning one DTO (BUG-426) fixes one violator. The
substrate fix is to change *what a tool result is* inside the sandbox.

---

## The decisions (D-1 … D-7)

### D-1 · Vendor-fork ptc_runner (`beam/ptc_runner-vendored/` + `SPELL_PATCHES.md`)

Precedent: `crates/brush-core-vendored/SPELL_PATCHES.md`. We own the eval layer.

Why fork now instead of host-fn shims (`h/get`, `h/settled` in the tools map):

```
shim   ✓ no fork, fast            ✗ two-world vocabulary (h/get vs get) that every
                                    interim program learns and we then delete;
                                    migration cost grows with adoption
fork   ✓ polymorphic builtins —   ✗ ~week+ to first ship; dep ownership
         get/count/take/filter/
         group-by work on handles
         AND plain values; psettled
         and lint hooks land in
         eval.ex directly
```

User decision: **fork**. The deciding argument: `execute` is intended to become
the *primary* tool-call lane (D-3). A primary lane cannot carry a bolted-on
`h/*` namespace as permanent vocabulary — the mental model must be "the normal
builtins, and big values just work."

Rules (mirroring brush-core-vendored):
- `beam/ptc_runner-vendored/` replaces the Hex dep in `mix.exs` (path dep).
- Every divergence documented in `SPELL_PATCHES.md` with rationale + upstream
  disposition (`upstreamable` | `spell-specific`).
- Patches kept minimal and surgical; upstream merges rebased in deliberately.
- The shim designs in this doc's history (h/settled as Node allSettled) become
  the **spec for the fork patches**, not shipped interim code.

### D-2 · Polymorphic handles — values over a threshold never enter sandbox heap

The value model:

```
tool result ≤ threshold (~256KB)  → plain Erlang terms in sandbox heap (today)
tool result >  threshold          → parked in a Peer-owned store; the sandbox
                                    receives an opaque handle:
                                    {:ptc/handle "h-17"
                                     :meta {:bytes 4194304 :keys ["items" …]}}
```

Core builtins (`get`, `get-in`, `count`, `take`, `drop`, `select-keys`,
`filter`, `map`, `group-by`, `sort-by`, `frequencies`, `update-vals`, …) are
made **handle-aware in the forked eval layer**: applied to a handle, the
operation executes host-side over the stored term and returns either another
handle (still big) or a materialized slice (now small). Heap accounting (`max_n`)
charges **only materialized slices** — you pay for what you compute on, not what
a tool happened to return.

```clojure
(let [dash (tool/org {:command "dashboard"})]      ; 38MB term → handle, 0 sandbox bytes
  {:doing (count (get dash "inProgress"))           ; runs host-side → one int
   :top   (take 5 (map #(select-keys % ["id" "title"])
                       (get dash "inProgress")))})  ; 5 tiny maps materialize
;; sandbox heap: 1 int + 5 maps. The E1 error class is structurally impossible.
```

This is predicate pushdown: sandbox = query planner, Peer = storage engine.

Mental-burden answer (the user's explicit question): polymorphism means there is
**no new vocabulary** — a program that works on a plain map works on a handle.
The only observable differences: (a) printing a handle shows its `:meta`, not
the value; (b) returning a raw handle from the program triggers the existing
PLAN-325 artifact handoff path (full value → artifact://, preview inline).
`(:meta h)` / shape-on-print keeps the author oriented.

Backing store is **two-phase by design** (this is what makes parallel W2/P3 safe):

```
phase 1 (bridge)   ETS table owned by the Peer, per-execute lifetime
                   (+ session lifetime for bindings, D-6)
phase 2 (NIF)      ResourceArc — the term stays in RUST memory; projections are
                   NIF calls; bytes copied exactly once at final materialization
```

The eval-layer contract (`HandleStore` behaviour: `put/get/project/drop`) is
backing-agnostic. Phase 2 swaps the impl, not the language semantics.

### D-3 · `execute` becomes the sole lane for read/aggregate/write-batch — staged

User intent: "execute ends up being the only way tool calls are performed."
Staged interpretation (decided):

```
execute lane (eventually sole)    find · get · org · memory · edit · create ·
                                  todo_write · status · calc — read, aggregate,
                                  batch-write
stays a direct tool               ask · canvas (interactive) · bash PTY (streaming)
                                  · task/approvals/await (escalation/lifecycle)
```

The existing `DEFAULT_DENYLIST` + effect policy already encode exactly this
boundary — the staging is a *prompt/registration* evolution, not new machinery.
Direct registration of execute-lane tools is retired only after the substrate
(D-1/D-2/D-4/D-5) makes programs strictly better than direct calls. No date;
gated on lived ergonomics.

Non-negotiable consequence: everything in this doc that reduces program-author
friction (polymorphic handles, settled fan-out, preflight lint, cost meter) is
**prerequisite work** for the sole-lane endgame, not nice-to-have.

### D-4 · Settled fan-out (`psettled`) + errors-as-values — in the fork

FEAT-790's analysis stands: `collect_parallel_results` (eval.ex ~L1154)
short-circuits, and no exception primitive exists. With the fork (D-1) the real
fix is in reach:

```clojure
(psettled (fn [f] (tool/find {:target f})) data/files)
;; → [{:ok {...}} {:err {:tool "find" :reason "…"}} {:ok {...}}]
```

- `psettled` = `pmap` variant whose collector returns per-element
  `{:ok val} | {:err reason}` instead of short-circuiting. `pmap` semantics
  unchanged (back-compat).
- Tiny prelude predicates `ok?` / `err?` / `unwrap-or` make handling ergonomic
  **without** adding exceptions: errors are data, not control flow — preserving
  ptc_runner's no-try philosophy while dissolving E3 and most of E4.
- Upstream disposition: `upstreamable` — the patch is the spec for a PR.

### D-5 · Preflight lint — fail in ~10ms with zero effects

In the Peer, before `PtcRunner.Lisp.run`: parse + unbound-symbol pass against
(builtins ∪ catalog ∪ prelude).

```
error: `map-vals` is not a builtin
  hint: did you mean `update-vals`? (note: thread-FIRST ->, not ->>)
  ran: 0 tool calls, 0 effects
```

- Nearest-neighbor (edit distance) over known symbols for the hint.
- Kills E6's worst property: today a grammar error can land AFTER effectful
  tool calls already ran (partial writes for a typo).
- Shape lint (best-effort, warn not block): keyword-get on a tool-result
  binding → "results are string-keyed" (E7).
- Lint hooks live in the fork's eval entry (`upstreamable` candidate).

### D-6 · Session bindings — REPL-ization

The handle store (D-2) with session lifetime instead of per-execute:

```clojure
;; execute 1:
(bind :hits (tool/find {:target "src/**/*.rs::§line[text~=\"unwrap\"]"}))
;; execute 2 — zero re-fetch, zero re-heap:
(->> bind/hits (group-by #(get % "file")) (update-vals count))
```

- Iteration on aggregation logic becomes cheap pure follow-ups; a failed
  program's completed bindings survive for the fixed re-run.
- Lifecycle: bindings die with the BEAM (session teardown / respawn). They are
  a cache, never durable truth — a respawned runtime re-binds by re-running.
- Namespace `bind/<key>` mirrors the existing `data/<key>` convention.

### D-7 · Cost meter — the substrate teaches its own cost model

Every execute returns in `details`: heap watermark, per-tool-call byte sizes,
op timings. Heap errors name the carrier:

```
memory_exceeded after 3 tool calls
  tool/org dashboard → 38.2MB ← materialized here
  hint: project before group-by, or pass {... :includeBody false}
```

Falls out of D-2's byte accounting nearly free. The agent learns costs from
the substrate instead of from OOMs.

---

## Deferred (decided NOT now)

```
D3-txn   transactional write lane (enlist edits in pi-edit-broker MultiIntent;
         commit on program success). DEFERRED: write programs are rare today.
         Revisit trigger: an agent demonstrably loses partial work. The
         affordance (FEAT-638 MultiIntent/MultiCommit) exists when needed.
         NB: psettled (D-4) + preflight lint (D-5) already remove the two most
         common partial-effect producers.
```

---

## The NIF lane (P3) — decisions that shape it

Context: roadmap P3 proves `find`-as-NIF (correctness, panic-safety,
lock-liveness). Three decisions sharpen its scope:

### N-1 · The kernel split happens AS PART OF P3, not after

P3 is not a toy spike. Its scope includes:

```
· carve a host-agnostic pi-kernel out of pi-natives (napi.rs is already a
  marshalling skin; this makes that boundary a crate boundary)
· OwnerId abstraction in the lock table: owner identity = opaque token
  (Node async-context | BEAM pid), with a reclaim hook the host registers
  (Node: async-context teardown; BEAM: process monitor + ResourceArc Drop)
· rustler skin over the SAME execute_code_path_inner the NAPI uses
· the three gates proven against the REAL core, not a throwaway
```

Slower spike, but it proves the actual architecture. A green P3 means the
extraction is *done*, not merely de-risked.

### N-2 · Interim NIF reads scope to NON-INDEX paths

The two-kernels problem: a NIF kernel in the BEAM is a second process — second
buffer registry, second undo history, and (the big one) a second code-graph
index at ~100s of MB RAM.

Decision: while Node remains the session owner (pre-P5), the NIF lane serves
only paths that need no shared mutable state and no graph index:

```
NIF-served (interim)    file reads/slices · org queries · memory search
bridge-served           graph edges (def→/ref→) · ALL writes · anything
                        touching buffer_registry or undo history
```

Zero index duplication, zero undo-history forking. The cutover of graph +
writes to NIF is P5's job, when the kernel moves wholesale.

### N-3 · D-2 phase 2 = handles become ResourceArc

When NIF reads land, the handle store's backing swaps ETS → ResourceArc: tool
results live in Rust memory; handle-aware builtins project via NIF calls; the
JSON+pipe transfer cost for served paths drops to zero. **The language
semantics (D-2) do not change** — this is why W2 and P3 can run in parallel
without one invalidating the other.

Honest cost ledger for the NIF lane (from the brainstorm, kept):

```
two-kernels      mitigated by N-2 scoping; resolved only at P5
panic blast      NIF panic kills the whole node → every boundary catch_unwind →
                 {:error, …}; P3 gate #2 is the explicit guard
second skin      rustler DTOs alongside 223 #[napi] bindings — bounded (kernel
                 is clean), standing tax until P5/P6 deletes the Node side
marginal win     with D-2 over the bridge, transfer is paid once into the Peer
                 store, never into the sandbox — the heap class dies either way.
                 NIF's unique value = WS-B (one warm kernel, N agents) + true
                 zero-copy; not required to fix today's errors
```

---

## Build order (committed)

```
W0  FEAT-791 max_n plumbing (kdl → execute.ts → client.ts → peer.ex)
    BUG-426 lean dashboard DTO (org_index.rs + types.ts)
    — filed plumbing; do first, independent of the fork

F0  vendor ptc_runner → beam/ptc_runner-vendored/ + SPELL_PATCHES.md
    (path dep in mix.exs; no behavior change; tests green = done)

W1  [fork] psettled + ok?/err?/unwrap-or prelude          (D-4, kills E3/E4-most)
    [fork] preflight lint + nearest-builtin hints          (D-5, kills E6/E7-warn)

W2  [fork] HandleStore behaviour + ETS impl + polymorphic builtins  (D-2, kills E1)
    cost meter in execute details                          (D-7)

W3  session bindings (bind/<key>, session-lifetime store)  (D-6)

P3  ∥ parallel from F0 onward: pi-kernel split + OwnerId + rustler find +
    three gates (N-1); then N-2 read lane; then N-3 ResourceArc backing

W4  stored programs: playbooks with :program blocks; org/memory/canvas
    re-execution — WS-B's compute lane, verbatim (vision doc P4 property)

∞   upstream PRs from SPELL_PATCHES.md (psettled, lint hooks, handle protocol)
```

Acceptance anchors (each wave):

```
W0  tools { execute max-heap-mb=64 } lifts the ceiling; dashboard returns
    body-less refs from inside execute without memory_exceeded
F0  mix test green against the vendored path dep; SPELL_PATCHES.md exists
W1  (psettled f coll) with one failing element returns mixed {:ok}/{:err} list;
    a misspelled builtin fails pre-run with a hint and "0 tool calls" in details
W2  (tool/org {:command "dashboard"}) inside a 10MB-heap execute succeeds via
    handle; details reports per-call bytes + watermark
W3  bind in execute N, read bind/<key> in execute N+1, zero re-fetch
P3  the three gates green against the extracted pi-kernel; lock reclaimed on
    BEAM owner death via the OwnerId reclaim hook
```
