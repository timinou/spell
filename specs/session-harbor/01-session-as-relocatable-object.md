# Session-as-a-Relocatable-Object: env capsules + deterministic teleport

**Date**: 2026-06-15
**Status**: Brainstorm → vision. A destination to reason toward, derived from a
file-verified audit of five subsystems, NOT a commitment.
**Companions**: `specs/beam-orchestrator/{01-vision,02-v1,06-execute-substrate,09-p3-pi-kernel-carve-out}.md`,
`docs/plans/autonomous-domain-harbor.md`, `docs/session-operations-export-share-fork-resume.md`,
`docs/handoff-generation-pipeline.md`, `docs/spell-server/architecture.md`,
`packages/coding-agent/src/tools/runtime-tools/builtin/*.ptc`.

---

## One sentence

Make a Spell **session a first-class relocatable object** — its conversation
history, its repository delta, and its *isolated runtime environment* sealed into
a single content-addressed **capsule** that can be deterministically suspended on
one machine and resumed on another (laptop ⇄ server), reversibly, the way you
suspend and resume a VM — but **light**: no image, just a manifest + a VCS bundle
+ the session log.

The user's framing — "`.ptc` files that describe isolated envs" + "serialise what
my session has done and hand it to a server while I sleep, then take it back" — is
two halves of one object. This doc names the object and shows it is **mostly
already built**, scattered across subsystems that were designed (independently)
to converge here.

---

## The deeper intention (what this actually is)

Strip the surface and the want is: **decouple a unit of agentic work from the
machine it runs on.** Today a session is welded to a host — the JSONL lives in
`~/.spell`, the uncommitted edits live in a working tree, the ports/db/services
live in the OS, and none of it travels together. "Hand it to a server while I
sleep" is *process migration for agent sessions*: suspend → relocate → resume,
losslessly and deterministically.

Two properties make it more than `scp` + `git push`:

```
ISOLATION     a resumed session must not collide with whatever else runs on the
              target host — its ports, its db, its scratch dir are namespaced and
              derived, so N teleported sessions coexist on one server. This is the
              "light nix env": not Nix-the-package-manager, but Nix-the-IDEA —
              deterministic, reproducible, hermetic-enough env from a description.

DETERMINISM   "given this capsule, any host realizes the SAME environment and the
              SAME repo state." Reproducible-modulo-availability (an honest bound,
              §4). This is what separates a capsule from a tarball: it is VERIFIED,
              content-addressed, and re-realizable, not just copied.
```

∴ the object is a **session capsule**, and the capability is **teleport**
(seal → relocate → resume → seal-back). Everything below serves those two words.

---

## The convergence: what already exists (file-verified, scattered)

The striking finding of the audit: **almost every primitive exists.** The work is
composition + three missing pieces, not green-field.

```
NEED                         ALREADY EXISTS                                  GAP
────                         ──────────────                                  ───
session history (lossless)   JSONL + artifacts dir; fork/resume/switch       travels conversation
                             (session-manager.ts, session-operations doc)    only — NOT env/repo
repo-delta coordination      edit-broker commit coordination; OwnerId        owner can move host
                             (host-agnostic owner: "node-session" | "beam:pid"  (P3 GATE 3 PROVEN)
                             — specs/.../09 GT-8/9, SHIPPED 2026-06-12)       but nothing seals delta
write-scope isolation        sandbox policy {pathsWrite,bashAllow,bashDeny}   policy is WRITTEN but
                             (spell-server/executor/sandbox-writer.ts)        env is never REALIZED
env declaration              domain KDL {surface,tools,env,model}             fragmented across THREE
                             (spell.autonomous.kdl, kdl-domains.ts)           formats; no ports/db/svc
computed tool/env spec        deftool `.ptc` → data (rt-describe strips        format fits env, unused
                             closures) (runtime-tools/builtin/git.ptc)        for env realization
sandbox (compute, no fs/net) PTC-Lisp + capability policy {pure,read,write,   computes plans; never
                             exec,network} (ptc-runtime/policy.ts)            performs host effects
long-lived per-session VM    BEAM runtime, one per session, OwnerId-ready     not the resume target yet
                             (ptc-runtime/spawn.ts, beam/ptc_runtime)
server-side reusable session spell-server: SessionManager + scheduler +       executes GOALS; cannot
                             socket bridge + telegram (spell-server/arch)     yet INGEST a capsule
local⇄server control channel socket bridge registers local CLI sessions,      carries blocking events
                             relays ask/approval (socket/server.ts, types.ts) only — not a capsule ref
prose handoff                /handoff → model-written summary doc             LOSSY by design; wrong
                             (handoff-generation-pipeline.md)                 tool for machine relocation
```

