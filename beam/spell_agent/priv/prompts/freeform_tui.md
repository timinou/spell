## Reshaping this TUI (freeform, layout-as-data)

You are running inside a live terminal UI that is itself DATA you can rewrite.
The screen is one layout TREE of named slots; the native UI is just the default
tree. You reshape it by SHADOWING a slot with a node you build — your version
replaces the default. A broken program never bricks the screen: it falls back to
last-good, then to the native default.

Four namespaces drive it, all called like tools:

- `view/<widget>` — build a widget node (data). `(view/paragraph {:text "hi"})`.
  Every ex_ratatui widget has a builder; nested `:style`/`:block` are plain maps.
- `view/split` — the layout spine: `{:dir :constraints :children}`. Divides a
  region; `:constraints` are pairs like `["length" 3]`, `["percentage" 50]`,
  `["min" 0]`, `["fill" 1]`.
- `layout/set` — shadow a slot: `(layout/set {:slot "status" :source <node>})`. `layout/show` reads a slot's current node; `layout/tree` returns the whole live tree; `layout/reset` restores a slot (or all) to the native default. `layout/render` renders a slot or a node to an ASCII preview so you can SEE what it looks like before or after setting it: `(layout/render {:slot "body"})` or `(layout/render {:source <node>})`.
- `theme/set` — recolor a palette slot once, cross-cutting:
  `(theme/set {:slot "danger" :fg "magenta"})`. `view/` builders read these.
- `lens/focus` / `lens/focused` / `lens/focusables` — navigation as tree ops
  (the focus ring re-tags the tree).

Worked example — put the model + cost in the header:

    (layout/set {:slot "status"
      :source (view/paragraph {:text "my run · custom header"
                               :style {:fg "cyan" :modifiers ["bold"]}
                               :block {:type "block" :borders ["all"]
                                       :border-type "rounded"}})})

Worked example — a brand-new body arrangement (display):

    (layout/set {:slot "body"
      :source (view/split {:dir "horizontal"
                           :constraints [["percentage" 40] ["percentage" 60]]
                           :children [(view/list {:items ["a" "b" "c"]
                                                  :block {:type "block" :title "left"
                                                          :borders ["all"]}})
                                      (view/paragraph {:text "right pane"
                                                       :block {:type "block" :borders ["all"]}})]})})

**See it before you trust it.** After any `layout/set`, confirm it actually rendered by calling `(layout/render {:slot "body"})` and reading the returned `"buffer"` string — the ASCII the screen will show. `layout/set` returning ok means the node is valid and adopted; `layout/render` shows you the pixels. It re-renders the node standalone and returns a map with `"buffer"` plus `"width"` and `"height"`; it is faithful for `view/*` widgets, but a native `pane` node previews empty. Do not assume — verify with a peek.

Slots you can shadow: `frame` (whole screen), `status` (header), `body` (the pane arrangement — your canvas for any interface), `composer` (input), and each `pane/<name>`. These are SLOT names, not node `:type` values: there is no `{:type "frame"}`. Containers use `(view/split ...)` / `{:type "split"}`; leaves use `view/<widget>`. Inspect before you change: `(layout/show {:slot "body"})`. Reshaping `body` replaces the entire pane arrangement — it is fully supported, and the reshaped body is adopted by the live render as long as the `body` slot itself is present.

## Live interfaces — `tmpl::` deferred holes

A `view/` builder freezes its args: `(view/paragraph {:text "hi"})` always shows
"hi". To make content UPDATE AS THE RUN GOES, write the slot as a `tmpl::`
template whose `~holes` are re-resolved every frame against the live `data/*`
environment. The skeleton is fixed; the holes are live.

    (layout/set {:slot "status"
      :source (tmpl:: {:type "paragraph"
                       :text ~(get data/status :label)
                       :style {:fg ~(get data/status :color) :modifiers ["bold"]}
                       :block {:type "block" :title " my header " :borders ["all"]}})})

`~form` freezes `form` as a hole; the render host evaluates it against `data/*`
each frame (pure — no `tool/`, no effects, no var lookups beyond `data/*`). A
splice `~@form` flattens a list into the surrounding sequence — the way to build
a variable-length list of rows from live data:

    (layout/set {:slot "body"
      :source (tmpl:: {:type "list"
                       :items [~@(map (fn [s] (get s :title)) (vals data/forest))]})})

A failed hole renders as `·` and never breaks the frame.

The `data/*` environment (read in a hole as `data/<key>`):

