# Prototype findings: corners hit early (run against real runtimes)

**Date**: 2026-06-15
**Method**: probed the *actual* PTC runtime (`execute`), real `git`, a real
86KB session JSONL, and the real first-use-case repo `~/code/ora/monorepo`.
Findings are evidence, not speculation — each has a reproducing probe.
**Reads with**: `01-session-as-relocatable-object.md` (the design these correct).

---

## The first use case is sharper than assumed: a Nix + BEAM monorepo

`~/code/ora/monorepo` is **not** a generic repo. Verified shape:

```
toolchain   Nix flake (infra/beam/flake.nix) — flake.lock pins nixpkgs rev
            77c906c0… → deterministic erlang/elixir/postgres/node binaries.
            `nix develop ./infra/beam -c <cmd>` is the real entry (justfile:277).
runtime     5 Phoenix/Ash apps (apps/*) + 11 Djinn packages. Each app binds a
            PORT (45211, 45284, 45290, 18069, 4002…) and a Postgres DB
            (hotelcomm_dev, hostname localhost) — verified in apps/*/config.
isolation   ALREADY hand-rolled: FUP-242 `_build_warm` is an env-keyed build
            root because Elixir 1.20 `Mix.Sync.Lock` keys on the BUILD PATH
            (justfile:28-36). Two sessions on one host already collide on
            _build/dev unless the path is namespaced. This IS the capsule's
            isolation primitive — invented by hand, per-repo, undocumented as a
            general capability.
```

**Implication**: the capsule's "light nix env" is not competing with Nix here —
it sits *above* a Nix toolchain floor and *generalizes* the `_build_warm`
isolation hack the repo already needed. The two compose; see §"Nix layering".

---

## Corner 1 — PTC cannot hash a seed itself (host must) — RESOLVED

The design's `port = base + hash(seed) % span` assumed PTC could hash. It cannot:

```
probe: (apropos "hash")  → only hash-map/hash-set/array-map (collections)
probe: (hash "seed-x")   → "Undefined variable: hash"
probe: (apropos "rand")  → []          ; no rng
probe: (apropos "sha")   → no crypto
probe: (.charCodeAt c 0) → :unsupported_method
        available string methods: .substring .indexOf .lastIndexOf .length
        .contains .toLowerCase .toUpperCase .startsWith .endsWith  (NO codepoint)
```

PTC has `mod`, `bit-shift-left/right`, arithmetic, `.indexOf` — enough to
*derive* from a numeric seed, not to *produce* a cryptographic one.

**Resolution (proven determinism both ways):**
```
DECIDED   the HOST computes the real hash (blake3 of the capsule seed-string) and
          passes a NUMERIC seed into env.ptc as data/seed. PTC does ONLY the pure
          derivation:  (+ base (mod data/seed span))  — proven identical across
          runs (probe: {:web 4913 :db 5413 :same true}).
          → keeps the sandbox honest (no crypto in PTC, mirrors the §3 bridge
            rule: host performs the hard effect, PTC decides the shape), AND uses
            a real hash instead of a weak fold.
FALLBACK  a pure indexOf-alphabet fold IS available if a fully-self-contained
          .ptc (no host seed) is ever wanted — proven deterministic
          (probe: foldh("home-server")=784624 stable; ≠ "home-serves"=784625).
          Weak hash; only for a host without the seed service. Not the default.
```

This *strengthens* the §3 material split: env.ptc is purely the **derivation**
function; the seed (a content hash) is **host-supplied data**. The `.ptc` stays a
pure function of its input, which is exactly what makes it deterministic.

---

## Corner 2 — `git bundle` loses uncommitted work; three-tree snapshot is byte-exact — RESOLVED

The capsule's entire point is that *uncommitted* work travels. Naive `git bundle`
captures commits only — the dirty tree (staged + unstaged + untracked) vanishes.
Tested four strategies on a tree with `MM f1` (staged AND unstaged edits) + `??`
untracked file + untracked subdir:

