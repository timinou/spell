defmodule SpellAgent.Tui.Panes.History do
  @moduledoc """
  The conversation-history pane (PLAN-003 SEAM 3) — the durable scrollback.

  Where `SpanTree`/`Detail` mirror the LIVE span forest of the current run (and
  are reset each submit), this pane mirrors the DURABLE conversation: every run
  recorded into `SpellAgent.Hist`, reconstituted into a faithful user<->assistant
  transcript. It is what makes the TUI stop being amnesiac — the prior turns are
  present across runs and across an app reopen.

  Unlike the other panes it does NOT fold the span forest; its source of truth is
  the Hist store. `project/2` reads the App-supplied `:hist_session` +
  `:hist_store` from assigns, calls `Hist.resume/2`, and folds the resulting
  `View.messages` into a list view-model. With no session yet (first launch) it
  renders an empty-state line. Pure `(assigns -> vm)` ⇒ unit-testable with an
  injected store.

  As a CONTEXT it owns `context_name/0 = :history`; it reuses Global + TurnNav
  chords (scroll), so it declares no keymap of its own.
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Hist
  alias SpellAgent.Tui.Ui

  @spec context_name() :: :history
  def context_name, do: :history

  # Wake when a turn finishes (a run just recorded new history) — and, because the
  # App reprojects with :all on navigation, the pane also refreshes on scroll.
  @impl true
  def events, do: [[:turn, :stop]]

  @type line :: %{role: :user | :assistant, text: String.t()}
  @type vm :: %{lines: [line()], count: non_neg_integer(), empty?: boolean()}

  @impl true
  def project(_forest, assigns) do
    case resume(assigns) do
      {:ok, %{messages: messages}} -> fold(messages)
      _ -> %{lines: [], count: 0, empty?: true}
    end
  end

  @impl true
  def view(%{vm: vm, rect: rect, assigns: assigns, focused?: focused?}) do
    scroll = (assigns[:ui] && Ui.scroll_of(assigns.ui, :history)) || 0

    [
      {{:history, %{lines: vm.lines, empty?: vm.empty?, scroll: scroll, focused?: focused?}},
       rect}
    ]
  end

  # ---- pure folding ----

  @doc false
  @spec fold([%{role: :user | :assistant, content: String.t()}]) :: vm()
  def fold(messages) when is_list(messages) do
    lines =
      Enum.map(messages, fn %{role: role, content: content} -> %{role: role, text: content} end)

    %{lines: lines, count: length(lines), empty?: lines == []}
  end

  # ---- store access ----

  # The App injects `:hist_session` (the current session id) and optionally
  # `:hist_store` (the store impl, default Hist.default_store/0). No session id
  # means "fresh launch, nothing recorded yet" -> empty state.
  # Reconstitute defensively: a sick/absent store must DEGRADE to the empty state,
  # never crash the render loop. `resume_session_id/1` guards the mount path, but
  # reproject/2 re-enters here on every batch, so the guard lives here too.
  defp resume(assigns) do
    case assigns[:hist_session] do
      sid when is_binary(sid) ->
        store = assigns[:hist_store] || Hist.default_store()

        try do
          Hist.resume(sid, store: store)
        rescue
          _ -> :error
        catch
          _, _ -> :error
        end

      _ ->
        :error
    end
  end
end
