defmodule SpellAgent.Tui.DefaultLayout do
  @moduledoc """
  The native inspector UI expressed AS THE DATA the agent would write (PLAN-009) —
  the dogfood proof that the freeform surface is complete: the default layout is a
  layout tree, not a hardcoded `render/2`.

  The tree mixes two leaf kinds the App's render resolves differently:

    * `"pane"` nodes — native panes (`history`/`tree`/`detail`), each carrying
      `slot`, `pane` (which `SpellAgent.Tui.Panes.*` module renders it), and the
      gaze `tags` (`focused`/`cursor`/`scroll`). The App runs the pane's
      `project/view` and materializes the descriptor (the existing machinery).
    * widget leaves (`"paragraph"`) — the status strip and composer, rendered by
      `Materialize` like any agent-authored widget. Their CONTENT is dynamic, so
      the App fills their `:text`/`:style` at render time from live state; the
      tree node carries only the static frame (block/borders).

  The frame is the slot spine:

      frame (split, vertical)
      ├── status   (length 3)  — widget leaf, content filled by the App
      ├── body     (min 0)     — split, horizontal: the three panes
      │   ├── pane/history (34%)
      │   ├── pane/tree    (30%)
      │   └── pane/detail  (36%)
      └── composer (length 3)  — widget leaf, content filled by the App

  `tree/1` seeds the gaze tags from a starting `%Ui{}` via `Lens`, so the App
  installs both structure AND initial gaze in one value.
  """

  alias SpellAgent.Tui.Lens
  alias SpellAgent.Tui.Panes.{Detail, History, SpanTree}
  alias SpellAgent.Tui.Ui

  @doc """
  The native default tree, seeded with `ui`'s gaze and the ACTIVE pane list.

  `pane_names` are the body panes in render order (e.g. `["history", "tree",
  "detail"]` live, or `["tree", "detail"]` in a 2-pane test) — the body splits
  evenly-by-default unless a known arrangement matches. The App calls this at
  mount and per-render so the tree always reflects the current panes + gaze.
  """
  @spec tree(Ui.t(), [String.t()]) :: map()
  def tree(%Ui{} = ui, pane_names \\ ["history", "tree", "detail"]) do
    %{
      "type" => "split",
      "slot" => "frame",
      "dir" => "vertical",
      "constraints" => [["length", 3], ["min", 0], ["length", 3]],
      "tags" => Lens.root_tags(ui),
      "children" => [
        status_node(),
        body_node(ui, pane_names),
        composer_node()
      ]
    }
  end

  @doc "The pane module a `pane/*` slot delegates to (App render dispatch)."
  @spec pane_module(String.t()) :: module() | nil
  def pane_module("history"), do: History
  def pane_module("tree"), do: SpanTree
  def pane_module("detail"), do: Detail
  def pane_module(_), do: nil

  # ---- slot nodes ----

  # A deferred hole referencing a single `data/<key>` (PLAN-012 W5 dogfood). Equal
  # to what `(tmpl:: … ~data/<key> …)` freezes for that ref — the codec encoding of
  # the `data/<key>` symbol — but written directly so the default layout needs no
  # runtime parse. The HoleResolver thaws + evaluates it against the data/* bag.
  defp hole(ref), do: %{"__hole__" => %{"node" => "sym", "value" => ref}}

  # The status strip as DATA (W5 dogfood): its dynamic text + color are holes over
  # the data/* bag's presentation keys, so the App no longer fills it from a
  # hardcoded `status_widget`. The block frame is static.
  defp status_node do
    %{
      "type" => "paragraph",
      "slot" => "status",
      "text" => hole("data/status-label"),
      "style" => %{"fg" => hole("data/status-color"), "modifiers" => ["bold"]},
      "block" => %{
        "type" => "block",
        "title" => " spell · inspector ",
        "borders" => ["all"],
        "border_type" => "rounded"
      }
    }
  end

  defp body_node(%Ui{} = ui, pane_names) do
    %{
      "type" => "split",
      "slot" => "body",
      "dir" => "horizontal",
      "constraints" => body_constraints(pane_names),
      "children" => Enum.map(pane_names, &pane_node(&1, ui))
    }
  end

  # Preserve the hand-tuned native column widths for the known arrangements; any
  # other pane set splits evenly (fill 1 each).
  defp body_constraints(["history", "tree", "detail"]),
    do: [["percentage", 34], ["percentage", 30], ["percentage", 36]]

  defp body_constraints(["tree", "detail"]),
    do: [["percentage", 45], ["percentage", 55]]

  defp body_constraints(names), do: Enum.map(names, fn _ -> ["fill", 1] end)

  # The composer as DATA (W5 dogfood): text, fg, and the modal block title are
  # holes over the data/* bag, so the App no longer fills it from a hardcoded
  # `composer_widget`. The block frame (borders/type) is static; only the title
  # is dynamic (INSERT/NORMAL), so it is a hole.
  defp composer_node do
    %{
      "type" => "paragraph",
      "slot" => "composer",
      "text" => hole("data/composer-text"),
      "style" => %{"fg" => hole("data/composer-fg")},
      "block" => %{
        "type" => "block",
        "title" => hole("data/composer-title"),
        "borders" => ["all"],
        "border_type" => "rounded"
      }
    }
  end

  # A native pane node: focusable, carries which module renders it + the gaze tags
  # for its slot (focused/cursor/scroll), seeded from the starting gaze.
  defp pane_node(name, %Ui{} = ui) do
    pane_atom = Ui.safe_pane(name)

    %{
      "type" => "pane",
      "slot" => name,
      "pane" => name,
      "focusable" => true,
      "tags" => Lens.pane_tags(ui, pane_atom)
    }
  end
end
