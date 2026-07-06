# Freeform TUI — Architecture

> **Status: PARTIAL (~85%, FEAT-039 landed).** The render-mirror + Reaction DSL
> ship and work. FEAT-039 closed three of the four original gaps:
> `lens/*` now ships all 10 documented verbs (`lens/focus`, `lens/focused`,
> `lens/focusables`, `lens/at`, `lens/tag`, `lens/frame-target`,
> `lens/retag-focus`, `lens/update-focused`, `lens/at-slot`, `lens/update-at`);
> `mode/insert` and `frame/leader` resolve through `Keys.resolve/2` (the SAME
> cascade as any other intent) and are live-rebindable/redefinable via
> `keymap/bind` + `keymap/define-reaction`; the gaze round-trip's `flags` field
> is now a documented, bounded, two-way extension map (`Ui.safe_flags/1`,
> 32-entry cap) that a reaction can read AND write across turns. `app/quit`
> remains INTENTIONALLY protected (never redefinable — a pure `Ui.t() -> Ui.t()`
> reaction cannot express `:stop`; a safe kill switch must survive any
> misconfigured keymap). Still open: the gaze is the `%Ui{}` struct
> (canonical), not a free tags-on-tree value — this doc's "navigation = lens
> ops" section (#9) describes the TARGET shape (`data/tree` as the reaction's
> primary value), which the shipped surface approximates via `Lens.to_ui`/
> `from_ui` rather than replacing `%Ui{}` outright; INSERT mode is still
> `:prompt`-only (not yet a first-class per-context concern — flagged as a
> follow-up, not fixed by FEAT-039). Read claims here as the target the
> consolidation lands, not all shipped today.

> The agent self-edits its own live terminal UI, **generally available** (no
> flag). The render surface becomes the third live-data mirror, and the
> navigation gaze and the render tree **unify into one value**.
>
> Tracking: `PLAN-009` + `FUP-005..009` in `!tasks/`. This document is the
> settled vision; the org items are the executable plan.

---

## 1. The thesis: three mirrors, one of them missing

The codebase already names two "mirrors" — pure functions over live data, each
on its own clock. Freeform adds the third:

```
project/2 : forest -> view-model    READ   mirror   telemetry clock   EXISTS
react/3   : gaze   -> gaze'          WRITE  mirror   keystroke clock   EXISTS (harness/ + keymap/)
layout    : tree   -> widgets        RENDER mirror   frame clock       THIS PLAN
```

`render/2` in `lib/spell_agent/tui/app.ex` **is** the render mirror — just
un-extracted and hardcoded. `materialize/2` (same file, L295) inline-injects live
state (`selected: cursor`, focus glyph) into widget structs. Freeform = make that
function a **value the agent can rewrite**, in the same PTC-Lisp it already uses
for tools and reactions.

### The registry trilogy

This is the **third instance of a pattern already trusted twice**:

```
ToolRegistry    : compiled tools    <- shadowed by  define-tool       (runtime PTC)
KeymapRegistry  : compiled keymaps  <- shadowed by  keymap/bind       (runtime data)
LayoutRegistry  : default layout    <- shadowed by  view//layout/      (runtime PTC)   <- NEW
```

Native UI is not "the real UI vs the freeform one". Native UI is the **default
value** in `LayoutRegistry`, authored in the same `view/` language the agent
writes. The agent's edits *shadow* slots. There is exactly **one render path**.

---

## 2. The keystone unification: gaze IS a lens over the layout tree

The decisive design move (and the reason this is elegant rather than bolted-on):
**there is no separate `%Ui{}` navigation struct in the target design.** There is
ONE layout tree, and navigation is a **lens operation that re-tags its nodes**.

```
OLD:  chord -> intent -> %Ui{} mutation -> render READS %Ui{} -> widgets
NEW:  chord -> intent -> named tree traversal -> re-tagged tree -> widgets
                         "focus/next"   = move the :focused tag to the next focusable node
                         "cursor/down"  = inc the :cursor tag on the focused node
                         "span/expand"  = set :expanded on the cursored node
```

