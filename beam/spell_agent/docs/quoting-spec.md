# Quoting, quasiquoting, and templates-with-holes in PTC-Lisp

> Status: **conceptual spec / vision-clarification**, pre-implementation. Frames
> *why* `~` matters beyond `sh::` (`docs/sh-reader-spec.md`), what quoting is,
> what PTC has today, and how "an interface with holes that update as it goes"
> maps onto quasiquote. The concrete `W*` plan for full quoting is **later**;
> the `sh::` + brush plan comes first.

---

## 0. The motivating use case

> "Define an interface with the holes of the code that will be run dynamically
> to update it as it goes, but the interface spec doesn't change."

Restated precisely: a **fixed skeleton** (structure that is written once and
does not change) containing a few **holes** (slots whose values are computed,
and recomputed, at runtime). The skeleton is a constant; the holes are live.

```
┌─ skeleton (constant) ─────────────────┐
│  {:panel  :title "Session"            │
│   :body   ~(render-current-turn)   ●  │  ← hole: recomputed as it goes
│   :footer ~(status-line)           ●  │  ← hole
│   :keys   ["q" "j" "k"]}              │
└────────────────────────────────────────┘
```

This is **exactly** what quasiquote + unquote express. The question is whether
PTC allows it today (partly — verbosely), how `~` would provide it, and how that
relates to Lisp's quoting tower. This document answers each.

---

## 1. What quoting *is* in Lisp — the four-rung ladder

Lisp's defining property: **code and data are the same structure** (lists,
symbols, vectors, maps). "Quoting" is the family of operators that move a form
along the *evaluate ↔ inert-data* axis.

| rung | operator | reads as | meaning | result |
|---|---|---|---|---|
| 1 | `quote` | `'x` | "do **not** evaluate; give me the form as data" | inert data |
| 2 | `quasiquote` | `` `x `` (backtick) | "mostly inert **template**, but watch for holes" | data with holes filled |
| 3 | `unquote` | `~x` | inside a quasiquote: "**evaluate** this hole, splice the value" | one value |
| 4 | `unquote-splice` | `~@x` | inside a quasiquote: "evaluate to a **list**, splice its elements" | many values |

The mental model:

```
quote       = freeze everything            '(a b c)        → (a b c)            [3 symbols, inert]
quasiquote  = freeze the skeleton…         `(a b c)        → (a b c)            [same as quote so far]
unquote     = …but thaw the holes          `(a ~x c)       → (a 5 c)            [x was 5]
splice      = …and thaw-and-flatten        `(a ~@xs d)     → (a 1 2 3 d)        [xs was (1 2 3)]
```

