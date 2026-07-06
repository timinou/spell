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

  alias PtcRunner.Lisp.{Parser, QuoteData}
  alias SpellAgent.Tui.Lens
  alias SpellAgent.Tui.Panes.{Detail, History, SpanTree}
  alias SpellAgent.Tui.Ui

  # The default-layout data file (PLAN-025 W3, FEAT-040): the body-split
  # constraints + pane-module dispatch as a PTC data literal, the SAME shape
  # `layout/set` produces. `@external_resource` recompiles this module on a
  # file edit; the module still re-reads the file at RUNTIME (`reload/0`) so a
  # live edit is pickup-able without recompiling Elixir at all.
  @data_path Path.join([:code.priv_dir(:spell_agent) |> to_string(), "tui", "default_layout.ptc"])
  @external_resource @data_path
  @data_source (case File.read(@data_path) do
                  {:ok, s} -> s
                  _ -> "{}"
                end)

  @doc """
  The parsed default-layout data (`%{"body-constraints" => .., "pane-modules" =>
  ..}`), loaded from `priv/tui/default_layout.ptc` and memoized in
  `:persistent_term`. A missing/malformed file yields `%{}` — every consumer
  (`body_constraints/1`, `pane_modules/0`) falls back to its compiled default
  per-key (never-brick: last-good -> native default -> surfaced error never
  applies here since there is no error surface on a layout read).
  """
  @spec data() :: map()
  def data do
    case :persistent_term.get({__MODULE__, :data}, :unset) do
      :unset ->
        d = build_data()
        :persistent_term.put({__MODULE__, :data}, d)
        d

      d ->
        d
    end
  end

  @doc "Rebuild the memoized data from the current file on disk (test hook / runtime-edit pickup)."
  @spec reload() :: map()
  def reload do
    d = build_data()
    :persistent_term.put({__MODULE__, :data}, d)
    d
  end

  defp build_data do
    source =
      case File.read(@data_path) do
        {:ok, s} -> s
        _ -> @data_source
      end

    parse_data(source)
  end

  # Parse the default_layout.ptc data map via the sandboxed PTC evaluator (the
  # same posture as `Hist.Effect.parse_classes/1`). Any failure -> %{}, so every
  # key falls back to its compiled default — a broken data file never bricks
  # boot or render.
  defp parse_data(source) when is_binary(source) do
    case PtcRunner.Lisp.run(source, max_heap: 2_000_000) do
      {:ok, %{return: map}} when is_map(map) -> stringify(map)
      {:ok, map} when is_map(map) -> stringify(map)
      _ -> %{}
    end
  rescue
    _ -> %{}
  catch
    _, _ -> %{}
  end

  defp parse_data(_), do: %{}

  # String-key the outer + nested maps; list values pass through unchanged.
  defp stringify(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), stringify_value(v)} end)
  rescue
    _ -> %{}
  end

  defp stringify_value(v) when is_map(v), do: stringify(v)
  defp stringify_value(v), do: v

  defp body_constraints_data, do: Map.get(data(), "body-constraints", %{})

  # Resolve the data file's pane-module name strings (`"Elixir.…"`) to atoms via
  # `String.to_existing_atom/1` — NEVER interns a new atom (atom-table-DoS
  # chokepoint discipline, mirrors `PaneRegistry`); an unknown/typo'd module
  # name simply misses and the slot falls back to the compiled dispatch.
  defp pane_modules do
    data()
    |> Map.get("pane-modules", %{})
    |> Map.new(fn {slot, mod_name} -> {slot, safe_module_atom(mod_name)} end)
  end

  defp safe_module_atom(name) when is_binary(name) do
    String.to_existing_atom(name)
  rescue
    ArgumentError -> nil
  end

  defp safe_module_atom(_), do: nil

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

  @doc "The pane module a `pane/*` slot delegates to (App render dispatch); registry-backed with compiled-fallback (never-brick)."
  @spec pane_module(String.t()) :: module() | nil
  def pane_module(slot) when is_binary(slot) do
    case Map.get(pane_modules(), slot) do
      mod when is_atom(mod) and not is_nil(mod) -> mod
      _ -> fallback_pane_module(slot)
    end
  end

  def pane_module(_), do: nil

  defp fallback_pane_module("history"), do: History
  defp fallback_pane_module("tree"), do: SpanTree
  defp fallback_pane_module("detail"), do: Detail
  defp fallback_pane_module(_), do: nil

  # ---- slot nodes ----

  # A deferred hole referencing a single `data/<key>` (PLAN-012 W5 dogfood). Equal
  # to what `(tmpl:: … ~data/<key> …)` freezes for that ref — the codec encoding of
  # the `data/<key>` symbol — but written directly so the default layout needs no
  # runtime parse. The HoleResolver thaws + evaluates it against the data/* bag.
  defp hole(ref), do: %{"__hole__" => %{"node" => "sym", "value" => ref}}

  # ---- presentation derivation as data (PLAN-027 M3, FUP-038) ----
  #
  # The status label+color and composer text+title+fg USED to be derived in
  # Elixir (`DataBag.status_presentation/composer_presentation`) — the body
  # choosing the words the human reads and the colors they see. M3 moves that
  # DERIVATION to data: each is a PTC source string in `default_layout.ptc`
  # under `"presentation"`, frozen into a layout hole here at build time. An
  # edit to the data file changes the wording/colors with no recompile; a
  # missing/malformed entry falls back to the compiled `@fallback_presentation`
  # floor (the original literal source), so the strip never bricks.

  # The compiled floor: the ORIGINAL derivation logic as PTC source, byte-for-
  # byte equivalent to the retired Elixir `*_presentation` functions. Used when
  # the data file lacks a key or is malformed — never-brick.
  @fallback_presentation %{
    "status-label" =>
      ~s|(let [s data/status r (get s "result")] (cond (get s "running?") (str "\u25cf running\u2026  turns " (get s "turns") " \u00b7 tools " (get s "tools")) (= r "error") (str "\u2717 failed  turns " (get s "turns") " \u00b7 tools " (get s "tools")) (not (= r nil)) (str "\u2713 done  turns " (get s "turns") " \u00b7 tools " (get s "tools")) :else "idle \u2014 type a prompt below, then \u21b5"))|,
    "status-color" =>
      ~s|(let [s data/status r (get s "result")] (cond (get s "running?") "yellow" (= r "error") "red" (not (= r nil)) "green" :else "dark_gray"))|,
    "composer-text" =>
      ~s|(let [c data/composer insert (= (get data/ui "mode") "insert")] (cond insert (str c "\u258e") (not (= c "")) c :else data/composer-hint))|,
    "composer-title" =>
      ~s|(if (= (get data/ui "mode") "insert") " prompt \u2014 INSERT " " prompt \u2014 NORMAL ")|,
    "composer-fg" =>
      ~s|(if (or (= (get data/ui "mode") "insert") (not (= data/composer ""))) "white" "dark_gray")|
  }

  # The presentation-derivation source for `key`: the data file's entry, or the
  # compiled floor. A non-binary/empty data entry falls back (never-brick).
  defp presentation_source(key) do
    case data() |> Map.get("presentation", %{}) |> Map.get(key) do
      src when is_binary(src) and src != "" -> src
      _ -> Map.fetch!(@fallback_presentation, key)
    end
  end

  # Freeze a PTC source string into a layout hole (the general form of `hole/1`,
  # which only encodes a bare `data/<key>` symbol). Parse the source to a form
  # and encode it as QuoteData the `HoleResolver` thaws + evaluates against the
  # data/* bag every frame. A parse failure falls back to the compiled floor for
  # `key`; if even THAT fails to parse, degrade to a plain `data/<key>` symbol
  # ref (the old behavior) so the strip still renders SOMETHING — never a brick.
  defp presentation_hole(key) do
    case freeze_source(presentation_source(key)) do
      {:ok, frozen} ->
        %{"__hole__" => frozen}

      :error ->
        case freeze_source(Map.fetch!(@fallback_presentation, key)) do
          {:ok, frozen} -> %{"__hole__" => frozen}
          :error -> hole("data/#{key}")
        end
    end
  end

  defp freeze_source(source) when is_binary(source) do
    case Parser.parse(source) do
      {:ok, form} -> {:ok, QuoteData.to_data(form)}
      _ -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  # The status strip as DATA (W5 dogfood): its dynamic text + color are holes over
  # the data/* bag's presentation keys, so the App no longer fills it from a
  # hardcoded `status_widget`. The block frame is static.
  defp status_node do
    %{
      "type" => "paragraph",
      "slot" => "status",
      "text" => presentation_hole("status-label"),
      "style" => %{"fg" => presentation_hole("status-color"), "modifiers" => ["bold"]},
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

  # Preserve the hand-tuned native column widths for the known arrangements
  # (data-backed, PLAN-025 W3, FEAT-040 — see `priv/tui/default_layout.ptc`);
  # any other pane set splits evenly (fill 1 each). A missing/malformed data
  # entry for a known arrangement falls back to the compiled constant
  # (never-brick).
  defp body_constraints(names) when is_list(names) do
    key = Enum.join(names, ",")

    case Map.get(body_constraints_data(), key) do
      list when is_list(list) and list != [] -> list
      _ -> fallback_body_constraints(names)
    end
  end

  defp fallback_body_constraints(["history", "tree", "detail"]),
    do: [["percentage", 34], ["percentage", 30], ["percentage", 36]]

  defp fallback_body_constraints(["tree", "detail"]),
    do: [["percentage", 45], ["percentage", 55]]

  defp fallback_body_constraints(names), do: Enum.map(names, fn _ -> ["fill", 1] end)

  # The composer as DATA (W5 dogfood): text, fg, and the modal block title are
  # holes over the data/* bag, so the App no longer fills it from a hardcoded
  # `composer_widget`. The block frame (borders/type) is static; only the title
  # is dynamic (INSERT/NORMAL), so it is a hole.
  defp composer_node do
    %{
      "type" => "paragraph",
      "slot" => "composer",
      "text" => presentation_hole("composer-text"),
      "style" => %{"fg" => presentation_hole("composer-fg")},
      "block" => %{
        "type" => "block",
        "title" => presentation_hole("composer-title"),
        "borders" => ["all"],
        "border_type" => "rounded"
      }
    }
  end

  # A native pane node: carries which module renders it + the gaze tags for its
  # slot (focused/cursor/scroll), seeded from the starting gaze. Native "pane"
  # nodes are focusable BY DEFAULT (Lens.focusable?/1 — PLAN-024 Wave 1); no
  # explicit tag is needed here. (A prior top-level "focusable" => true key was
  # dead — Lens.focusable?/1 reads the flag from `tags`, not the node's top
  # level — and is removed rather than relocated, since the pane-default
  # already covers this case.)
  defp pane_node(name, %Ui{} = ui) do
    pane_atom = Ui.safe_pane(name)

    %{
      "type" => "pane",
      "slot" => name,
      "pane" => name,
      "tags" => Lens.pane_tags(ui, pane_atom)
    }
  end
end