Three real gaps (the actual deliverable, §3): **(1) a unified EnvManifest**,
**(2) an env realizer** (host-side effect performer), **(3) the SessionCapsule +
VcsBackend** that bundles + verifies + transports.

> Design note — handoff vs capsule are DIFFERENT tools, both kept. `/handoff`
> compresses context *for a model* (lossy prose, intra-session). A capsule
> relocates state *for a machine* (lossless, content-addressed, inter-host). Do
> not collapse one into the other; they answer different questions.

---

## The three materials (right material for each layer — a design judgment)

The user's instinct — "use `.ptc` to describe everything" — is **right for the
dynamic layer and wrong for the static one**, and saying so precisely is the
core design call. The BEAM-orchestrator vision already derived the rule (P1–P4,
`01-vision.md`): Lisp-as-data pays *only* when the author is a non-recompiler,
the thing changes faster than deploy, it must be sandboxed, or it must travel as
a value. Apply that rule to env description and it splits cleanly into three:

```
LAYER          MATERIAL   WHY                                              EXAMPLE
─────          ────────   ───                                              ───────
declaration    KDL        static, diffable, human-first, no eval to read   ports {range 0}
  (the env's              — same family as domain/sandbox/server config.    db   "sqlite"
   shape)                 P1–P4 all ✗ → declarative.                        tools { deny … }

computation    `.ptc`     DERIVES the concrete env from a seed             (defn realize [seed]
  (port alloc,            (port = base + hash(seed) % span; db path =        {:port (port-of seed)
   db naming,             scratch/<seed>.db). Deterministic, SANDBOXED,      :db (db-of seed) …})
   svc plan)             agent/operator-authorable. P1✓P2✓P3✓P4✓ → PTC.

relocation     content-   the capsule manifest: hashes, bundle ref, seed.  { id: blake3(…),
  (the token)  addressed  PURE DATA — never eval'd to be read, must verify   repo: {vcs,bundle,hash}
               JSON/KDL   byte-exact. P1–P4 ✗ but P4-as-DATA → not code.     env:  {manifest,seed} }
```

So: **`.ptc` is the computation lane** (it computes the env *plan* as data,
exactly as `deftool` computes a tool spec as data — `rt-describe` already proves
"a `.ptc` evaluates to an inspectable, closure-stripped data spec"). **KDL is the
declaration lane.** **The capsule is data.** A `.ptc` env file is a *program that
evaluates, under a seed, to an EnvManifest* — the dynamic bits (ports, db) are
pure functions of the seed, so the same seed yields the same env on any host.
This is the bridge pattern verbatim: **PTC computes the plan; the host performs
the effects.** The sandbox never binds a port; it only decides *which* port.

---

## Architecture

```
                    ┌──────────────────────── SEAL (suspend) ───────────────────────┐
  laptop session    │                                                                │
  ───────────────   │   1. freeze history     JSONL + artifacts (already on disk)    │
   conversation ────┤   2. seal repo delta    VcsBackend.seal(workdir) → Bundle      │
   working tree ────┤   3. snapshot env       EnvManifest (from env.ptc, realized    │
   isolated env ────┤                          seed recorded) → data                 │
                    │   4. content-address     id = blake3(history ⊕ bundle ⊕ env)    │
                    │   5. emit Capsule        {id, history, repo, env, seed, vcs}    │
                    └───────────────────────────────┬────────────────────────────────┘
                                                     │ transport (socket bridge ext /
                                                     │ object store / scp / git remote)
                    ┌────────────────────────────────▼───────────────────────────────┐
  server (BEAM/     │                          RESUME (on target)                     │
   spell-server)    │   1. verify             recompute id; reject on mismatch        │
                    │   2. realize env        run env.ptc under the RECORDED seed →   │
                    │                          SAME ports/db/dirs; host binds them     │
                    │   3. apply repo delta   VcsBackend.apply(Bundle, fresh workdir)  │
                    │   4. load history       SessionManager.open(history)             │
                    │   5. adopt owner        OwnerId := "beam:<pid>" (or node sess);   │
                    │                          edit-broker lock-liveness already proven │
                    │   6. continue           autonomous domain drives it while asleep; │
                    │                          socket bridge relays ask→Telegram if any │
                    └─────────────────────────────────────────────────────────────────┘
                       (seal-back is the SAME pipeline with laptop/server swapped —
                        the capsule is symmetric; teleport is reversible by construction)
```