Crucially: **quasiquote produces a value (data), not necessarily running code.**
`` `(a ~x c) `` evaluates to the *list* `(a 5 c)`. Whether that list is then
*executed* is a **separate** operation (rung 5 below). Construction and
execution are independent axes — this distinction is load-bearing for the PTC
path (§6).

### Rung 5 — `eval`: turn data back into behavior

```
eval = take a data structure and RUN it as code      (eval '(+ 1 2))  → 3
```

`eval` is what closes the loop into full metaprogramming (and what macros use at
expansion time). It is the most powerful and most dangerous rung. **PTC has no
`eval`** (verified), and this spec argues it largely should not need one (§6).

---

## 2. What quasiquoting *is*, specifically

Quasiquote is **template instantiation for code/data**. It is the single most
important construct for the use case in §0, because it makes the *skeleton look
like its result* while marking the holes inline.

```clojure
;; a template: the shape is literal; ~ marks the holes.
`{:type "panel"
  :title ~the-title          ; hole — evaluated
  :rows  ~@(map row items)}  ; splice — evaluated to a list, flattened in
```

Contrast the same structure built with **constructors** (no quasiquote):

```clojure
(hash-map :type "panel"
          :title the-title
          :rows  (vec (map row items)))
```

Both produce the same value. The difference is **representational fidelity**:

```
quasiquote : the source LOOKS like the output, holes marked by ~
constructor: the source is CODE that computes the output, structure interleaved with calls
```

For a *small* structure the constructor form is fine. For a *large, mostly-fixed
skeleton with a few holes* — a UI layout, a tool spec, a query — the quasiquote
form is dramatically clearer: you see the interface, and you see exactly which
parts are dynamic. **That is the whole value proposition for §0's use case.**

---

## 3. What PTC has today — verified

| rung | operator | PTC today | evidence |
|---|---|---|---|
| 1 | `quote` | **symbols only** | `analyze_quote/1` → `{:symbol_ref, name}`; `(quote (a b))` raises *"quote only supports symbols in this phase"* |
| 2 | `quasiquote` | **absent** | no backtick/quasi/syntax-quote anywhere in `lib/` |
| 3 | `unquote` (`~`) | **absent** | `~` is an unused reader char |
| 4 | `unquote-splice` (`~@`) | **absent** | — |
| 5 | `eval` | **absent** | no `eval` builtin in `env/builtin.ex` |
| — | constructors | **present** | `vector` `hash-map` `list` `into` `concat` `conj` `str` … |

Two things stand out:

1. **`quote` is deliberately partial.** The error text says *"in this phase"* —
   the symbols-only restriction is a known, intentional floor meant to grow.
   `quote` exists to support REPL-discovery forms (`(doc foo)`, `(source bar)`)
   where a bare symbol must mean *the name*, not its value.
2. **Construction is fully available; only the *template syntax* is missing.**
   You can build any structure today with constructors. What you cannot do is
   write it as a *literal skeleton with holes*.

---

## 4. Is the §0 use case allowed today? Yes — but verbosely, and the skeleton is not preserved

The "interface with holes" **can** be expressed today, via constructors:

```clojure
;; the interface spec as a fn of its holes — works today:
(defn session-panel [current footer]
  (hash-map :type "panel"
            :title "Session"
            :body  current        ; "hole" = a parameter
            :footer footer
            :keys  ["q" "j" "k"]))

;; "update as it goes" = call it again with fresh hole values:
(session-panel (render-current-turn) (status-line))
```

This satisfies the *semantics* of §0:
- the **skeleton is constant** — the body of `session-panel` is fixed,
- the **holes update** — each call recomputes `current`/`footer`,
- a **host interprets** the resulting map (e.g. the TUI materializer →
  widgets).

What it does **not** give you is **representational fidelity**: the skeleton is
written as a `hash-map` call, not as the literal shape it denotes; the holes are
parameters, not inline `~` marks. For a big layout this is the difference
between *seeing the interface* and *reading code that assembles the interface*.

```
verdict: the CAPABILITY exists today (constructors + a fn of holes).
         the ERGONOMICS do not — there is no way to write the skeleton as a
         literal with ~holes. quasiquote is precisely that missing ergonomic.
```

So `~` / quasiquote is not adding new power for §0 — it is making the *existing*
power **legible**: skeleton-as-literal, holes-as-`~`. Given the vision is "the
agent authors its own interface as data it can read back," legibility *is* the
point — an interface you must mentally decompile is not one you fluently edit.

---

## 5. How `~` in `sh::` relates to quasiquote `~` — the unification

This is the key conceptual payoff. **`sh::` is a specialized quasiquote.**

```
quasiquote : Lisp forms        :: sh::  : shell words
  literal domain = data structure          literal domain = argv tokens
  ~hole evaluates → a value                 ~hole evaluates → an argv element
  ~@hole splices  → list elements           ~@hole splices  → multiple argv elements
  result = a data structure                 result = a vector of strings (→ brush)
  the quote is EXPLICIT (backtick)          the quote is IMPLICIT (the whole sh:: body)
```

Both are the *same primitive idea*: **a literal context where most tokens are
inert, and `~` escapes back to evaluation.** They differ only in:
- **what the literal tokens mean** (Lisp data vs. shell strings), and
- **whether the quote is explicit** (backtick) or **implicit** (the `sh::` form
  auto-quotes its whole body).

This is why building `~`/`~@` for `sh::` is the structural groundwork for general
quasiquote: the reader machinery for "scan a literal region, recurse into Lisp
at `~`" is **identical**; only the token interpretation and the desugar target
differ.

```
one reader primitive — "literal region with ~ escapes" — instantiated per domain:
  sh::   → vector of strings        → brush
  `…`    → Lisp data structure      → (host, or eval)
  sql::  → parameterized query      → db driver
  re::   → regex with holes         → matcher
  path:: → codepath with holes      → kernel resolver
∴ every "mostly-literal language with holes" is the SAME mechanism, different leaf.
```

---

## 6. Construction vs. execution — why PTC may never need general `eval`

Recall §1: quasiquote **produces data**; running that data is a separate axis
(`eval`). Full Lisp closes the loop with `eval`/macros. **PTC has a different,
safer closure already in place: domain hosts.**

PTC already has multiple *interpreters of data structures* — small, specialized
"evaluators," each for one domain:

| data structure | host that interprets it | "eval" for that domain |
|---|---|---|
| layout map `{:type "panel" …}` | `Tui.Materialize` → widgets | the render mirror |
| `(sh [argv])` | brush NIF | shell execution |
| `(tool/x args)` | tool dispatcher | effect invocation |
| reaction PTC source | `Reaction.Ptc` | keystroke → gaze' |
| query/lens PTC source | `Hist.Lens` | history projection |

So the loop "data → behavior" is **already closed per-domain**, by hosts, without
a general `eval`. This is the homoiconic-dissolution pattern in action: *the
structure is data; a mirror function interprets it.*

```
Lisp's classic loop:   quasiquote (build code) → eval (run code)        [one general evaluator]
PTC's loop:            quasiquote (build data)  → host interprets data   [many small evaluators]
```

Consequence for sequencing and safety:

- **Quasiquote (rungs 2–4) is the high-value, low-risk addition.** It is pure
  construction — produces an inert value, runs no new code, opens no sandbox
  hole. It buys the entire §0 use case (legible templates) and every leaf DSL.
- **General `eval` (rung 5) is high-risk and largely unnecessary.** The agent
  already turns data into behavior by handing it to a host (`define-tool`,
  `define-reaction`, a layout). Adding a general `eval` would duplicate that with
  a far larger attack surface (arbitrary code from data, inside the sandbox).
- ∴ **the path is: add quasiquote, keep routing execution through typed hosts.**
  Macros/`eval` remain deliberately out of scope until a concrete need survives
  the "can a host do this instead?" test.

This is the same caution PROJ-004 applies to effects-in-render: construction is
safe to move fast on; *execution* gets a capability/host boundary, not a blank
`eval`.

---

## 7. The taxonomy of quoting use cases (and where PTC lands)

| # | use case | needs | PTC today | with quasiquote |
|---|---|---|---|---|
| 1 | symbol as value (`(doc foo)`) | `quote` (symbols) | ✓ | ✓ |
| 2 | literal constant data (`'(1 2 3)`) | `quote` (lists) | ✗ (use `[1 2 3]`/`(list …)`) | ✓ via `` `(1 2 3) `` |
| 3 | **template with holes** (§0 interface) | quasiquote + `~`/`~@` | ◑ verbose (constructors) | ✓ legible |
| 4 | leaf DSL with holes (`sh::`, `sql::`) | per-domain reader + `~` | ✗ | ✓ (`sh::` is the first) |
| 5 | data → behavior | host **or** `eval` | ✓ via hosts | ✓ via hosts (no `eval`) |
| 6 | code that writes code (macros) | macro system + `eval` | ✗ | ✗ (deferred, maybe never) |

The session's work touches rows **3 and 4** — the high-value, construction-only
rungs. Rows 5 is already solved by hosts; row 6 stays out.

---

## 8. "Updates as it goes" — the reactive dimension

§0 says the holes "run dynamically to update as it goes." There are two timing
models for a hole, and the distinction matters:

```
eager hole   : ~x evaluated ONCE when the template is built        → snapshot
reactive hole: ~x is a deferred cell, re-read each time the host    → live
               reads the template                                    "updates as it goes"
```

Plain quasiquote is **eager** — `~x` is evaluated when the quasiquote runs. To
get "updates as it goes" you either:

1. **re-run the template each tick** — cheap, since it is just structure-building
   (the `(session-panel …)` call in §4 is exactly this — call it every frame),
   **or**
2. **make the holes reactive cells** — `~x` captures a deferred computation the
   host re-reads (a data-dependency). This is the deeper model and is precisely
   **PROJ-004's reactive-cell framing** ("looking vs. acting", effects relocated
   to "declare vs. resolve").

For the near term, model (1) — re-render a quasiquoted template each tick — fully
satisfies §0 and needs nothing but quasiquote. Model (2) is the research horizon
where templates-with-holes become *live reactive views*; it composes with
quasiquote rather than replacing it (the holes become cell-refs instead of eager
exprs). **This spec scopes quasiquote (model 1); reactivity is PROJ-004.**

```
the layering:
  quasiquote        → templates with holes (this spec, model 1)        ← legible interfaces
  + reactive cells  → holes that re-resolve on dependency change (PROJ-004, model 2)  ← live interfaces
  the second is the first with deferred holes — same skeleton, different hole timing.
```

---

## 8b. The `tmpl::` form — settled design (deferred holes)

> Status of THIS section: **settled design** (two forks chosen). It promotes the
> §8 model-2 ("reactive hole") from research-horizon to a concrete, buildable
> shape, because the freeform-TUI floor (PLAN-009) is already in-tree and needs
> live holes NOW. Tracking: `PLAN-012`.
>
> **Update (2026-06-22):** PLAN-011 W2 (`sh::`) has LANDED, claiming the `~`/`~@`
> reader chars — the precondition for `tmpl::`. But it is INLINE, sh-specific
> (`fast_parser.ex` `parse_sh_tokens`), and its `~` EVALUATES the form; `tmpl::`
> must FREEZE it. So the reader char is proven free, not the freeze machinery.
> Relative to Clojure: `` ` ``/`~`/`~@` map 1:1 to syntax-quote/unquote/splice;
> `tmpl::` is the novel rung (Clojure's only deferral path is quoted-form +
> `eval` — the general `eval` §6 refuses; `resolve_holes` is the bounded host that
> replaces it). `quote`→collections (the F2 substrate) remains UNBUILT.

### 8b.1 The motivating gap (verified in-tree)

PLAN-009 shipped layout-as-data: `LayoutRegistry` (tree as data + slot
shadowing), `Surface.layout/2` (tree -> `[{widget,rect}]`), `Materialize`,
`Reflect`, the `view/`/`lens/`/`theme/` surfaces. But **no layout node carries a
live hole**. Verified:

- a `view/` builder freezes its args — `(view/paragraph {:text "hi"})` stores
  the literal `"hi"`; there is no deferred slot.
- dynamic content reaches the screen ONLY through **hardcoded Elixir**:
  `app.ex` `resolve_node/3` fills `status`/`composer` via `status_widget/1` /
  `composer_widget/1`, and a `"pane"` node delegates to a compiled
  `Panes.*` module. Every dynamic value pays an Elixir tax.
- no `:render` PTC string is ever evaluated against live data — the
  architecture doc's `:render "(view/list {:items (get data/vms …)})"` is
  aspirational; nothing in the render path evals a form.

∴ "an interface with holes that update as it goes" (§0) is **not** implemented.
The skeleton-as-data exists; the holes do not.

### 8b.2 What a layout hole MUST be (three forces in tension)

```
1. serializable — the tree persists (LayoutRegistry -> Khepri, FUP-009).
                  a hole CANNOT be a closure; it is inert DATA describing a computation.
2. deferred     — classic quasiquote is EAGER (~x runs once at build). a layout hole
                  stays FROZEN and re-resolves every frame. (§8 model-2.)
3. legible      — authored as ~expr inside an otherwise-literal skeleton (§2 fidelity).
```

Rung-2 quasiquote answers (3). The genuinely new thing is **(2) deferral**: a
quasiquote whose holes *persist as data* instead of collapsing to values. That
is the whole design problem; everything else composes from the spec's existing
rungs.

### 8b.3 Fork 1 (chosen): timing-by-FORM, not by sigil

A layout is ~100% deferred holes. So bind timing to the **reader form**, keeping
the skeleton marker-clean — the same stance as the `sh::` family ("the form
implies the mode").

| form | `~` lowers to | when it runs | use |
|---|---|---|---|
| `` `…`` (backtick quasiquote) | `x` evaluated inline | once, at construction | snapshot a value to hand off now |
| `tmpl::` | `{:hole 'x}` — frozen form as data | every frame, by the host | live interface holes |

```
A: timing-by-form   tmpl::      ✓ skeleton clean (no per-hole marker)
                                ✓ matches sh:: reader-form family
                                ✓ a layout never mixes timings in practice
B: timing-by-sigil  ~ vs ~^     ✗ every layout hole wears a marker (noise)
                                ✗ "which sigil?" decision on every hole
=> A. The rare build-time hole inside a tmpl:: uses an explicit escape ~(now expr).
```

### 8b.4 Fork 2 (chosen): the hole stores QUOTED-AST-as-data

The frozen form persists as homoiconic data — structurally diffable, and the
SAME shape any `:ptc` tool body has, so ONE recall layer covers holes and tools
(`sh-reader-spec.md` §7). This needs `quote` lifted from symbols-only to
collections (`analyze.ex:877`) plus an AST<->data codec.

```clojure
;; surface (authored):
(tmpl:: {:type "paragraph"
         :text ~(str (get data/status :model) "  $" (cost data/status))})

;; persisted in LayoutRegistry (hole frozen, plain serializable data):
{"type" "paragraph"
 "text" {"__hole__" '(str (get data/status :model) "  $" (cost data/status))}}
```

`{"__hole__" <form-as-data>}` rides the existing tree storage with ZERO storage
changes. `~@` lowers to `{"__splice__" <form>}` for variable-length holes.

### 8b.5 The resolver host — a scoped, capability-bounded eval

The render walk gains ONE generic step, BEFORE `Materialize`: walk the node tree
and resolve holes against a `data/*` env. This is the render domain's small
evaluator — sibling of `Tui.Materialize` and `Reaction.Ptc`, exactly the §6
"hosts close the data->behavior loop, no general eval" doctrine.

```
Surface.resolve_holes(tree, data_env) :
  {"__hole__"   form} -> eval form with data/* bound -> substitute the value
  {"__splice__" form} -> eval to a list -> flatten into the parent's child slot
  plain map / vector   -> recurse
  scalar               -> as-is
```

Capability boundary (render-purity, philosophy Layer -4): the resolver evals
**pure builtins + `data/*` + `view/`/`harness` read fns ONLY**. No `tool/`, no
`layout/set`, no effects. It is a scoped eval, never a blank one.

### 8b.6 Why this is ZERO-cost to the runtime (the §0 demand)

```
TODAY:  state -> status_widget/1 (Elixir) -> widget         per value: bespoke Elixir
DESIGN: state -> data/* bag (assembled ONCE) -> holes resolve generically
                                                           per value: one bag key
```

The App fills a GENERIC `data/*` bag once (`data/area`, `data/status`,
`data/vms`, `data/forest`, `data/ui` — these projections already exist in
`app.ex`/`projection.ex`). Every hole resolves through ONE code path that never
names a specific value. Adding `data/tokens`:
- ONE site grows (the bag assembly),
- any number of holes reference `~(get data/status :tokens)`,
- **no new render-path Elixir, no recompiled fill function.**

That is the precise floor the user asked for: "sending a new value taken
dynamically like the others, through dynamic hole re-interpretation."

### 8b.7 "Updates as it goes" — free in v1

Deferred holes re-resolve **every frame** -> live by construction, no reactive
machinery needed. PROJ-004's reactive cells (resolve only on dependency-change,
debounced) become a *resolution-clock optimization* over the SAME hole datum —
forward-compatible, not a rewrite (see §8c).

### 8b.8 Failure ladder (never brick the frame)

Per-hole, mirroring the existing Edge-B posture (`safe_resolve_node` /
`encodable_placement?` in `app.ex`):

```
hole resolves            -> use value
hole raises / wrong type -> last-good value for THAT hole (cached) -> "·" placeholder
                         -> never raises; the rest of the frame renders
```

---

## 8c. Atomic diffs — the LiveView mapping

The `tmpl::` design produces LiveView's core data shape **without a compiler
pass**. LiveView splits a template into statics (sent once) and dynamics (the
holes, re-sent only when their assigns change); the reader has ALREADY done that
split structurally — the skeleton is inert data, the holes are tagged maps.

```
LiveView %Rendered{}        hole-design layout node
─────────────────────────   ─────────────────────────────
static:  ["<p>" "</p>"]      the frozen skeleton map (tree minus holes)
dynamic: [model, cost]       the {"__hole__" form} slots
fingerprint                  structural hash of the skeleton
__changed__ (assigns)        which data/* keys changed this frame
```

### 8c.1 The five correspondences

**1. Stable addressing = the tree path to each hole.** Walk the tree once -> a
flat hole table `path -> form`. The path is the diff key; holes are independent
leaves (no hole reads another) -> invalidation is **per-hole atomic**.

```
{"status" "text"}             -> '(str (get data/status :model) " $" (cost data/status))
{"status" "style" "fg"}       -> '(if (get data/status :running?) "yellow" "green")
{"body" "children" 2 "items"} -> '(map row-of (vals data/forest))   ; splice hole
```

**2. Change tracking = static dependency analysis of each hole's form.** Walk
each quoted form for the `data/<k>` symbols it references -> a dependency set per
hole, computed once, cached by skeleton fingerprint.

```clojure
changed = keys where data[k] (struct≠) prev[k]    ; shallow, cheap
dirty   = holes where (deps ∩ changed) ≠ ∅
;; re-eval dirty holes only; reuse cached value for the rest;
;; emit a patch {path -> value} only where the value actually changed.
```

This IS `assigns-changed -> dynamic-invalidation`, with `data/*` as assigns.

**3. The coarse precursor already exists in-tree.** `Pane.dirty?/2` (`pane.ex`)
does exactly this at PER-PANE granularity: `events/0` declares which telemetry
suffixes wake a pane. Holes are the refinement — from "this pane depends on
`[:turn,:stop]`" to "this hole depends on `data/status`". Same dirty-filter
philosophy, one granularity finer.

**4. Two diff layers compose (the terminal-specific win).**

```
Layer 1 — HOLE diff (new):    dirty holes -> which widget subtrees to re-materialize+re-encode
Layer 2 — CELL diff (exists): ratatui back-buffer vs front-buffer -> which bytes to emit
```

A subtree with NO dirty hole reuses its cached `%Widget{}` placements — skipping
the PTC eval, the `Materialize` struct build, AND the `Bridge.encode`. ratatui's
cell diff then sees identical content and emits nothing. So "zero cost" extends
from "no per-value Elixir" to "no per-frame recompute for the static 90% of the
screen."

**5. Splice holes = keyed list comprehensions.** A `~@` splice whose row body is
itself a `tmpl::` carries LiveView's two-level comprehension structure:

```clojure
(tmpl:: {:type "list"
         :items ~@(map (fn [s] (tmpl:: {:text ~(:title s) :style {:fg ~(span-color s)}}))
                       (vals data/forest))})
```

```
outer (dynamic): which items — keyed by span-id
inner (static):  the row skeleton — built ONCE
inner (dynamic): per-row holes — patched per CHANGED row
```

-> a span whose title changes patches ONE row's ONE hole, not the list
(LiveView `%Comprehension{}` diffing; key by span-id, emit add/remove/update).

### 8c.2 Where it is most literally LiveView — the remote tree

For same-process render, layer-1 is an optimization. For cross-session inspect
(`FUP-006`) / shared tree (`PROJ-005`), the hole diff **is the wire protocol**:

```
join:    send skeleton statics + fingerprint   (once)
tick:    send {path -> value} for dirty holes only
reshape: (agent layout/set) -> fingerprint changes for that slot -> resend that subtree's statics
```

The skeleton crosses the BEAM once; only changed dynamics flow after. Per-slot
fingerprinting = LiveView's per-template fingerprint, at exactly the granularity
the agent already reshapes (the slot).

### 8c.3 The one tuning knob (honest caveat)

Atomicity is only as fine as the `data/*` keys. A hole reading `data/forest`
re-evals whenever ANY span ticks — correct, but coarse. The LiveView lesson
(fine-grained / temporary assigns) applies verbatim: **split the bag**. Expose
`data/cursor-span`, `data/forest-count`, `data/status-cost` as distinct keys so
a hole needing only the count doesn't wake on an unrelated span update. The bag's
key granularity is the dial trading projection cost against diff precision — and
because adding a key is the ONE place the design grows, diff precision is tunable
**with zero render-path cost.**

```
∴ the mapping:
  statics/dynamics  -> already structural (reader split it) — no compile pass
  addressing        -> tree path = diff key, per-hole atomic
  __changed__       -> data/* dependency set per hole (static analysis, cached)
  comprehensions    -> ~@ splice with tmpl:: rows = keyed list diff
  wire diff         -> the hole table IS the LiveView patch for the remote tree
  fine-grained      -> data/* key granularity, tunable at zero render-path cost
```

The deep reason it lines up: LiveView and this design are the SAME idea — *a
pure function of assigns, where "live" is a declared dependency the runtime
resolves, not an effect the view performs* (philosophy Layer -4, verbatim).
Deferred holes are assigns-driven dynamics; `data/*` is the assigns; the
resolver is `render/2`. The atomic diff FALLS OUT instead of needing a compiler.

---


## 9. New dissolution rows this clarifies

The philosophy table (`docs/freeform-tui-philosophy.md`) gains a precise framing:

| boundary | dissolved by | why it wasn't a law |
|---|---|---|
| **template vs. instance** | quasiquote (skeleton-as-literal + `~` holes) | the skeleton was trapped as constructor *code*, not writable as the shape it denotes |
| **building vs. running** | per-domain hosts instead of `eval` | "code becomes behavior" needed one general evaluator only because behavior wasn't *typed by domain* |

Both are the familiar move: free the representation (write the template as its
literal shape; route execution through typed data-interpreting hosts) and a wall
that looked fundamental — *templates must be code*, *running data needs eval* —
turns out to be chalk.

---

## 10. What this means for the build sequence

```
NOW   sh:: + brush         the useful first instance of "literal region + ~ escapes".
                            ships ~/~@ reader machinery scoped to argv. (sh-reader-spec.md)
LATER quasiquote (rungs 2–4) generalize the SAME reader machinery to Lisp forms:
                            backtick template, ~ unquote, ~@ splice → legible
                            templates-with-holes (§0). pure construction, no eval.
                            → unlocks sql:: / re:: / path:: by the same pattern.
NEXT  tmpl:: deferred holes generalize the SAME machinery to a SECOND timing: a
      (PLAN-012, §8b)       quasiquote whose holes PERSIST as quoted-AST-data and re-resolve
                            every frame. ships: quote→collections, the AST<->data codec,
                            Surface.resolve_holes (scoped host eval over data/*), the
                            generic data/* bag (retires status_widget/composer_widget),
                            and per-hole dirty-tracking (the atomic-diff substrate, §8c).
DEFER reactivity (PROJ-004) the dirty-tracking of §8c becomes a resolution-CLOCK over the
                            same hole datum: re-eval a hole only on data/* dependency change
                            (debounced), not every frame. an optimization, not a rewrite.
NEVER (default) general eval / macros — hosts (incl. resolve_holes, which is CAPABILITY-
                            bounded: pure builtins + data/* only, no tool/, no effects)
                            already close the data→behavior loop with a smaller attack
                            surface. revisit only if a concrete need survives the "can a
                            host do this?" test.
```

The throughline: **`~` is one primitive — "escape a literal context to
evaluate a hole."** `sh::` instantiates it for shell now; quasiquote generalizes
it to all data later; reactivity changes *when* the holes resolve. Each step is
construction, legibility, and typed interpretation — never a blank `eval`.

---

## 11. Verified facts underpinning this spec

| claim | evidence |
|---|---|
| `quote` is symbols-only | `analyze_quote/1` → `{:symbol_ref, _}`; non-symbol raises *"quote only supports symbols in this phase"* |
| no quasiquote/unquote/splice | no `quasi`/`syntax-quote`/`backtick`/`unquote` in `lib/` |
| no `eval` builtin | absent from `lib/ptc_runner/lisp/env/builtin.ex` |
| constructors exist | `vector` `hash-map` `list` `into` `concat` `conj` `str` in runtime builtins |
| hosts already interpret data | `Tui.Materialize` (layout→widgets), tool dispatch (`(tool/x …)`), `Reaction.Ptc`, `Hist.Lens` |
| `~` is free | unused reader char; `sh::` spec claims it for unquote |
| `` ` `` (backtick) is free | unused reader char; no branch in `fast_parser.ex` `do_parse_expr/2` |
| PLAN-009 floor shipped, holes absent | `LayoutRegistry`/`Surface`/`Materialize`/`view/` exist; `view/` builders freeze args; `app.ex` `resolve_node/3` fills `status`/`composer` via hardcoded `status_widget/1`/`composer_widget/1`; no `:render` form is ever evaluated |
| per-pane dirty-filter precedent | `Pane.dirty?/2` + `events/0` (`pane.ex`) — the coarse-grained ancestor of per-hole dirty-tracking |
