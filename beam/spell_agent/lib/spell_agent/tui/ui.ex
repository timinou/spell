defmodule SpellAgent.Tui.Ui do
  @moduledoc """
  The serializable gaze (PLAN-346) — App-side navigation state, the WRITE-mirror's
  value.

  The Store's span forest is the immutable truth of WHAT the model did. `Ui` is
  WHERE the operator is looking at it: focus, cursors, collapse, turn, scroll.
  PLAN-345 fixed the invariant that navigation lives in the App, never the Store;
  this struct is that navigation, consolidated into ONE pure value.

  Because it is pure data it is the dual of a projection's view-model:

      project/2 : forest   -> view-model   (READ  side, telemetry clock)
      react/3   : %Ui{}     -> %Ui{}        (WRITE side, keystroke clock)

  A reaction is a pure `Ui.t() -> Ui.t()`; this module supplies the verbs
  (`focus/2`, `cursor/3`, `expand/2`, …). `Ui` carries NO behaviour beyond those
  transforms — it is the noun; reactions are the sentences. Being plain data, it
  is also bindable as `data/ui` inside a PTC-Lisp reaction (W3).

  ## Collapse-by-depth (PLAN-346 D4)

  New spans stream in COLLAPSED past `auto_depth`; you expand to drill. Visibility
  is a POLICY, not a flat hidden-set:

      visible?(depth, id, ui) =
        case ui.overrides[id] do
          :expanded  -> true               # explicit open beats the depth rule
          :collapsed -> false              # explicit close beats the depth rule
          nil        -> depth < ui.auto_depth
        end

  So `overrides` is a property of your GAZE, not the forest — streaming spans never
  disturb what you opened, and `auto_depth` sets the calm default (1 = top-level
  runs visible, their children collapsed until you drill).
  """

  alias SpellAgent.Tui.Ui

  @type pane :: :tree | :detail | :prompt | :history | :cells
  @type span_id :: String.t()
  @type visibility :: :expanded | :collapsed
  @type mode :: :normal | :insert

  @type t :: %__MODULE__{
          focus: pane(),
          panes: [pane()],
          mode: mode(),
          cursors: %{optional(pane()) => non_neg_integer()},
          auto_depth: non_neg_integer(),
          overrides: %{optional(span_id()) => visibility()},
          turn: non_neg_integer(),
          scroll: %{optional(pane()) => non_neg_integer()},
          leader: atom() | nil,
          flags: %{optional(String.t()) => term()}
        }

  # PLAN-346 W5 pivot: panes are tree (navigate) / detail (full content of the
  # selected node) / prompt (the composer). `mode` is the modal layer — NORMAL
  # keys navigate, INSERT keys type into the composer. Launch is prompt+NORMAL
  # (the App overrides focus); the struct default keeps :tree for pure-unit ease.
  defstruct focus: :tree,
            panes: [:tree, :detail, :prompt],
            mode: :normal,
            cursors: %{},
            auto_depth: 1,
            overrides: %{},
            turn: 0,
            scroll: %{},
            leader: nil,
            flags: %{}

  @doc "A fresh gaze (defaults)."
  @spec new(keyword()) :: t()
  def new(opts \\ []), do: struct(__MODULE__, opts)

  # ---- visibility policy (D4) ----

  @doc """
  Whether span `id` (at tree `depth`) shows its CHILDREN under this gaze — the
  single predicate the span-tree projection folds on: it recurses into a node's
  children iff this returns true.

  Explicit per-span overrides beat the `auto_depth` default. With the default
  `auto_depth: 1`: depth-0 runs are expanded (their turns + direct llm/tool rows
  show) but depth-1 nodes are collapsed (a tool's nested sub-run stays folded
  until you drill). See moduledoc.
  """
  @spec expanded?(t(), non_neg_integer(), span_id()) :: boolean()
  def expanded?(%Ui{overrides: ov, auto_depth: d}, depth, id) do
    case Map.get(ov, id) do
      :expanded -> true
      :collapsed -> false
      nil -> depth < d
    end
  end

  # ---- focus ring ----

  @doc """
  Move focus through the pane ring, or jump to a named pane.

      focus(ui, :next) | focus(ui, :prev) | focus(ui, :answer)
  """
  @spec focus(t(), :next | :prev | pane()) :: t()
  # An empty ring has nothing to move to — identity, keeping the transform TOTAL
  # (a pure reaction must never crash on a degenerate-but-valid gaze).
  def focus(%Ui{panes: []} = ui, dir) when dir in [:next, :prev], do: ui

  def focus(%Ui{panes: panes, focus: cur} = ui, :next) do
    %{ui | focus: ring_at(panes, cur, +1)}
  end

  def focus(%Ui{panes: panes, focus: cur} = ui, :prev) do
    %{ui | focus: ring_at(panes, cur, -1)}
  end

  def focus(%Ui{panes: panes} = ui, pane) when is_atom(pane) do
    if pane in panes, do: %{ui | focus: pane}, else: ui
  end

  @doc """
  Set focus to a region directly, bypassing the ring-membership check.

  The C-j/C-k cycle (`focus/2`) only steps the `panes` ring; spatial `C-w` focus
  resolves a target by GEOMETRY and may legitimately land on a region OUTSIDE the
  ring (the `:cells` drawer, or `:history` before it joins the ring — FUP-005).
  Bounded the same way: `nil` (an unresolvable direction) is identity, so the
  transform stays total.
  """
  @spec focus_pane(t(), pane() | nil) :: t()
  def focus_pane(%Ui{} = ui, nil), do: ui
  def focus_pane(%Ui{} = ui, pane) when is_atom(pane), do: %{ui | focus: pane}

  # ---- cursor (within the focused pane) ----

  @doc """
  Move the focused pane's row cursor. Delta is an integer step, or `:first`.
  Clamps at 0 below; the upper bound is enforced by the pane at render time
  (the gaze doesn't know the row count). `:last` is represented as a large
  sentinel the pane clamps down — kept simple here as +1_000_000.
  """
  @spec cursor(t(), integer() | :first | :last) :: t()
  def cursor(%Ui{} = ui, :first), do: put_cursor(ui, 0)
  def cursor(%Ui{} = ui, :last), do: put_cursor(ui, 1_000_000)

  def cursor(%Ui{} = ui, delta) when is_integer(delta) do
    put_cursor(ui, max(cursor_of(ui, ui.focus) + delta, 0))
  end

  @doc "The focused pane's current cursor (0 if unset)."
  @spec cursor_of(t(), pane()) :: non_neg_integer()
  def cursor_of(%Ui{cursors: c}, pane), do: Map.get(c, pane, 0)

  defp put_cursor(%Ui{focus: pane, cursors: c} = ui, n) do
    %{ui | cursors: Map.put(c, pane, n)}
  end

  # ---- collapse / expand (span overrides) ----

  @doc "Mark a span expanded (children shown), beating the depth default."
  @spec expand(t(), span_id()) :: t()
  def expand(%Ui{overrides: ov} = ui, id), do: %{ui | overrides: Map.put(ov, id, :expanded)}

  @doc "Mark a span collapsed (children hidden), beating the depth default."
  @spec collapse(t(), span_id()) :: t()
  def collapse(%Ui{overrides: ov} = ui, id), do: %{ui | overrides: Map.put(ov, id, :collapsed)}

  @doc """
  Toggle a span between expanded/collapsed. The flip is relative to its current
  EFFECTIVE state at `depth` (so a never-touched span past auto_depth toggles to
  :expanded, and one inside the window toggles to :collapsed).
  """
  @spec toggle(t(), non_neg_integer(), span_id()) :: t()
  def toggle(%Ui{} = ui, depth, id) do
    if expanded?(ui, depth, id), do: collapse(ui, id), else: expand(ui, id)
  end

  # ---- turn navigation (answer / prompt focus) ----

  @doc "Move the selected turn index. Clamps at 0; upper bound enforced by the pane."
  @spec turn(t(), :next | :prev) :: t()
  def turn(%Ui{turn: t} = ui, :next), do: %{ui | turn: t + 1}
  def turn(%Ui{turn: t} = ui, :prev), do: %{ui | turn: max(t - 1, 0)}

  # ---- scroll (per-pane text scroll) ----

  @doc "Scroll a pane's text by `delta`, clamping at 0."
  @spec scroll(t(), pane(), integer()) :: t()
  def scroll(%Ui{scroll: s} = ui, pane, delta) do
    %{ui | scroll: Map.put(s, pane, max(Map.get(s, pane, 0) + delta, 0))}
  end

  # ---- mode (the modal layer, W5) ----

  @doc "Set the modal mode (:normal | :insert)."
  @spec mode(t(), mode()) :: t()
  def mode(%Ui{} = ui, m) when m in [:normal, :insert], do: %{ui | mode: m}

  @doc "A pane's current scroll offset (0 if unset)."
  @spec scroll_of(t(), pane()) :: non_neg_integer()
  def scroll_of(%Ui{scroll: s}, pane), do: Map.get(s, pane, 0)

  # ---- ring helper ----

  # Step `delta` positions around the pane ring from `cur` (wraps).
  defp ring_at(panes, cur, delta) do
    idx = Enum.find_index(panes, &(&1 == cur)) || 0
    Enum.at(panes, Integer.mod(idx + delta, length(panes)))
  end

  # ---- bounded coercion (atom-table-DoS defense, PLAN-346 W3r) ----
  #
  # A reaction is sandboxed PTC and its string outputs are UNTRUSTED. BEAM atoms
  # are never garbage-collected, so `String.to_atom/1` on attacker-controlled
  # strings is a denial-of-service vector. These coercions map a string to an
  # atom ONLY within a fixed, known vocabulary; anything else returns a safe
  # default (or nil) WITHOUT interning. This is the single chokepoint the
  # harness/reaction boundary funnels gaze-field strings through.

  # The full region vocabulary spatial focus (`C-w`) can land on — a superset of
  # the C-j/C-k cycle ring (`panes`). `:history` and `:cells` are reachable by
  # geometry (leftmost / the C-e drawer on the right) even when they sit outside
  # the ring, so `safe_pane/1` must accept them without interning (FUP-005).
  @panes [:tree, :detail, :prompt, :history, :cells]
  @dirs [:next, :prev, :first, :last]
  @visibilities [:expanded, :collapsed]

  @doc "Coerce a value to a known pane atom, or nil. Never interns a new atom."
  @spec safe_pane(term()) :: pane() | nil
  def safe_pane(p) when p in @panes, do: p
  def safe_pane(s) when is_binary(s), do: lookup_known(s, @panes)
  def safe_pane(_), do: nil

  @doc "Coerce a value to a known direction atom (:next/:prev/:first/:last), or nil."
  @spec safe_dir(term()) :: atom() | nil
  def safe_dir(d) when d in @dirs, do: d
  def safe_dir(s) when is_binary(s), do: lookup_known(s, @dirs)
  def safe_dir(_), do: nil

  @doc "Coerce a value to a known visibility atom (:expanded/:collapsed), or nil."
  @spec safe_visibility(term()) :: visibility() | nil
  def safe_visibility(v) when v in @visibilities, do: v
  def safe_visibility(s) when is_binary(s), do: lookup_known(s, @visibilities)
  def safe_visibility(_), do: nil

  @modes [:normal, :insert]

  @doc "Coerce a value to a known mode atom (:normal/:insert), or nil. No interning."
  @spec safe_mode(term()) :: mode() | nil
  def safe_mode(m) when m in @modes, do: m
  def safe_mode(s) when is_binary(s), do: lookup_known(s, @modes)
  def safe_mode(_), do: nil

  @doc """
  Coerce a value to a bounded string-keyed flags map, or nil.

  Flags are free-form UI toggle state a runtime reaction sets and a tmpl:: hole
  reads — the mechanism for keymap-driven visibility toggles without a compiled
  widget per toggle. Bounded: caps at 32 entries, stringifies keys (no atom-table
  growth from agent-authored data).
  """
  @spec safe_flags(term()) :: %{optional(String.t()) => term()} | nil
  def safe_flags(m) when is_map(m) do
    m
    |> Enum.take(32)
    |> Map.new(fn
      {k, v} when is_binary(k) -> {k, v}
      {k, v} when is_atom(k) -> {Atom.to_string(k), v}
      _ -> {"_", nil}
    end)
  end

  def safe_flags(_), do: nil

  # Match a string against a fixed atom set by STRING comparison — no interning.
  defp lookup_known(s, atoms), do: Enum.find(atoms, &(Atom.to_string(&1) == s))
end