Why this is correct, not merely clever:

- **One source of truth.** The tree the agent shapes IS the tree navigation walks
  IS the tree that renders. No gaze/layout sync bug is *possible* — there is
  nothing to sync.
- **`ex_rose_tree` is already a dependency** (`{:ex_rose_tree, "~> 0.1"}`) — a
  zipper, literally "a cursor into a tree". The exact primitive lens traversals
  need. The repo already bet on it (hist cursor navigation).
- **Intents become named traversals** — pure `tree -> tree`, the *same signature*
  as a reaction. The Reaction DSL's two-stage indirection
  (`chord ->[keymap]-> intent ->[reaction]-> result`) is unchanged; its value
  type just becomes the layout tree itself.

> **Settled (D1): unify from the start.** `%Ui{}` is replaced by tags-on-tree in
> v1. `keys.ex` dispatch and every pane `react/3` are ported to `lens/`
> traversals as part of v1, not a fast-follow. A half-step that kept `%Ui{}`
> would carry the very sync seam the design exists to delete.

---

## 3. Why this is cheap (grounded facts, verified in-tree)

1. **ex_ratatui's NIF boundary already speaks PTC's language.**
   `ExRatatui.draw/2` -> `ExRatatui.Bridge.encode_commands!` turns every
   `%Widget{}` struct into a **string-keyed map**
   (`%{"type" => "paragraph", "text" => ..., "style" => ...}`) before crossing to
   Rust. PTC-Lisp emits string-keyed maps natively. The struct layer is a typed
   skin over a map protocol. **=> reflection, not hand-written bindings.**

2. **Every widget is a plain `defstruct`** (~22 under `ExRatatui.Widgets.*`). A
   compile-time registry built by reflection
   (`:application.get_key(:ex_ratatui, :modules)`) yields
   `{name => %{module, fields}}` with the field whitelist taken **from the struct
   itself**. Upstream adds a widget/field -> it appears in the PTC surface AND the
   prelude automatically. **No drift, no magic.**

3. **The Lens layer is the exact template.** `lib/spell_agent/hist/lens.ex` +
   `priv/hist/lenses/*.ptc`: plain `.ptc` files loaded via `@external_resource` at
   compile, run through `PtcRunner.Lisp.run`. "Elixir materializes, PTC
   transforms." Layout is the same shape, one clock over (frame vs query).

4. **`ex_rose_tree` already vendored** — the zipper for tree traversal.

5. **`render/2` + `materialize/2` are the un-extracted seam.** The inline
   live-state injection is precisely what becomes the `data/*` bindings a slot
   program receives.

---

## 4. The layout tree — one shape

A node is a plain PTC map. Three structural kinds + a universal `:tags` bag:

```clojure
;; SPLIT — divides its rect via Layout.split, holds children (the spine)
{:type "split" :dir "vertical"
 :constraints [[:length 3] [:min 0] [:length 3]]   ;; + optional flex/spacing/margin
 :children [...]
 :slot "frame"}

;; PANE — a focusable region; :render is a view/ program over data/
{:type "pane" :slot "pane/tree" :focusable true
 :tags {:focused false :cursor 0 :scroll 0 :overrides {}}
 :render "(view/list {:items (get data/vms :tree) ...})"}

;; LEAF — a concrete widget (reflected from ex_ratatui)
{:type "paragraph" :text "..." :style {:fg "green"}}
```

`:tags` is where the **old `%Ui{}` fields live now** — on the node they describe.
`cursor` belongs to the pane it scrolls; `:focused` is a tag at most one node
carries; `:overrides` (expand/collapse per span) belongs to the pane that shows
that span.

### Layout.split grammar (confirmed: `ex_ratatui/layout.ex`)

```
constraint ::= {:length n} | {:percentage n} | {:min n} | {:max n}
             | {:ratio n d} | {:fill n}
opts       ::= :flex (:legacy|:start|:end|:center|:space_between|:space_around)
             | :spacing n | :margin n | :horizontal_margin n | :vertical_margin n
```

