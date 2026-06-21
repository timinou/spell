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