### Piece 1 — `EnvManifest` (the unified env descriptor) — NEW, but a merge

One shape that *subsumes* the three formats fragmenting env today (domain KDL +
sandbox JSON + deftool). Declared in KDL/types, optionally **computed by a
`.ptc`** for the dynamic fields.

```
EnvManifest {
  surface     : "none" | "tui" | …          ← from domain KDL (reuse verbatim)
  tools       : { deny[], allow[] }          ← from domain KDL
  model       : { roles{} }                  ← from domain KDL
  write       : { pathsWrite[] }             ← from sandbox policy (reuse)
  bash        : { allow[], deny[] }          ← from sandbox policy (reuse)
  ports       : { base, span, named{} }      ← NEW — the isolation core
  data        : { db, scratch, cache }       ← NEW — derived dirs/db
  services    : [{ name, cmd, healthcheck }] ← NEW — what to (re)start on resume
  seed        : <opaque>                      ← the determinism key (= capsule id)
}
```

The NEW fields (`ports`/`data`/`services`) are the "light nix env." They are the
*only* genuinely new declaration; everything above the line is an existing format
re-homed. A `env.ptc` computes the concrete values:
`(realize seed) → {:ports {:web (+ 4000 (mod (hash seed) 1000))} :db (str "scratch/" seed ".db") …}`.

### Piece 2 — Env realizer (host-side effect performer) — NEW

The bridge's other half: PTC decided *which* port; the host *binds* it. A small
host module (Node now, BEAM Port/OTP later) that takes a realized EnvManifest and:
performs port reservation (deterministic search from the seed-derived base, §4),
creates the db/scratch/cache dirs, starts `services` as supervised children,
writes the sandbox policy file (reusing `sandbox-writer.ts` verbatim), and exposes
teardown for seal. This is the piece `sandbox-writer.ts` *gestures at* (it writes
a policy but realizes nothing) — promote it from "write a JSON" to "realize +
supervise an env."

### Piece 3 — `SessionCapsule` + `VcsBackend` — NEW

```
SessionCapsule {                         VcsBackend (trait — one of):
  id      : blake3(history⊕repo⊕env)        git    : bundle / format-patch + apply
  history : { jsonl_ref, artifacts_ref }    jj     : op snapshot + restore
  repo    : { vcs, bundle_ref, base_rev,    fossil : bundle + apply
              tree_hash }                    rsync  : tar(dirty) + sha256 manifest
  env     : { manifest, seed }              interface:
  meta    : { sealed_at, host, spell_ver }    seal(workdir)        → Bundle
}                                             apply(Bundle, workdir)→ workdir'
                                              verify(Bundle)       → hash
```

VCS pluggability is the user's explicit list (git/jj/fossil/rsync) behind one
seal/apply/verify seam. git is the V1 backend (`git bundle` is already
content-addressed → `tree_hash` falls out free); the rest are backend impls, not
redesigns. The capsule references the backend by name so resume picks the matching
`apply`.

### Piece 4 — transport — EXTEND, don't invent

The socket bridge (`spell-server/src/socket/`) already registers local sessions
and relays blocking events. Add **one** message kind: `capsule_offer {id, ref}` /
`capsule_claim {id}`. The capsule bytes go over an object store / git remote / scp
(big, content-addressed, cacheable); the *control* (offer/claim/sealed/resumed)
goes over the existing bridge. The bridge already proves the laptop⇄server channel
works for ask/approval — teleport is one more message family on a proven wire.

