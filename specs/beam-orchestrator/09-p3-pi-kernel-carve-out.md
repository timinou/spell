# 09 · P3 — pi-kernel carve-out + OwnerId + rustler find + 3 gates

Status: execution spec. Derived from PLAN-334 + a file-verified boundary audit
(2026-06-12). Supersedes the indicative file list in PLAN-334 with verified
ground truth.

> P3 is the **architecture bet**, not error-relief. The execute substrate
> (W0–W4) already killed every live error class over the bridge. P3's unique
> payoff is **WS-B: one warm kernel, N agents** (the code-graph index built once
> per node, shared) + true zero-copy handles (N-3) + fleet-wide lock-liveness.
> A green P3 means the kernel is **extracted**, not merely de-risked (N-1).

---

## Verified ground truth (file-checked, do not re-litigate)

```
GT-1  execute_code_path_inner(opts: CodePathTaskOptions, cancel: CancelToken)
        -> Result<Vec<CodePathChunk>>
      at crates/pi-natives/src/code_path/napi.rs:397.
      The host-neutral orchestrator. NAPI's execute_code_path (napi.rs:389) is a
      thin skin OVER it. rustler will be a SECOND skin over the SAME fn.

GT-2  CodePathTaskOptions (napi.rs:212) has ONLY #[allow(dead_code)] +
      #[derive(Default)] — NO napi derive. Fields: String/Option/serde_json::Value.
      → moves to pi-kernel AS-IS.

GT-3  CancelToken (task.rs:108) struct body = { Option<Instant>, Arc<Flag> } —
      plain Rust. Only CancelToken::new takes napi Unknown/AbortSignal.
      → struct moves to kernel; the napi constructor stays in the skin; each host
        builds the token its own way (Node: from AbortSignal; BEAM: from a flag +
        deadline).

GT-4  CodePathChunk (napi.rs:79) IS #[napi(object)] — the RETURN type is
      napi-coupled. Fields = Vec<NodeRefDto> + Vec<DiagnosticDto> + bool.
      → the kernel must return a PLAIN-Rust twin (KernelChunk { nodes, diagnostics,
        done }); each skin maps twin → its own DTO. This is the one real
        type-refactor in the carve-out.

GT-5  Read/write branch in execute_code_path_inner is CLEAN:
        L405  command=="manage" → buffer/workspace ops      [BRIDGE-only, N-2 excl]
        L499  command=="edit"   → mutation/write path        [BRIDGE-only]
        else                    → READ path (find/slice/sym) [NIF-ELIGIBLE]
      One branch point; no tangle.

GT-6  Scheme dispatch (L951) routes via SchemeRegistry (PLAN-310). Runtime
      (TS-registered) schemes need a ThreadsafeFunction callback; native
      declarative schemes (file/skill/rule/memory/org/...) do NOT. The N-2 read
      lane uses native declarative schemes ONLY → the NIF read lane needs NO
      callback bridge.

GT-7  Read-path statics are share-safe:
        fs_cache.rs:109  FS_CACHE: LazyLock<DashMap>     concurrent-safe
        dialect_registry.rs:51+  *_LEXER: OnceLock<Arc>  read-only-after-init
      The two-kernels RAM hazard is the code-graph INDEX, which N-2 excludes from
      the read lane. ∴ no per-session mutable state in the NIF read path.

GT-8  Isolation primitive EXISTS: pi-code-engine/src/buffer.rs partitions by
      opaque session_id: String — Revision.session_id (L119/225), undo_scoped
      (L245)/redo_scoped (L273), edit_transaction(session_id) (L605), conflict
      detection (L385: entry.session_id != sid). OwnerId = a RENAME of this, not a
      redesign.

GT-9  TWO lock layers (this reshapes gate 3):
        (a) file_lock::with_exclusive_lock(&key, budget, ...) (buffer.rs:652) —
            OS-level, RAII-scoped, auto-released at block end. NOT held across
            calls. NO reclaim needed.
        (b) edit-broker intent/registration (pi-edit-broker/src/conn.rs) —
            session_id-keyed, PERSISTENT across calls, and ALREADY self-reclaiming:
            conn.rs:134 "on disconnect, deregister session + broadcast peer_left";
            record_intent (L225) is TTL'd.
      ∴ gate 3's reclaim hook maps onto the broker's EXISTING deregister-on-
        disconnect. For a BEAM owner: process-monitor death → deregister owner
        (exactly what a socket disconnect does today).
```