```
A  git bundle --all                LOSES f2 (untracked) and the dirty state.   ✗
C  git diff + tar untracked         restores CONTENT but COLLAPSES the index:
   (rsync-style)                    MM f1.txt → ` M f1.txt`. The staged/unstaged
                                    split — which encodes what the agent had
                                    queued — is DESTROYED. Silent data loss.   ✗
D  three trees as git objects:      base + index-tree + worktree-tree written via
   write-tree ×2 → commit-tree ×2   `git write-tree` (twice: once on the real
   → one incremental bundle         index, once on a temp index with `add -A`),
                                    each commit-tree'd onto base, shipped in ONE
                                    `git bundle` of refs/seal/{base,index,worktree}.
                                    RESTORE: read-tree index → checkout-index →
                                    overlay worktree tree → re-read index.
                                    RESULT: `MM f1`, `?? f2`, `?? sub/` — BYTE-
                                    EXACT, staged split preserved. 953 BYTES.    ✓
```

**Resolution**: VcsBackend.git uses **Strategy D**. The bundle is content-addressed
(git's own object hashing → `tree_hash` falls out free), incremental (only delta
from base, not the whole history — 953 bytes for this case), and lossless to the
index granularity. This is the single most important corner: it is the difference
between "relocate my session" and "relocate my session but silently lose what I'd
staged." jj's native operation-log snapshot likely does this *better* (it tracks
the working copy as a commit by design) — a reason jj is a first-class backend,
not an afterthought.

---

## Corner 3 — session JSONL is path-anchored; relocation needs canonicalization — RESOLVED

Resume on a server with a different home (`/home/agent` vs `/home/user`) or repo
path (`/srv/work/x` vs `~/code/ora/x`) breaks absolute paths. Measured on a real
86KB session:

```
header   "cwd":"/home/user/code/ora/BackDesk-C"   — absolute, MUST rewrite.
body     9 absolute mentions, all of form …/details/resolvedPath:
         "/home/user/code/ora/BackDesk-C/.omp/skills/…" — tool-RESULT metadata
         (historical record the model reads), NOT live tool-call args.
args     tool CALL targets (find/edit "target","path") are RELATIVE/symbolic —
         0 absolute. The agent already works in cwd-relative space. ✓
```

**Resolution**: the capsule stores history in a **canonical, path-relative form** —
`cwd` becomes a token (`$CAPSULE_ROOT`), and a single rewrite pass on
`resolvedPath`-class fields re-anchors absolute repo paths to the token at seal,
re-expands to the target's real root at resume. Because live call-args are already
relative, the rewrite surface is small and bounded (header cwd + result metadata),
NOT a deep semantic rewrite of free-text reasoning. Content-addressing operates on
the *canonical* form → the same session seals to the same id regardless of which
machine sealed it. (Free-text reasoning that happens to quote an old absolute path
is left as-is: it is historical narration, not an executable reference.)

---

## Corner 4 — determinism is layered; Nix is the floor, the capsule is the envelope

The user's "consider Nix and reproducibility" lands exactly here. Reproducibility
is **three stacked layers**, each with a different owner — conflating them is the
trap:

```
LAYER        OWNER            DETERMINISM SOURCE                 CAPSULE RECORDS
─────        ─────            ─────────────────                 ───────────────
toolchain    Nix (if present) flake.lock pins nixpkgs rev →     flake ref + lock
  (erlang,                    bit-identical compiler/runtime     hash (a REFERENCE,
   postgres,                  binaries on any host with the      not the closure —
   node bins)                 same flake. THIS IS WHAT NIX IS    KB, not GB)
                              FOR; the capsule must NOT reimpl.
env shape    capsule (env.ptc) seed → derived ports/db/dirs.     full EnvManifest
  (ports, db                  Deterministic shape; concrete      + seed (data)
   names,                     slot = modulo-availability (§4 of
   scratch)                   doc 01). Generalizes _build_warm.
work state   capsule (VCS+log) Strategy-D bundle (byte-exact     bundle hash +
  (repo delta,               delta) + canonical history.         canonical history
   history)                  Verified on apply.                  + content id
```

**The composition rule** (decided): the capsule **references** the toolchain
layer, it does not contain it.

```
repo WITH a flake (monorepo)   manifest.toolchain = { kind:"nix",
                               flake:"./infra/beam", lock_hash:<blake3 of
                               flake.lock> }. RESUME: `nix develop <flake>` (the
                               locked rev) realizes the SAME erlang/elixir/pg,
                               THEN env realizer derives ports/db, THEN Strategy-D
                               applies the delta. Nix gives binary-identical
                               tools; the capsule gives the rest. Reproducibility
                               is INHERITED, not re-solved.

repo WITHOUT a flake (spell    manifest.toolchain = { kind:"assert", versions:{
   itself — no flake.nix)      bun:"1.x", rustc:"…", … } }. RESUME asserts the
                               target's tool versions match; fail-loud on drift
                               (mirror harbor `require "HARBOR_MODEL"`). Honest
                               "reproducible-modulo-availability" — the capsule
                               does NOT pretend to pin what Nix would; it records
                               the assumption and refuses to resume against a
                               silently-different toolchain.

OPTIONAL upgrade               a repo can ADOPT a flake later; the capsule's
                               toolchain field swaps kind:"assert" → kind:"nix"
                               with zero change to the env/work layers. The
                               layering is why that upgrade is local.
```