Already encoded as `%{"type" => ..., "value" => ...}` maps under the hood —
another PTC-native boundary.

---

## 5. Slots — named, shadowable, lens-addressable

```
frame                      root — composes the regions
├── status                 header strip (length 3)
├── body                   pane arrangement (min 0)  <- THE ARBITRARY-INTERFACE SLOT
│   ├── pane/history
│   ├── pane/tree
│   └── pane/detail
└── composer               input (length 3)
```

- Each slot **defaults to native-as-data** (a shipped, snapshot-tested `.ptc`).
- Override = shadow the slot in `LayoutRegistry`. Exact `ToolRegistry` pattern.
- **`frame` is the root whose default CALLS `status`/`body`/`composer`** (decided:
  nested, not flat). Overriding a sub-slot needs no `frame` edit; overriding
  `frame` is the ditch-everything escape.
- **`body`-as-a-slot is the arbitrary-interface unlock**: it owns the splits AND
  can project `data/forest` itself, so a brand-new region needs no Elixir
  `project/2`.

### Pressure-test — every usecase maps to the cheapest slot

| want | slot touched | effort |
|---|---|---|
| recolor errors / borders | `theme` cell (see §8) | one-liner |
| status shows token-cost + model | `status` | one-liner |
| restyle / re-render the tree pane | `pane/tree` | one-liner |
| add a pane (display) | `body` (+1 child) | medium |
| add a live cost-histogram pane | `body` (projects `data/forest`) | medium |
| rearrange columns (history right, detail wide) | `body` | one-liner |
| ditch inspector -> 3-up diff dashboard | `body` or `frame` | full program |
| move composer to the top | `frame` | one-liner |

**Property achieved: cost scales with ambition; nothing is unreachable; the 90%
case is a one-liner.**

---

## 6. The data environment a slot program sees (`data/*`)

| binding | shape | for |
|---|---|---|
| `data/area` | `{:x :y :width :height}` | the rect this slot fills |
| `data/ui` | gaze map (read-only projection of tree tags) | convenience; canonical state is the tree |
| `data/vms` | `{pane-name => view-model}` | reuse the READ mirror's already-projected content |
| `data/forest` | `{span-id => span}` | arbitrary new projections |
| `data/status` | `{:running? :result :last-prompt :model :cost}` | header content |
| `data/tree` | the live layout tree | lens ops |

Namespaces available **inside a slot**: `view/` (reflected builders) +
`harness/*` read queries (`descendants`/`ancestors`/`cursor-id`, already pure) +
`lens/*` + pure PTC. **No side-effecting `tool/`** — render is pure over injected
data.

> `data/ui` is retained as a **read-only convenience projection** derived from the
> tree's tags, so existing reaction idioms keep working; the canonical state is
> the tree.

---

## 7. The render contract — one recursive walk

```
split node  -> Layout.split(rect, dir, constraints, opts); zip children to sub-rects; recurse
pane node   -> run :render (view/ program) with data/* incl. this node's :tags
               -> a placement subtree; recurse
leaf        -> Materialize.to_struct(map) -> %Widget{} -> EXISTING Bridge path
               (keeps ALL Bridge validation, text coercion, custom-widget expansion)
```

Uniform: `frame`, `body`, a pane — all return this one placement-tree shape.
`view/split` is sugar that builds a split node; `view/<widget>` build leaves.

### Materialize — map -> struct (the no-drift coercion)

Two recursion rules cover all nesting with **zero per-widget code**:

1. value is `%{"type" => t}` -> rehydrate via the Reflect registry (widgets,
   blocks, spans).
2. value is a plain map AND the field's struct default is **itself a struct** ->
   coerce to that module (e.g. `:style` -> `%Style{}` — *the default tells you the
   type*).

Then the existing `Bridge.encode_widget/1` runs unchanged.

---

## 8. Theme — reflected, in v1

> **Settled (D2): reflect `ExRatatui.Theme` now.**

- `theme/` namespace built by reflection over `ExRatatui.Theme`'s named slots —
  same engine as the widget Reflect registry.