---

## Determinism — the honest bound

True determinism under contention is impossible (two hosts, one free port). The
capsule guarantees **reproducible-modulo-availability**, which is the right and
honest contract:

```
DETERMINISTIC (always)        repo delta (VCS content hash, verified on apply);
                              history (append-only JSONL + content-addressed
                              artifacts, blob-artifact-architecture.md);
                              env SHAPE (the manifest data);
                              the seed→candidate DERIVATION (pure fn of seed).

MODULO-AVAILABILITY           the CONCRETE port/db on the target — the seed gives
                              a deterministic STARTING candidate; on collision the
                              host walks a deterministic sequence (seed, seed+1, …)
                              to the first free slot. Same capsule on a free host →
                              identical env; on a busy host → nearest free, recorded
                              back into the resumed manifest so seal-back is exact.

VERIFIED                      resume recomputes `id` from the applied inputs and
                              REJECTS on mismatch (a corrupted/edited capsule never
                              silently resumes wrong). This is the line between a
                              capsule and a tarball.
```

State `MODULO-AVAILABILITY` up front; do not pretend the OS is hermetic. The
"light" in "light nix env" is precisely *not* sealing the OS — only deriving and
namespacing what the session owns.

---

## UX / verbs

```
spell session seal [--to <server>] [--vcs git|jj|fossil|rsync]
    → freeze · bundle · snapshot env · content-address · (offer over bridge)
    → prints capsule id; local session enters "sealed" (read-only) state.

spell session resume <capsule-id|ref>
    → verify · realize env (recorded seed) · apply delta · load history · continue.
    → on a server with the autonomous domain: runs unattended; ask→Telegram.

# the sleep loop, concretely:
laptop>  spell session seal --to home-server     # before bed
server>  (auto-resumes via autonomous domain; works overnight; Telegram on ask)
server>  spell session seal                       # on a watermark / on demand
laptop>  spell session resume <id>                # morning — exactly where it left
```

Teleport is **symmetric**: seal and resume are the same pipeline with endpoints
swapped. "Hand it back" is not a special case — it is `resume` of the server's
seal. This symmetry is the test that the object is designed right.

---

## Why this lands clean on the existing substrate (not a detour — the consumer)

```
OwnerId (P3, SHIPPED)        the lock owner is ALREADY host-agnostic
                             ("node-session" | "beam:<pid>"). Teleport is the
                             FIRST consumer that actually moves an owner between
                             hosts. GATE 3 (lock-liveness: dead owner → broker
                             reclaim) is exactly "the laptop owner vanished; the
                             server owner adopts." The capability was BUILT here.

autonomous domain (harbor)   `surface "none"` + the no-human prompt + embeddings-off
                             is PRECISELY the "runs while you sleep" profile. Resume
                             on the server = activate the autonomous domain. Already
                             shipped; teleport is its natural trigger.

socket bridge + telegram     "mostly autonomous but ask me" already works — the
                             bridge relays ask/approval; telegram-bridge surfaces
                             them on your phone. A sleeping session that hits a real
                             decision pings you; you answer from bed; it continues.

BEAM runtime (per session)   the resume target is naturally a supervised OTP process
                             (WS-B). Teleport is the application that makes the
                             OwnerId + lock-liveness + one-warm-kernel investment PAY
                             — "session as a supervised, relocatable BEAM process" is
                             the WS-B end-state with a user-visible reason to exist.

execute / `.ptc` substrate   env.ptc reuses the EXACT pattern deftool proved:
                             a `.ptc` → inspectable data spec (rt-describe). The
                             capability policy (effects) already gates what a resumed
                             session may do. No new sandbox; a new CALLER.
```

The headline: **teleport is not new infrastructure — it is the missing
*composition* that gives four in-flight investments (OwnerId, autonomous domain,
socket bridge, BEAM runtime) a single user-facing payoff.**

---

## Build sequence (slices — each independently valuable, no big-bang)