---

## The boundary (what moves where)

```
                         pi-code-path  (EXISTS, 21k lines, zero napi/rustler)
                         └─ AST · parser · resolver · dialects · types ·
                            SessionContext · scheme dispatch core
                                    ▲ already host-agnostic — UNCHANGED by P3

  NEW  pi-kernel  ◀── carved from pi-natives ──
    ├─ execute_code_path_inner            (GT-1, moves verbatim)
    ├─ CodePathTaskOptions                (GT-2, moves as-is)
    ├─ CancelToken (struct)               (GT-3, struct only)
    ├─ KernelChunk (NEW plain twin)       (GT-4, replaces CodePathChunk in core)
    ├─ code_resolver/{walker,predicates,mod}  (the read resolver)
    ├─ fs_cache · dialect_registry        (GT-7, share-safe statics)
    └─ the read-path slice of marshal.rs  (nodes→twin, NOT nodes→napi DTO)

  pi-natives  (stays — becomes the NAPI SKIN)
    ├─ execute_code_path (napi entry, GT-1)     → calls pi_kernel::…_inner
    ├─ CodePathChunk #[napi(object)] (GT-4)     → From<KernelChunk>
    ├─ CancelToken::new (napi ctor, GT-3)       → builds kernel CancelToken
    ├─ marshal.rs napi-DTO mappers              → KernelChunk → CodePathChunk
    └─ scheme_callback / runtime_schemes        → runtime (TS) schemes only

  pi-code-engine/src/buffer.rs  (OwnerId rename + reclaim hook, GT-8/9)
    └─ session_id: String → owner: OwnerId  (newtype over String)
       + a reclaim entry point (delegates to broker deregister)

  NEW  beam-side rustler NIF crate + Elixir wrapper
    └─ second skin over pi_kernel::execute_code_path_inner
       + catch_unwind at every boundary (gate 2)
       + ResourceArc owning a BEAM OwnerId, Drop → reclaim hook (gate 3)
```

---

## OwnerId contract

```rust
// in pi-code-engine (or a shared pi-kernel-types crate)
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct OwnerId(pub String);   // newtype over today's session_id string
// Node owner   = the Node session id (unchanged value)
// BEAM owner   = a pid-derived string, e.g. format!("beam:{pid}")
```

Rename surface (mechanical, GT-8): `Revision.session_id`, `undo_scoped(sid)`,
`redo_scoped(sid)`, `edit_transaction(session_id)`, conflict check (L385) — all
`&str`/`String` → `&OwnerId`/`OwnerId`. The string value is unchanged; the type
gains identity so a host can't accidentally cross owners.

Reclaim hook (GT-9): NOT new lock machinery. A `fn reclaim(owner: &OwnerId)` that
delegates to the broker's existing `deregister(owner)` (conn.rs:137). Hosts wire
their teardown to it:
- Node: async-context teardown → reclaim(owner) (already implicit via socket close)
- BEAM: `:erlang.monitor` the owning process; on `:DOWN`, the ResourceArc Drop (or
  the monitor handler) calls reclaim(owner).

---

## The 3 gates (THIS is the acceptance — "find works" is NOT)