- `view/` builders **read theme defaults**: a builder with no explicit `:style`
  resolves its color from the theme slot for its role.
- `theme/set {:slot "error" :fg "magenta"}` re-tags the theme cell; cross-cutting
  recolor is **one op**, not a per-slot edit.
- Accept the slight builder<->theme coupling — it is the correct home for
  cross-cutting color and keeps recolor O(1).

---

## 9. Navigation = lens ops (`lens/` namespace)

Intents are **named traversals**, pure `tree -> tree` (same signature as
`react/3`; the value type is now the tree). A focus keymap **is** "differently tag
the layout tree to reflect the new state".

```clojure
;; "focus/next" — move the :focused tag to the next focusable node (zipper-ordered)
(lens/retag-focus data/tree :next)

;; "cursor/down" — inc :cursor on whichever node holds :focused
(lens/update-focused data/tree (fn [n] (update-in n [:tags :cursor] inc)))

;; "span/expand" — set override on the focused pane's cursored span
(lens/update-focused data/tree
  (fn [p] (assoc-in p [:tags :overrides (harness/cursor-id)] "expanded")))
```

`lens/*` primitives (~6, thin Elixir over the `ex_rose_tree` zipper, all pure):

| verb | does |
|---|---|
| `lens/focused` | find the node carrying `:focused` |
| `lens/retag-focus` | move the focus tag (`:next`/`:prev`/by slot), zipper-ordered |
| `lens/update-focused` | apply a fn to the focused node |
| `lens/at-slot` | address a node by slot name |
| `lens/update-at` | apply a fn to the node at a slot |
| `lens/focusables` | ordered list of focusable nodes (the focus ring) |

The agent can author **new traversals** as PTC — e.g. "focus the pane with the
most error spans" — because the intent body is a lens program over the live tree.

### What changes in the existing nav code (D1, on the critical path)

- `ui.ex` transforms (`focus`/`cursor`/`expand`/`turn`/`scroll`) become `lens/`
  ops over node `:tags`.
- `ui.ex`'s `safe_*` **bounded coercions are RETAINED** — still the atom-table
  chokepoint, now guarding tag/slot vocabulary.
- `Keys.dispatch` routes `intent -> lens traversal of data/tree` instead of a
  `Ui` transform.
- `Reaction.Ptc` binds `data/tree` (with `data/ui` as the derived read-only view).

---

## 10. Failure ladder (per slot) — the screen never bricks

```
slot program ok            -> use its tree
raises / garbage / wrong shape
                           -> last-good tree for THAT slot (cached)
none ever succeeded        -> native default .ptc for that slot
(native default is snapshot-tested; cannot fail)
                           -> status strip shows the error
```

Scope is **per-slot**: a bad `:status` never touches `:body`. The native default
is itself a `.ptc` that ships and is snapshot-tested via the existing
`SceneRender` headless-buffer path.

---

## 11. The prelude — reflected, no-drift, always-injected (v1)

Static `.md` frame + Handlebars over the compile-time widget registry (the same
reflection that powers `Materialize`). When ex_ratatui gains a widget/field, the
table regrows itself — prelude and capability share one source.

Shape (abridged; the widget table is generated):

- a 6-row **slot table** (`layout/set`-overridable, `layout/show`-readable)
- a generated **builder table** (`view/<widget>` -> key fields, from the structs)
- `layout/tree {}` / `layout/show {:slot ...}` to read the live tree as code
- a `theme/set` example
- a `keymap/define-reaction` + `lens/` example (author a new traversal, bind a key)

Compact because reflected, not prose. (Lazy surfacing is `FUP-008`.)

---

## 12. The inspector — homoiconic payoff

**In scope (v1, same-node, narrow):** read `LayoutRegistry` + live forest + gaze
in-process and render the layout tree as PTC **code-as-data** in a pane — the
interface DEFINITION and its CURRENT STATE (tags + the live `data/*` inside it),
refreshing as the run streams. Debounce from the render clock if char-by-char is
chatty. Proves "the interface is inspectable as the code that defines it" with
zero transport work.