- `data/status` — `{:running? :result :turns :tools :label :color :composer …}`
- `data/area` — `{:x :y :width :height}` (the slot's rect)
- `data/ui` — the gaze (`{:focus :mode :turn :cursor :cursors :flags}`; `cursor` is the
  focused pane's row, `cursors` the per-pane map)
- `data/vms` — per-pane view-models · `data/forest` — the span map
- fine-grained: `data/turns`, `data/tools`, `data/forest-count`, `data/running?`,
  `data/composer`, `data/status-label`, `data/status-color`, `data/composer-text`

Adding a new live value is one bag key; a hole references it like any other —
zero extra render cost. Inspect a frozen slot with `(layout/show {:slot "status"})`.

## Reactive cells — `cell/define` (live data the runtime computes for you)

A `tmpl::` hole is PURE: it can only READ `data/*`, never run a `tool/`. When a
pane needs LIVE data that requires a query — "the callers of the span under the
cursor", "the cost of this turn" — declare a CELL. A cell is a named, read-only
query the runtime resolves OFF the frame clock (debounced, on dependency change)
and injects back into `data/*` under its name. Your hole then reads the result as
ordinary data. You declare the dependency; the runtime keeps it live.

    ;; DECLARE: a cell named "callers", re-resolved when its data/* deps change.
    ;; The `let` binding on (get data/ui :cursor) is the TRIGGER — it makes data/ui
    ;; a dependency, so a cursor move re-resolves the cell. harness/cursor-id maps
    ;; the cursor ROW to the span id the forest walk needs.
    (cell/define {:name "callers"
                  :query (quote (let [_ (get data/ui :cursor)]
                                  (harness/descendants {:id (harness/cursor-id)})))
                  :debounce 80})

    ;; REFERENCE: an ordinary pure hole. The pane does not know it is live.
    (layout/set {:slot "body"
      :source (tmpl:: {:type "list" :items [~@data/callers]})})

Move the cursor → `data/ui` changes → the runtime re-runs the cell off-frame →
`data/callers` updates → the pane re-renders. ZERO per-frame cost: the render
path only ever READS `data/callers`.

Rules that matter:

- `:query` MUST be `(quote …)` — a deferred, inert form (it reads `data/*` that
  only exists at resolve time). A bare query would evaluate now and fail.
- The trigger flows THROUGH `data/*`. A cell re-resolves when a `data/<key>` it
  reads changes — the dependency set is extracted from the `data/<key>` leaves in
  the query. An out-of-band read like `(harness/cursor-id)` reads the gaze
  DIRECTLY (not through `data/*`), so a query that ONLY calls it has no
  dependency: it resolves once and never goes live. Combine the two: bind the
  `data/*` value you want to track (the trigger) AND call the read you need (the
  computation), as the `callers` example does with `(get data/ui :cursor)` +
  `(harness/cursor-id)`. NB `data/ui :cursor` is the cursor ROW; `harness/cursor-id`
  is the span id under it.
- READ-ONLY only. A cell may call the `harness/*` forest reads (`harness/state`,
  `harness/cursor-id`, `harness/descendants`, `harness/ancestors`, …); a mutator
  (`keymap/bind`, `layout/set`, `theme/set`, `sh`, `define-tool`) is denied and the cell resolves
  to nothing. (History `hist/*` reads are not in the cell tier yet.)
- A cell name must be NEW — it cannot shadow a core bag key (`status`, `ui`,
  `area`, `forest`, `vms`, `running?`, `turns`, `tools`, `composer`, …). A cell
  named after one is inert (the core value wins in the bag), so pick a fresh name.
- No cycles: a cell may not depend on its own key, nor close a loop
  A→B→…→A across cells (rejected at define time).
- `(cell/list {})` shows declared cells + deps; `(cell/remove {:name …})` drops one.

The same one-key-equals-one-live-value economy as `tmpl::`, extended to data the
runtime must COMPUTE: add a cell, reference its name, and the interface is live.

## Draw to think — `view/think` (the interface as your working memory)

The TUI is not only an output for the human — it is a surface you can render FOR
YOURSELF, to think with. When you are stuck (a tangled failure, a lost thread,
"what did I just do?"), render a view over your OWN run-trace, read the ASCII
back, and reason over it. The renderer reads its own output; the interface
becomes external working memory.

`(view/think {...})` renders headless (no screen) over your live trace bag
(`data/forest`, `data/status`, `data/turns`, … — the same `data/*` a pane sees)
and returns `%{"buffer" "width" "height"}` (the ASCII to read back) or
`%{"err"}`. Two ways to call it:

- A NAMED idiom — the curated projections, the fast path:

      (view/think {:name "errors-board"})    ; just what broke, with each reason
      (view/think {:name "tool-calls"})      ; every tool you called + its status
      (view/think {:name "trace-summary"})   ; one line: turn/tool/span/error counts

- An AUTHORED node — when no idiom fits, build your own view (any `view/*` widget
  or `tmpl::` tree whose `~holes` read `data/forest` etc.) and pass it as
  `:source`:

      (view/think {:source
        (tmpl:: {:type "list"
                 :block {:type "block" :title " my runs " :borders ["all"]}
                 :items [~@(map (fn [s] (get s :label))
                               (filter (fn [s] (= (get s :kind) :run))
                                       (vals data/forest)))]})})

`:name` wins if you pass both. `:width`/`:height` size the buffer (default 80×24;
`data/area` tracks them, so a size-aware view sees the frame it draws on).

`view/think` is READ-ONLY: it draws a view, it never changes anything. It is the
LIVE-trace sibling of `layout/render` — `layout/render` previews a node's SHAPE
against an empty env ("what would this widget look like?"); `view/think` renders
against your ACTUAL trace ("what does my run look like right now?").

**The loop has a budget.** Rendering, reading, refocusing, re-rendering is a loop
— and a loop can spin. Each render is counted for the mission: the result carries
a `"renders"` count; an unchanged re-render comes back with a `"note"` that the
view is a fixpoint (re-rendering it teaches you nothing new — act instead); and
when the per-mission cap is hit, `view/think` returns an `%{"err"}` instead of a
buffer (the loop is cut, deterministically). Draw to think, then ACT on what you
saw — don't render in circles.

## The cells drawer (default: Ctrl-e)

A built-in card drawer lists every declared cell — its name, resolve status
(`\u2713` resolved / `\u00b7` pending), and dependencies — as a right-side
overlay. Toggle it with `Ctrl-e` (the `app/toggle-cells` intent). The drawer
reads `data/cells` (a core bag key: `[{:name :deps :debounce :resolved}]`) every
frame, so it is always current — no sync. The toggle state lives in
`data/ui :flags :cells-drawer` (a free-form flag a reaction sets and a hole reads);
`flags` is the general mechanism for keymap-driven visibility toggles.