```
GATE 1 · CORRECTNESS
  For a corpus of read targets {path, glob, slice, symbol, org-query, memory-search},
  the rustler NIF path returns chunks byte-identical to the NAPI path.
  TEST: a shared corpus run through both skins; assert equal serialized chunks.
  Proves: the extraction preserved behavior; one core, two skins.

GATE 2 · PANIC-SAFETY
  A find that deliberately panics (inject a panic in the resolver under a test flag)
  → the NIF returns {:error, reason} to the BEAM; the BEAM NODE SURVIVES.
  RATIONALE: a NAPI panic kills 1 Node process; a NIF panic kills the WHOLE BEAM
  node. ∴ EVERY NIF boundary MUST std::panic::catch_unwind → {:error}.
  TEST (Elixir): call the panicking find; assert {:error, _} AND the node is still
  alive (a follow-up normal call succeeds in the same VM).
  This is the kill for error class #4 (NIF-panic).

GATE 3 · LOCK-LIVENESS
  A BEAM process acquires edit-intent on a file (broker register + record_intent),
  then is killed mid-op. The monitor fires → reclaim(owner) → broker deregister →
  the intent is freed → a second owner can now acquire it (no permanent deadlock).
  TEST (Elixir): proc A registers + holds intent; kill A; assert proc B's intent on
  the same file is GRANTED within the TTL/monitor window.
  NOTE (GT-9): file_lock is RAII-scoped and needs no reclaim; this gate is about the
  PERSISTENT broker-intent layer, which already self-reclaims on disconnect — P3
  proves the BEAM-monitor path reaches the SAME deregister.
```

## Scheduler classification (NIF must not block the BEAM scheduler)

```
<1ms regular scheduler   parse_code_path · render · small file slices
DirtyCpu                 find-read (walker over a glob), org-query, memory-search,
                         resolve/edit/graph  ← find-read is DirtyCpu (PLAN-334)
must-NOT-NIF             anything spawning an external process (bash/task) — never
                         crosses the NIF; stays bridge-served
```

---

## Build order

```
P3.1  carve pi-kernel (GT-1/2/3/4/7): new crate; move inner + options + cancel
      struct + read resolver + share-safe statics; introduce KernelChunk twin;
      pi-natives re-exports + From<KernelChunk> for CodePathChunk.
      DONE = pi-natives builds green, NAPI behavior unchanged, all existing
      code_path tests pass (the extraction is behavior-preserving).
P3.2  OwnerId rename in pi-code-engine/buffer.rs (GT-8) + reclaim(owner) delegating
      to broker deregister (GT-9). DONE = engine + broker tests green; Node path
      unchanged (OwnerId value == old session_id).
P3.3  rustler NIF crate + Elixir wrapper: second skin over execute_code_path_inner,
      catch_unwind at the boundary, DirtyCpu scheduling for find-read.
      DONE = gate 1 (correctness) green.
P3.4  panic-safety: inject-panic test flag + boundary catch_unwind. DONE = gate 2.
P3.5  lock-liveness: ResourceArc(OwnerId) + monitor → reclaim. DONE = gate 3.
P3.6  N-2 read-lane scoping doc + scheduler classification doc (GT-5/6).
      DONE = the three gates green against the EXTRACTED kernel + docs filed.
```

Deferred to P5 (NOT P3): graph edges + writes cut over to the NIF; the code-graph
index moves wholesale (resolves the two-kernels RAM cost); N-3 HandleStore backing
ETS→ResourceArc (the zero-copy payoff — language semantics unchanged, so it lands
after gates green without touching D-2).

---

## Risk ledger (verified, residual)

```
two-kernels RAM   NOT in P3's read lane (GT-7); the index stays Node-side until P5.
panic blast       gate 2 IS the guard; catch_unwind at every boundary.
second skin tax   rustler DTOs alongside #[napi] — bounded; the core (pi-kernel) is
                  clean, the duplication is only the thin DTO mappers, deleted at P6.
KernelChunk twin  the one real refactor (GT-4); mechanical (From impl), low risk.
scheme callback   read lane uses native declarative schemes (GT-6) → no callback
                  bridge needed in the NIF; runtime schemes stay Node-only.
```