**Cross-session (`FUP-006`):** point `spell.inspector --session <id>` at a running
session and inspect it live — "because it is the BEAM". A second process reads the
target's layout tree (plain data) over process-registry + telemetry, read-only.

---

## 13. In-scope deliverables (v1)

1. `SpellAgent.Tui.LayoutRegistry` — Agent; default tree as data; slot shadowing;
   last-good cache. Mirrors `KeymapRegistry`.
2. `SpellAgent.Tui.Reflect` — compile-time widget registry from ex_ratatui
   structs (the no-drift engine). Also reflects `ExRatatui.Theme` slots.
3. `SpellAgent.Tui.Materialize` — PTC map -> `%Widget{}` (+ nested
   `:style`/`:block` auto-coerce), then `Bridge` unchanged.
4. `view/` namespace — reflected builders + `view/split`. **Plain PTC primitives**
   (not tool-call-routed) — Edge P + user preference.
5. `layout/` namespace — `set` / `show` / `tree` / `reset` (homoiconic surface).
6. `lens/` namespace — the ~6 traversal primitives; **port `%Ui{}` navigation to
   tags-on-tree**.
7. Default layout + nav reactions rewritten as `.ptc` under `priv/` (dogfood).
8. `render/2` -> ONE path: resolve tree from `LayoutRegistry` -> walk -> `Bridge`.
   Collapses the current `has_history?` two-path branch.
9. `theme/` namespace — reflected from `ExRatatui.Theme`; builders read defaults.
10. In-scope same-node inspector view (layout tree as live PTC code-as-data).
11. Prelude `.md` + Handlebars over the Reflect registry; always-injected.
12. Snapshot + unit tests via the existing `SceneRender` path.

### Build DAG (revised for D1 — `%Ui{}` migration is on the critical path)

```
Reflect ──> Materialize ──> view/ ─┐
     └────> theme/ ───────────────┤
ex_rose_tree zipper ──> lens/ ─────┼──> LayoutRegistry ──> render/2 cutover
(tags-on-tree REPLACES %Ui{})      │         (single render path)
default layout + nav .ptc ─────────┘──> inspector view ──> prelude
```

---

## 14. Boundaries / non-goals (v1) -> tracked FUPs

| deferred | why | FUP |
|---|---|---|
| Navigable *new* panes (focus/keymap for an agent-added pane name) | gaze `panes` list + `safe_pane` atom whitelist + `focus_stack` don't know it | `FUP-005` |
| Cross-session `spell.inspector --session <id>` | needs session registry + telemetry attach + transport | `FUP-006` |
| Atom-DoS hardening of the widened surface | experiment-first (user); secure refactor tracked, not blocking | `FUP-007` |
| Prelude surface-on-first-UI-intent | needs a mid-session injection hook | `FUP-008` |
| Durable authored layouts across sessions | in-memory v1, like ToolRegistry today | `FUP-009` |

---

## 15. References (code, verified)

- Render mirror seam: `lib/spell_agent/tui/app.ex` `render/2` (L100),
  `materialize/2` (L295)
- Bridge struct->map: `../ex_ratatui-vendored/lib/ex_ratatui/bridge.ex`
  `encode_widget/1`
- Layout grammar: `../ex_ratatui-vendored/lib/ex_ratatui/layout.ex` `split/4`
- Theme: `../ex_ratatui-vendored/lib/ex_ratatui/theme.ex`
- Lens template: `lib/spell_agent/hist/lens.ex` (`project`/`run`,
  `@external_resource` `.ptc`), `priv/hist/lenses/*.ptc`
- Reaction DSL: `lib/spell_agent/tui/{keys.ex,keymap_registry.ex,reaction/ptc.ex}`,
  `lib/spell_agent/harness.ex`, README "The Reaction DSL"
- Gaze today (becomes tags): `lib/spell_agent/tui/ui.ex`
- Config surface: `lib/spell_agent/config.ex` (`define-config` pattern)
