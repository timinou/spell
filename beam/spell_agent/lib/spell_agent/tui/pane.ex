defmodule SpellAgent.Tui.Pane do
  @moduledoc """
  The pane contract (PLAN-345) — the one abstraction the whole TUI rests on.

  A pane COLOCATES the PtcRunner traces it reflects with how it renders them:

    * `events/0`   — telemetry suffixes that should WAKE this pane (the dirty
                     filter). e.g. `[[:turn, :stop], [:run, :stop]]`. A pane that
                     declares `[]` is woken on every batch.
    * `project/2`  — the MIRROR: fold the live span forest (a `%{id => Span.t()}`
                     map) plus the App's ui-assigns into a view-model of ANY shape.
                     A transcript folds to a list; an aggregate folds to a number
                     or histogram. Same seam — that is why aggregates need no new
                     construct (PLAN-345 aggregates pressure-test).
    * `view/1`     — render the view-model to ExRatatui widgets. Receives
                     `%{vm, rect, focused?, assigns}` and returns `[{widget, rect}]`.
                     The renderer NEVER branches on pane type; all type-specific
                     behaviour lives here (DjinnUI Surface invariant).

  `use SpellAgent.Tui.Pane` injects default `events/0` (`[]`) and a `project/2`
  passthrough, so a pure-render pane only implements `view/1`.
  """

  alias SpellAgent.Tui.Store.Span

  @typedoc "Telemetry suffix, e.g. `[:turn, :stop]`."
  @type suffix :: [atom()]

  @typedoc "The forest: span_id => Span."
  @type forest :: %{optional(String.t()) => Span.t()}

  @typedoc "Per-pane UI state from the App (cursor, focus, selection, …)."
  @type assigns :: map()

  @typedoc "View-model produced by project/2 — any shape the pane's view/1 expects."
  @type vm :: term()

  @typedoc "Render input handed to view/1."
  @type render_input :: %{
          vm: vm(),
          rect: term(),
          focused?: boolean(),
          assigns: assigns()
        }

  @doc "Telemetry suffixes that wake this pane. `[]` = woken on every batch."
  @callback events() :: [suffix()]

  @doc "Fold the forest (+ ui assigns) into a view-model."
  @callback project(forest(), assigns()) :: vm()

  @doc """
  Incremental projection (PLAN-025 W3, FEAT-038): fold the forest given the
  `dirty_paths` (root-paths of the spans that changed this batch), so a pane may
  recompute only the affected subtrees instead of re-walking the whole forest.

  OPTIONAL and additive: the default (injected by `use Pane`) IGNORES
  `dirty_paths` and delegates to the full `project/2`, so every existing pane is
  unchanged. A pane overrides this only when it has a cheaper incremental path.
  `dirty_paths` of `:all` means "recompute everything" (first mount / navigation).
  """
  @callback project_incremental(forest(), assigns(), [[String.t()]] | :all) :: vm()

  @doc "Render a view-model to `[{widget, rect}]`."
  @callback view(render_input()) :: [{term(), term()}]

  @typedoc "An abstract verb in the app's vocabulary, e.g. `:\"span/expand\"`."
  @type intent :: atom()

  @doc """
  Chord → intent for this pane's context (PLAN-346). The WRITE-mirror's vocabulary:
  which chords this pane SPEAKS, and what abstract verb each names. Declared with
  the `keymap/1` macro; defaults to `[]` (the pane binds nothing of its own, so
  every chord falls through to the global layer).
  """
  @callback keymap() :: [{SpellAgent.Tui.Chord.t(), intent()}]

  @doc """
  Intent → new gaze (PLAN-346) — the REACTION, the dual of `project/2`. A pure
  transform of the App's navigation state given the (read-only) forest, so the
  pane can resolve the cursor's span id, walk descendants, etc. `react/3` clauses
  ARE this pane's reaction vocabulary; an unmatched intent falls to the injected
  identity default (no-op), so a pane only implements the verbs it owns.
  """
  @callback react(intent(), SpellAgent.Tui.Ui.t(), forest()) :: SpellAgent.Tui.Ui.t()

  defmacro __using__(_opts) do
    quote do
      @behaviour SpellAgent.Tui.Pane

      @impl true
      def events, do: []

      @impl true
      def project(_forest, _assigns), do: nil

      # FEAT-038: default incremental projection = the full projection. A pane
      # opts into radius-scoped work by overriding this; otherwise it behaves
      # exactly as before (ignore the paths, re-project fully).
      @impl true
      def project_incremental(forest, assigns, _dirty_paths), do: project(forest, assigns)

      @impl true
      def keymap, do: []

      @impl true
      def react(_intent, ui, _forest), do: ui

      defoverridable events: 0, project: 2, project_incremental: 3, keymap: 0, react: 3

      # Sugar: `events [[:turn, :stop]]` and `keymap [{"C-l", :\"span/expand\"}]`
      # as declarative module-level declarations.
      import SpellAgent.Tui.Pane, only: [events: 1, keymap: 1]
    end
  end

  @doc """
  Declare a pane's waking suffixes inline: `events [[:turn, :stop], [:run, :stop]]`.

  Expands to an `events/0` definition.
  """
  defmacro events(suffixes) do
    quote do
      @impl true
      def events, do: unquote(suffixes)
    end
  end

  @doc """
  Declare a pane's keymap inline as chord-STRING → intent pairs:

      keymap [
        {"C-l", :\"span/expand\"},
        {"C-h", :\"span/contract\"},
        {"up",  :\"cursor/prev\"}
      ]

  Each chord string is parsed to a `%Chord{}` AT COMPILE TIME via `Chord.parse/1`,
  so the runtime `keymap/0` returns ready `[{Chord.t(), intent}]` with no per-keystroke
  parsing. Expands to a `keymap/0` definition. The chord/intent split is the first
  axis of the Reaction DSL's two-stage indirection (chord →[keymap]→ intent).
  """
  defmacro keymap(pairs) do
    parsed =
      Enum.map(pairs, fn {chord_str, intent} ->
        chord = SpellAgent.Tui.Chord.parse(chord_str)
        {Macro.escape(chord), intent}
      end)

    quote do
      @impl true
      def keymap, do: unquote(parsed)
    end
  end

  @doc """
  Whether a pane (its `events/0`) should re-project given the suffixes that fired
  this batch. An empty `events/0` means "always".
  """
  @spec dirty?(module(), [suffix()]) :: boolean()
  def dirty?(pane, fired_suffixes) do
    case pane.events() do
      [] -> true
      declared -> Enum.any?(declared, &(&1 in fired_suffixes))
    end
  end
end
