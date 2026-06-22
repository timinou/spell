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
- `layout/set` — shadow a slot: `(layout/set {:slot "status" :source <node>})`.
  `layout/show` reads a slot's current node; `layout/tree` returns the whole live
  tree; `layout/reset` restores a slot (or all) to the native default.
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

Slots you can shadow: `frame` (whole screen), `status` (header), `body` (the pane
arrangement — your canvas for any interface), `composer` (input), and each
`pane/<name>`. Inspect before you change: `(layout/show {:slot "body"})`.

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

`~(now expr)` is the escape hatch: evaluate ONCE at author time (a constant baked
into the skeleton), instead of freezing. A failed hole renders as `·` and never
breaks the frame.

The `data/*` environment (read in a hole as `data/<key>`):

- `data/status` — `{:running? :result :turns :tools :label :color :composer …}`
- `data/area` — `{:x :y :width :height}` (the slot's rect)
- `data/ui` — the gaze (`{:focus :mode :turn}`)
- `data/vms` — per-pane view-models · `data/forest` — the span map
- fine-grained: `data/turns`, `data/tools`, `data/forest-count`, `data/running?`,
  `data/composer`, `data/status-label`, `data/status-color`, `data/composer-text`

Adding a new live value is one bag key; a hole references it like any other —
zero extra render cost. Inspect a frozen slot with `(layout/show {:slot "status"})`.
