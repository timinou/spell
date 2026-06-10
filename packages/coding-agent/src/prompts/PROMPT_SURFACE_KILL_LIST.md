# Prompt Surface — Kill List & Cutover

Status: recommendations for manual application.
Scope: `packages/coding-agent/src/prompts/**` + the few `.ts` sites that gate them.
Ethos: every change drives the whole surface toward the register of the
`<language>` block in `system/system-prompt.md` (notation > prose, compression =
substance). That block is the canonical example; everything else should obey it.

Notation: ⌦ delete · ✎ rewrite · ⇒ merge-into · ✓ keep.

---

## 0. Why this exists (the ethos gap)

`<language>` (`system/system-prompt.md` lines 36-70) is the only block written in
its own dialect. Everything below it reverts to prose bullets ("These are
inviolable. Violation is system failure."). That is the exact register
`<language>` forbids. The surface contradicts its own thesis.

Three compounding forces:
- **say-it-thrice** — verify/test ethos stated 4×; refactor-cutover 2×; solve-actual-problem 2×.
- **prose where notation wins** — full sentences carrying one bit each.
- **dead tool surface** — `get`/`manage` legacy aliases + 5 orphan tool `.md` files still shipping tokens.

Dependency: **§3 (caveman default-on) only coheres after §1 (notation rewrite).**
Caveman layers a "drop articles" block on top of the base prompt; if the base is
prose, the model fights two registers. Notation-base + caveman = one voice.

---

## 1. `system/system-prompt.md` — kill + rewrite to `<language>`

### 1a. Redundancy — verify/test ethos stated 4×
- ⌦ **lines 79-81** (`Compiling≠ / Testing≠ / "It works"=`).
  Motivation: `<stakes>` (98-101) says it harder and in better register. Pure dup.
- ⌦ **line 124** (Principle #6 "Verify thoroughly: internally/externally").
  Motivation: ⇒ fold the verify clause into Principle #5 (see 1d). Standalone #6 is the 4th restatement.
- ⌦ **line 108** ("Solve the actual problem. Understand the actual problem.").
  Motivation: dup of `<discipline>` line 78 ("Understand the problem root, the intention goal…").
- ⌦ **line 110** ("Refactors must be cutover. Reduce cognitive load…").
  Motivation: dup of Principle #2 (line 120, "Ruthless removal of parallel implementation").

### 1b. Duplicate headers — the parallel-impl the prompt itself forbids
- ⌦ **`# Architecture` header (lines 112-114)**.
  - Arch #1 ("Simpler and more expressive…") ≈ Principle #1/#4.
  - Arch #2 ("answers questions you never posed") is the one unique idea → ⇒ move into Principle #5.
  Motivation: two headers asserting the same thing is a Principle #2 violation
  *inside the prompt that preaches Principle #2*. One need = one place.

### 1c. `<discipline>` (77-93) — prose → notation
Replace block body with:
```
<discipline>
root → intention → purpose, before impl.
"works" = production-ready for the work-type. ≠ compiles. ≠ tested once.

before any change:
  ∃ affordance? → extend, don't add parallel
  reviewable? → self-explains in diff

atomic work. DRY @ outline-L2. comments = intent ✗ narration.
Q ✗ "does it work?" → "under what conditions? outside them? ∴ what impl?"
delight matters.
</discipline>
```
Motivation: 16 lines → 11, denser, and now matches `<language>`. No meaning lost
(absorbs the deleted 79-81 verify lines as "≠ compiles. ≠ tested once.").

### 1d. `# Contract` (104-110) + `# Principles` (116-124) — rewrite
Contract:
```
# Contract — violation = system failure
- yield ⟺ deliverable ≥ original scope
- tests reflect fn; kept if tied to live features
- find insight w/ tools, ✗ guess
```
Principles:
```
# Principles — code = current truth
1. design = comprehensive: code ∧ tests ∧ docs ∧ UX ∧ DX ∧ cross-feature (A Pattern Language)
2. harmonious: one need = one impl. ⌦ parallel impl ruthlessly.
3. one job, one abstraction-level. need "and" to describe → split.
4. abstraction = mental affordance, ↓ cognitive debt.
5. types = bird's-eye. good types ⇒ clean system. right primitive answers unposed Qs.
6. verify: internal (tests) ∧ external (task-dep)
```
Motivation: Contract drops 108/110 (dups) → 7 lines to 4, keeps teeth.
Principle 5 absorbs Architecture #2 (the unique survivor) + the old #6 verify
clause as #6. Net for the file: ~−28 lines, register unified, zero meaning lost.

### 1e. Tool sections — `<language>`-ify
- ✎ **Precedence (197-210)**: drop the `{{#ifAny python bash}}` prose; render as
  a one-line table — `structural→edit · discovery→find · create→create · obs→status · proc→bash`.
- ✎ **Task section (243-250)**: see §2 D1 — it is also a contradiction site, fix there.
Motivation: precedence is a lookup, not an argument; a table is the right primitive.

---

## 2. Contradictions — kill the conflicts

### D1 — direct-first vs swarm-after-every-wave
Sites: `agents/task.md:3` ("Default: do the work directly…") + `system/system-prompt.md:245`
("Keep direct execution for straightforward work").
- ✎ `agents/task.md:3` →
  `Scope splits the call: atomic → direct. multi-file/multi-concern → delegate, file-disjoint.`
- ✓ Leave `system-prompt.md` base **neutral** — do NOT assert swarm-wide here.
Motivation: the wave/swarm methodology belongs in the new **mode overlay**, not
the stable base. The default agent must not fan reviewers on a one-line change.
Put potency in the overlay; keep base honest.

### D2 — "reviewers FILE" vs reviewer is read-only (HARD constraint)
Site: `agents/reviewer.md` frontmatter `tools: find, bash, lsp, fetch, web_search, report_finding`
— no `org`, bash is read-only (stated in its `<procedure>`).
- Reviewers **cannot** file org items. The clean model (already in code): reviewer
  `report_finding` → **main thread** files org during triage.
- In the new overlay, phrase as:
  ```
  review → reviewers surface via report_finding (read-only, parallel, per-concern)
  triage → main thread files each → org BUG/FEAT, assigns severity
  ```
Motivation: do **not** grant reviewer the `org` tool — it breaks the read-only
guarantee and the `submit_result` verdict contract. The methodology's own step 3
already puts TRIAGE on the main thread; align wording to that.

### D3 — eager-todo "plan whole request upfront" vs "insert waves as needed"
Site: `system/eager-todo.md` ("cover the entire request from investigation through
implementation and verification — not just the next immediate step").
- ✎ →
  `plan the spine + next wave + its gate. waves emerge from review fallout; ✗ enumerate all upfront.`
Motivation: emergent hardening waves (W_n.5) cannot coexist with a mandate to
enumerate the full tree first. The two directives currently contradict.

### D4 — "every turn advances the deliverable" vs "verification > momentum"
Site: `system/system-prompt.md:274` ("Every turn **MUST** materially advance the deliverable.")
Also the gate source: `system-prompt.ts:274` is the `Now/<critical>` render.
- ✎ line 274 →
  `Every turn advances the deliverable OR its proof (review, gate, hardening count).`
Motivation: a reviewer-audit turn or a hardening wave does not advance the
*deliverable* in the narrow read — it hardens it. Under "depth > speed,
verification > momentum," the current wording biases the model to skip the review
lane to "show progress." The four-word carve-out "OR its proof" reconciles
momentum with depth. Keep the line; widen the definition of "advance."

### D5 — gate has no anchor
Sites: `tools/todo-write.md` exposes gate fields (gateCmd/gateArtifact/gateCommit)
but no prompt says *gate per wave*.
- In the new overlay, bind them:
  `gate → wave ✗done until gateCmd green ∧ review backlog = ∅`
Motivation: the methodology's GATE ("proof green ∧ backlog burned") needs a
concrete tool anchor; todo_write gates are it.

---

## 3. Caveman as the spell-wide default (#6)

### The flip
Site: `config/settings-schema.ts:518` — `"caveman.defaultLevel" … default: "off"`.
- ✎ `default: "off"` → `default: "lite"` (recommended) — see note below.
Sibling defaults already correct for spell-wide:
- `caveman.affectSubagents` default `true` (`settings-schema.ts:547`) → subagents inherit. ✓
- `caveman.thinkingMode` default `"caveman"` (`settings-schema.ts:536`) → thinking blocks compress. ✓

### Order dependency (do NOT flip before §1)
The caveman block is appended on top of the base prompt
(`system-prompt.ts:538-553` renders `caveman.md` only when active). If the base
stays prose, default-on caveman makes the model fight two registers.
**∴ land §1 (notation rewrite) first; then caveman reinforces instead of overrides.**

### lite vs full
- `full` drops articles / uses fragments — aggressive for first-run users,
  error confirmations, human-read plan docs.
- `lite` (no filler, keep full sentences) is the safe spell-wide default.
Recommendation: **default `lite`**, document `full`/`ultra` as opt-in power-user.
Auto-clarity carve-out already exists (`system/caveman.md` bottom: drops terse for
security warnings, irreversible confirms, confused user) — so default-on is safe
on the dangerous paths.

### Pin human-facing outputs to lite regardless of session level
Sites with their own system prompts that a human reads/approves:
- `system/commit-message-system.md`
- `system/handoff-document.md`
- plan artifacts (the chat-as-artifact SendFile flow — see FUP)
Recommendation: caveman applies to agent reasoning + tool chatter; these outputs
pin to `lite` max, set explicitly in their own prompts, do not inherit session level.
Motivation: a human approving a plan or reading a commit message should not get
article-dropped fragments.

### Verify
- `caveman.showStatus` default `true` (`settings-schema.ts:526`) → confirm the
  campfire indicator is not emitted in non-TTY print/rpc modes.

---

## 4. Deprecated tools — full removal plan

### Class 1 — live legacy aliases (`REMOVE_AT_WAVE_11`, cost real tokens every session)
| tool | registration | prompt | tier | replaced by |
|---|---|---|---|---|
| `get` | `tools/index.ts:279` | `prompts/tools/get.md` | `tools/index.ts:314` | `find` |
| `manage` | `tools/index.ts:280` | `prompts/tools/manage.md` | `tools/index.ts:315` | `status` |

Transitional shims that reference them:
- `tools/find.ts:14` ("REMOVE_AT_WAVE_11: the GetTool delegation is a transitional shim")
- `tools/status.ts:15` ("REMOVE_AT_WAVE_11: collapse into direct executeCodePath")
- `tools/ptc-runtime/catalog-check.ts:43` (`"manage", // legacy alias`)

Cutover (one wave, file-disjoint):
1. ⌦ `tools/index.ts:279-280` (get/manage factory entries)
2. ⌦ `tools/index.ts:314-315` (TOOL_TIERS get/manage)
3. ⌦ `tools/ptc-runtime/catalog-check.ts:43` ("manage" from PTC catalog)
4. ✎ `tools/find.ts` — inline GetTool logic, drop shim; same for `tools/status.ts:15`
5. ⌦ `tools/get.ts`, `tools/manage.ts` + GetTool/ManageTool classes
6. ⌦ `prompts/tools/get.md`, `prompts/tools/manage.md`
7. grep replay/tests for `tool:"get"|"manage"` → migrate to find/status
8. ⌦ AGENTS.md line: "Legacy `get` and `manage` tools still registered as `REMOVE_AT_WAVE_11` aliases."

Risk: external callers (rpc/print-mode scripts, bundled commands) hardcoding `get`.
Mitigation: grep `"get"`/`"manage"` in rpc + bundled commands first. If any exist,
keep a 1-release **fail-loud** error stub (`get → throw "renamed to find"`), not a
silent alias.

### Class 2 — orphan prompt `.md` (no live registration, pure dead tokens)
| file | status | action |
|---|---|---|
| `prompts/tools/read.md` (632 B) | zero `with {type:"text"}` imports | ⌦ **DONE** (W-B) |
| `prompts/tools/grep.md` (1.4 KB) | only a *test* pinned a dead tool's prompt | ⌦ **DONE** (W-B; test block excised) |
| `prompts/tools/ast-grep.md` (2.5 KB) | zero imports | ⌦ **DONE** (W-B) |
| `prompts/tools/resolve.md` (405 B) | **live** — deferred-action resolver, auto-injected | ✓ keep |
| `prompts/tools/gateway.md` (347 B) | dead tool (`GatewayTool` unregistered) | ⌦ **DONE** |
| `prompts/tools/patch.md`, `replace.md` | imported by `patch/index.ts` — **live** | ✓ keep |

Correction (2026-06-10, revised): two separate sub-questions hid behind "has a
live import":
- **resolve** — `ResolveTool` IS registered (`HIDDEN_TOOLS.resolve`) and
  auto-injected whenever any tool reports `deferrable` (index.ts apply/discard
  resolver). Genuinely live. ✓ keep.
- **gateway** — `GatewayTool` registration was commented out
  (`REMOVED_PLAN_306_W11`); `createIf` never fires, barrel re-export had zero
  consumers. The sibling `import … with {type:"text"}` kept the `.md` *compiling*
  but the importer was itself dead. Deleted `.ts`+`.md` together (Class-1 pair).
  Do not confuse with the live gateway **CLI/daemon** (`commands/gateway.ts` +
  `@spell/pi-gateway`) — same name, different lifecycle.

Also deleted with it (the *code half* of the read/grep/ast-grep orphans):
`grep.enabled`/`grep.contextBefore`/`grep.contextAfter` settings + the
grep→ast_grep auto-include block + dead `isToolAllowed` branches — all gated a
`grep`/`ast_grep` agent tool with no factory. `astGrep.enabled` KEPT (live: bash
prompt gates ast-grep CLI guidance off it).

Verify-before-delete that drove the correction:
```
find { target: "packages/coding-agent/src/**/*.ts::§line[text~=\"(read|grep|ast-grep|resolve|gateway)\\.md\"]" }
```
read/ast-grep → 0 src imports. grep → 1 stale test. resolve → live (registered).
gateway → 1 import, but from a dead tool ∴ pair-deleted.

### Class 3 — removed-but-referenced (FUP, do not bundle)
- `loop_prepare/launch/done` already commented in `tools/index.ts`, but
  `loop/prompts/*.md` + `loop/loop-tools.ts` imports persist. If the loop domain is
  dead, ⌦ the `loop/` prompt set. Separate subsystem — track as its own FUP.

---

## 5. Sequenced cutover

```
W1  ✓ DONE  §1 notation rewrite of system-prompt.md (discipline/contract/principles/precedence)
W2  ✓ DONE  §2 D-fixes — D1 task.md neutral · D3 eager-todo next-wave · D4 "or its proof"
             (D2/D5 deferred to mode-overlay)
W3  ◧ PART  §4 deprecated tools — Class 2 read/grep/ast-grep ⌦ DONE; `manage` ⌦ DONE (earlier);
             `get` Class-1 alias + resolve/gateway tool-removal still pending
W4  ◧ DONE-AS-REMOVAL  §3 caveman — resolved by *removing* the toggle entirely (terse style
             now unconditional in <communication>), not by flipping default→lite
FUP loop/ prompt set audit · chat-as-artifact SendFile · the new wave-mode overlay (other agent)
```
W1+W2 touched the spine (`system-prompt.md`, `task.md`, `eager-todo.md`) — one
head, sequential, done. W3 Class-2 deletions were mechanical/file-disjoint. The
`get` Class-1 alias remains (wave-gated `REMOVE_AT_WAVE_11`, cheap when its wave
lands). W4 superseded: caveman machinery deleted rather than re-defaulted — a
single voice with no toggle is strictly simpler than lite-by-default.

---

## 6. Open decisions (needed before W1/W4)
1. Caveman default — **`lite`** (safe, recommended) or **`full`** (aggressive)?
2. New wave-mode overlay is another agent's work — leave a **named seam** in
   `system-prompt.md` (e.g. a `{{#if waveMode}}` hook) for attachment, or stay
   hands-off until it lands?
3. Chat-as-artifact: the manifest substrate is a plan + eventual `SendFile`
   (show chats as artifacts) — tracked as FUP, not in this cutover.
