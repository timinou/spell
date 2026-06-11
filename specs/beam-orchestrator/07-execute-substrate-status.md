# Execute Substrate: Implementation Status & Forward Scope

**Date**: 2026-06-10
**Status**: F0 + W1 + W2 + W3 SHIPPED and reviewer-cleared. P3 (NIF) and W4
(stored programs) scoped below, not started.
**Reads with**: `06-execute-substrate.md` (the decisions this implements);
`beam/ptc_runner-vendored/SPELL_PATCHES.md` (the patch-level divergence ledger).

---

## What shipped

All in the vendored fork (`beam/ptc_runner-vendored/`, a path dep) + the
`ptc_runtime` Peer. Test count grew 23 → **73 tests + 5 properties**, all green
via `cd beam/ptc_runtime && mix test`.

```
F0  vendored ptc_runner 0.11.0 → beam/ptc_runner-vendored + SPELL_PATCHES.md
    · mix.exs rewritten (dev deps dropped), path dep, lock unpinned
    · reviewer: correct (one P3 .gitignore applied)

W1a psettled — settled parallel map (D-4)                    kills E3, most of E4
    · per-element logical failure → {"ok"|"err"} value, batch survives
    · resource kills (heap/timeout/capacity) STILL abort — proven by test
    · ok?/err?/unwrap-or prelude (errors as data, no exceptions)
W1b preflight lint hints (D-5)                               kills E6, warns E7
    · finding: the unbound-var gate ALREADY runs pre-effect (0 tool calls);
      value-add was routing it + validate/2 through the existing hint engine
    · map-vals→update-vals etc. added; SourceAtoms.intern (not String.to_atom)
    · reviewer: 3 fixes (telemetry CaseClause, dead keyword clauses, abort test)

W2a HandleStore offload (D-2)                                kills E1/BUG-426
    · large tool result parked OFF the sandbox heap BEFORE the Peer reply;
      projections run IN the store, return only the slice
    · external_size sizing (counts binaries — the org-body case)
    · DECISIVE test: same program OOMs without offload at 1MB heap, succeeds with
    · reviewer: 3 fixes (take arg-position, closure exec_id leak, bare-string)
W2b cost observability (D-7)                                 handle?/handle-meta
    · inspect a parked value's bytes/shape/keys WITHOUT realizing it
    · HandleStore.stats + Peer offload log line

W3  session bindings (D-6)                                   REPL-ization
    · reuses (def x v)→step.memory; Peer threads memory across executes
    · NO parallel bind/ namespace (one need, one implementation)
    · bound handles re-homed to a persistent session bucket (stay offloaded,
      no compile-OOM, no stale handle)
    · reviewer: 2 fixes (merge-not-replace for concurrency; park large
      computed bindings to not poison later compiles)
```

### Error inventory: final state

```
E1  heap OOM on large tool result    ✓ FIXED  (W2 offload; structural)
E2  heap ceiling hardcoded           ✓ FIXED  (FEAT-791, prior session)
E3  pmap all-or-nothing              ✓ FIXED  (W1 psettled)
E4  no try/catch / partial effects   ◑ MOSTLY (psettled + preflight remove the
                                              two common partial-effect makers;
                                              txn lane D3 still deferred)
E5  boot exit code=1                 ✓ FIXED  (install.sh, prior)
E6  hallucinated builtins            ✓ FIXED  (W1 preflight, 0 effects + hints)
E7  nil-poisoning                    ◑ WARN   (lint warns; not blocked)
E8  size/backpressure/abort/concur   ✓ SHIPPED (PLAN-322..325, prior)
```

### Deferred, with rationale (unchanged from 06)

```
D3  transactional write lane   write programs remain rare; psettled + preflight
                               already removed the common partial-effect makers.
                               Revisit when an agent demonstrably loses partial
                               work. Affordance (edit-broker MultiIntent) exists.
W2  transform-over-handle      map/filter/group-by/reduce over a handle realize
    (map/filter/group-by)      it first. A program projects to a slice (take/
                               select-keys) before transforming. Adding
                               data-described transforms is a clean follow-up,
                               not a prerequisite.
```

---

## P3 — the NIF lane: honest assessment (NOT started)

The roadmap's P3 proves `find`-as-NIF (correctness, panic-safety,
lock-liveness) and is the load-bearing WS-B hypothesis. After shipping W1–W3,
here is the sharpened read:

**The heap-error class is already dead without the NIF.** W2's offload kills E1
over the *existing bridge* — the big term is parked once in the Peer's store and
never crosses to the sandbox. The NIF's marginal win over bridge+handles is one
JSON+pipe round per large result, not a correctness fix. So P3 is no longer
urgent for error relief; its unique value is the WS-B prize (one warm kernel,
N agents) + true zero-copy.

**The W2 store is NIF-ready by construction.** The `HandleStore` contract
(put/project/realize/release/rehome/stats) is backing-agnostic. Phase 2 swaps
its term storage from a BEAM process's map to a Rust `ResourceArc` and
projections become NIF calls — the *language semantics* (handle-aware builtins,
the projection set, session rehoming) do not change. This is exactly the
"W2 surface survives P3" bet from 06 (decision C), now de-risked: the surface
shipped and is stable.

**Unchanged P3 hazards** (from 06, still the gates):
```
two-kernels    Node session kernel vs BEAM NIF kernel. Mitigation N-2 stands:
               interim NIF reads scope to NON-index paths (file/org/memory) so
               there's no graph-index duplication and no undo-history fork.
panic blast    NIF panic kills the whole node → every boundary catch_unwind →
               {:error,…}. P3 gate #2, unproven.
kernel split   pi-kernel carve-out + OwnerId + reclaim hook, AS PART OF P3
               (N-1), not after. Slower spike, proves the real architecture.
```

**Recommendation**: P3 remains worth doing for WS-B, but it is now a
*performance + architecture* spike, not an *error-relief* one. Sequence it
behind any further error-class work (E4 txn lane, E7 hard-block) only if those
prove to matter in lived use; otherwise P3 is the next big rock.

---

## W4 — stored programs: scope (NOT started)

The vision's P4 property: a PTC program is a durable, runnable value. With
W1–W3 shipped, W4 is now a thin integration, not new runtime:

```
memory save kind=playbook with a :program block → a playbook that RUNS
org dashboard / rollup tiles            → stored programs re-executed at a tick
canvas health panels                    → a window re-runs a stored program
```

Each is `execute` (the shipped lane) invoked from a new caller (memory / org /
canvas), with the program text stored as a value. The substrate (offload,
settled fan-out, bindings, lint) makes these *safe to store and re-run* — that
was the prerequisite work. W4 is where the shines-doc examples stop being
documentation and become the project's live instrumentation. It is also the
same capability WS-B's dispatch-policy lane needs (V1 runtime, second caller,
zero rework) — the design promise from `01-vision.md`, now collectable.

**Recommendation**: W4 is the highest *user-visible* payoff and the lowest
*remaining risk* (no new runtime). A strong candidate for the next wave if the
goal is demonstrable value over architectural derisking.

---

## Build-order epilogue

```
SHIPPED   F0 · W1 · W2 · W3   (this session, reviewer-cleared each wave)
NEXT      pick by goal:
          · user-visible value, low risk   → W4 (stored programs)
          · architecture derisk, WS-B      → P3 (NIF spike, N-1 kernel split)
          · error-class completeness       → E4 txn lane (D3), E7 hard-block
∞         upstream PRs from SPELL_PATCHES.md (psettled, lint hooks, handle proto)
```