This is the precise answer to "a sort of mix between the PTC sandbox and some
light nix env": **PTC computes the env *shape* (lane 2), Nix pins the toolchain
*binaries* (lane 1, by reference), and neither reimplements the other.** "Super
light" because the capsule carries a flake.lock *hash* + a 1KB delta bundle +
the JSONL — it inherits Nix's heavy reproducibility by pointer, and owns only the
light, session-specific envelope.

---

## Net corrections to doc 01

```
§3  env.ptc is the DERIVATION function only; the seed is host-supplied data
    (blake3). PTC has no hash/rng/crypto — confirmed, designed around.
§Architecture Piece-3  VcsBackend.git := Strategy D (three-tree snapshot bundle),
    NOT `git diff`/`git bundle --all`. Lossless to index granularity, ~1KB.
§Architecture  ADD a toolchain layer to EnvManifest: { kind: nix|assert, … }.
    Nix composes by reference; non-nix repos degrade to fail-loud version asserts.
§4  history is content-addressed in CANONICAL (path-relative) form; cwd + result
    metadata re-anchored to $CAPSULE_ROOT at seal. Live args already relative.
Q5 (secrets)  reinforced: postgres creds + API keys in apps/*/config are
    env-injected already (System.get_env). Capsule carries NAMES; target reinjects.
```

---

## Corner 7 — "light" survives real contact IFF the bundle is THIN — RESOLVED

Measured Strategy-D on THIS repo's real working tree (21 dirty entries: 17
modified tracked + 4 untracked):

```
NAIVE bundle (refs/seal/* with base ref included)   142 MB  ✗  — carries the
    whole reachable history; `git add -A` also swept untracked docs into the WT
    tree. Unusable as a "light" capsule.
THIN bundle (refs/seal/{index,worktree} ^BASE)       44 KB  ✓  — `^BASE` excludes
    everything the target ALREADY has (it has the repo); ships ONLY the delta.
    `git bundle verify` reports "requires this ref: <BASE>" → resume refuses
    unless the target has the base commit. 3000× smaller.
```

**Resolution**: VcsBackend.git.seal emits a **thin bundle** excluding the base
revision (`^base_rev`); the capsule records `base_rev` so resume verifies the
target has it (and can `git fetch` it first if not). Real capsule weight for a
working session: **~44 KB repo delta + 3.5 KB flake.lock pointer + the JSONL** —
KB–MB total, vs 100s of MB–GB for a container image. The "super light" claim
holds, but ONLY with the thin-bundle discipline; a naive bundle silently balloons
to the full history. This is now a backend invariant, not an optimization.

---

## Still-open corners (next probes, not yet run)

```
C5  Postgres state: a live session may have MUTATED its dev DB (migrations, seed
    rows). Does "work state" include the DB, or only schema? Likely: capsule seals
    a `pg_dump` of the session's derived DB IFF the manifest marks it stateful;
    most agent work is schema-deterministic (migrations re-run) → dump only on
    opt-in. NEEDS a probe on a real Ash repo's migration determinism.
C6  Warm-daemon / long-lived processes (the _build_warm test daemon, `mix
    dev.live`): seal must DRAIN or KILL them (they hold the ports + build lock).
    Resume restarts from services[]. Probe: does killing the warm daemon mid-seal
    corrupt _build_warm? (FUP-242 lock domain suggests no, but verify.)
C8  jj backend: if the monorepo (or a worktree) is jj-colocated, jj's op-log IS
    the seal primitive — test `jj op restore` round-trip vs Strategy D for fidelity.
C9  base_rev divergence: target's repo may not have the laptop's HEAD (unpushed
    commits). Resume must `git fetch` the base from a full-history fallback OR the
    thin range floors at nearest PUSHED ancestor (^origin/main, not ^HEAD).
```