```
S0  EnvManifest type + KDL parse (merge domain-KDL ∪ sandbox-policy fields;
    add ports/data/services). No behavior change; existing domains still parse.
    DONE = autonomous.kdl round-trips through the new shape; check:ts green.

S1  env.ptc realization: a `.ptc` evaluates (seeded) to an EnvManifest; reuse the
    deftool eval path (rt-describe proves closure-stripped data crosses the wire).
    DONE = `(realize "seed-x")` yields identical ports/db on repeated runs.

S2  Env realizer (host-side): port reservation (deterministic search), dir/db
    creation, sandbox-policy write (reuse sandbox-writer), service supervision +
    teardown. DONE = realize→bind→teardown on one host, ports namespaced by seed.

S3  VcsBackend trait + git impl (bundle/apply/verify). DONE = seal a dirty tree →
    bundle → apply into a fresh dir → tree_hash matches; verify rejects a mutated
    bundle.

S4  SessionCapsule: bundle history(JSONL+artifacts) ⊕ repo(S3) ⊕ env(S1) →
    content-addressed id; `seal`/`resume` CLI verbs. DONE = seal on host A, resume
    on host B (same machine, two dirs first), session continues, id verifies.

S5  Transport: socket-bridge `capsule_offer`/`capsule_claim` + an object-store/
    git-remote bytes channel. DONE = laptop seal --to server → server auto-resume
    (autonomous domain) → seal-back → laptop resume. The full sleep loop.

S6  ∥ jj/fossil/rsync VcsBackend impls (each a backend, not a redesign);
    BEAM-process resume target (WS-B) as the supervised, monitored host for a
    resumed capsule (OwnerId = beam:pid; GATE 3 reclaim on host death).
```

S0–S2 are pure local value (reproducible isolated envs from a `.ptc`) **before any
teleport exists** — so the risky/networked half (S4–S5) ships on a proven base.

---

## Non-goals / explicit NOTs (scope discipline)

```
- NOT Nix. No package graph, no store, no hermetic OS. "Light nix" = the IDEA
  (deterministic, isolated, reproducible-from-a-description), not the tool.
- NOT a VM/container image. The capsule is manifest + VCS bundle + log — KB–MB,
  not GB. Isolation is namespacing + derivation, not virtualization.
- NOT replacing /handoff. Prose handoff (lossy, for a model) and capsule (lossless,
  for a machine) coexist; §"convergence" note.
- NOT sealing the OS/global services. Only what the session OWNS (its ports, its
  db, its scratch). The determinism bound (§4) is stated, not hidden.
- NOT new sandbox machinery. env.ptc uses the EXISTING deftool eval + capability
  policy. A new caller, not a new cage.
- NOT coupling to BEAM for V1. S0–S5 run on the Node host; the BEAM-process resume
  target (S6) is the WS-B-aligned upgrade, not a prerequisite.
- NOT committing. This is the destination; S0 is the first honest, independently
  valuable slice to commit to.
```

---

## Open questions (flag, don't block)

```
Q1  capsule bytes channel: object store (S3 content-address → CAS dedup, resumable)
    vs git-remote (push the bundle as a ref) vs plain scp? Recommend CAS store —
    the id is ALREADY a content hash; dedup + resume fall out free.
Q2  seal granularity: explicit `seal` only, or also a periodic watermark (server
    seals every N min so a crash loses ≤N)? Recommend explicit V1, watermark as a
    server-side scheduler goal (spell-server already has Croner).
Q3  uncommitted-work policy on seal: auto-commit to a `spell/seal/<id>` ref vs keep
    as a bundle-of-dirty-tree? Recommend bundle-of-dirty (rsync-style) so seal never
    pollutes the user's commit graph; the delta is a capsule artifact, not history.
Q4  multi-session-per-host contention: a port registry on the target (who owns
    which derived slot) — a tiny SQLite (spell-server state stores already exist)
    vs OS-probe-only? Recommend probe + record-back (§4) for V1; registry if N grows.
Q5  secrets: a sealed session may reference API keys/tokens. Capsule MUST NOT carry
    them (content-addressed + transported = leak surface). Recommend: env names only;
    the target re-injects from ITS secret store. Fail-loud on a missing required key
    (mirror harbor's `require "HARBOR_MODEL"`).
```
