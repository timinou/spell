defmodule Mix.Tasks.Spell.Sessions do
  @shortdoc "List sessions (open & past) and read their traces"

  @moduledoc """
  Browse spell sessions and read their traces (PLAN-010).

  Three modes:

      mix spell.sessions               # interactive TUI browser (list + trace)
      mix spell.sessions --list        # print the session list to stdout, exit
      mix spell.sessions --trace ID    # print one session's trace to stdout, exit

  The TUI browser is a two-pane reader: LEFT the session index (open sessions —
  running now — and past recorded ones), RIGHT the trace of the highlighted
  session, each turn drillable into its execution interior. `j/k` move, `l`/`↵`
  open/expand, `h` collapse/back, `tab` switch panes, `r` refresh, `esc`/`q` quit.

  Like `mix spell.tui` / `mix spell.gallery`, the interactive mode is a dedicated
  task (not `iex -S mix`) because the app takes over stdin/stdout and iex would
  corrupt the display (BUG-489). The `--list` / `--trace` modes are plain stdout
  and safe anywhere.

  The listing reflects the configured `Hist` store: `Store.Memory` (default,
  per-BEAM-sitting) or `Store.Khepri` (durable) when configured. Open sessions
  come from `SpellAgent.SessionRegistry`.
  """

  use Mix.Task

  alias SpellAgent.Hist
  alias SpellAgent.Tui.{SessionBrowser, SessionView}

  @requirements ["app.start"]

  @switches [list: :boolean, trace: :string]

  @impl Mix.Task
  def run(args) do
    {opts, _rest, _invalid} = OptionParser.parse(args, switches: @switches)

    cond do
      opts[:list] -> print_list()
      is_binary(opts[:trace]) -> print_trace(opts[:trace])
      true -> browse()
    end
  end

  # ---- plain-text modes ----

  defp print_list do
    Hist.session_list()
    |> SessionView.list_lines()
    |> SessionView.to_text()
    |> Mix.shell().info()
  end

  defp print_trace(session_id) do
    store = Hist.default_store()
    rows = Hist.Trace.rows(store, session_id)

    # Plain-text trace shows EVERY turn's interior inline (no interactive
    # collapse), so the dump is complete: build the interiors map for all nodes.
    interiors =
      rows
      |> Enum.filter(& &1.has_interior?)
      |> Map.new(fn row -> {row.node_id, Hist.Trace.interior_of(store, session_id, row.node_id)} end)

    header = "trace · #{session_id}  (#{length(rows)} turns)"

    body =
      rows
      |> SessionView.trace_lines(interiors)
      |> SessionView.to_text()

    Mix.shell().info(header <> "\n" <> body)
  end

  # ---- interactive browser ----

  defp browse do
    {:ok, pid} = SessionBrowser.start_link(name: nil)
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end
  end
end
