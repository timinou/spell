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

  @doc "Render a view-model to `[{widget, rect}]`."
  @callback view(render_input()) :: [{term(), term()}]

  defmacro __using__(_opts) do
    quote do
      @behaviour SpellAgent.Tui.Pane

      @impl true
      def events, do: []

      @impl true
      def project(_forest, _assigns), do: nil

      defoverridable events: 0, project: 2

      # Sugar: `events [[:turn, :stop]]` as a module attribute-style declaration.
      import SpellAgent.Tui.Pane, only: [events: 1]
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
