defmodule Mix.Tasks.Spell.Codemod do
  @shortdoc "Preview a lispy code/edit codemod — before, ops-as-data, after, verdict"

  @moduledoc """
  Inspect the lispy code/edit surface (PLAN-020, PLAN-022 S2) as plain stdout.

  A codemod is `code/parse -> q/apply-ops (reified data ops) -> code/unparse`. This
  task runs one over a fixture or a real file WITHOUT writing it, and prints the
  four facets a reader wants:

      BEFORE   the source as parsed
      OPS      the transform AS DATA (the reifiable op-list — the PLAN-018 currency)
      AFTER    the rewritten source
      VERDICT  whether the result re-parses clean (the W5 safety gate)

  Modes (all stdout, no network, no write):

      mix spell.codemod                          # the built-in demo (rename x -> y)
      mix spell.codemod --from x --to y          # rename over the built-in demo source
      mix spell.codemod --file PATH --from x --to y   # rename an identifier in a file
      mix spell.codemod --file PATH --from x --to y --lang elixir   # force the grammar

  `--from`/`--to` rename an IDENTIFIER (the canonical structural rewrite); `--lang`
  overrides the path-inferred grammar. With `--file`, the file is READ but never
  written — this is a preview. The rendering comes from `SpellAgent.Code.CodemodView`,
  the same pure formatter a future TUI pane would share (the `mix spell.mesh`
  pattern), so the stdout and any pane can never drift.
  """

  use Mix.Task

  alias SpellAgent.Code
  alias SpellAgent.Code.CodemodView

  @requirements ["app.start"]

  @switches [file: :string, from: :string, to: :string, lang: :string]

  # The built-in demo source + label — a tiny Elixir snippet the default mode
  # rewrites so the task is meaningful with zero arguments.
  @demo_src "def add(x), do: x + 1\n"
  @demo_path "(demo)"
  @demo_lang "elixir"

  @impl Mix.Task
  def run(args) do
    {opts, _rest, _invalid} = OptionParser.parse(args, switches: @switches)

    from = opts[:from] || "x"
    to = opts[:to] || "y"

    {path, src, lang} = resolve_source(opts)

    ops = rename_ops(from, to)
    result = Code.dry_run_ops(src, lang, ops)

    path
    |> CodemodView.report_text(result)
    |> Mix.shell().info()
  end

  # Read the target source: an explicit --file (read, never written), else the
  # built-in demo. Lang is the explicit --lang, else inferred from the path.
  defp resolve_source(opts) do
    case opts[:file] do
      path when is_binary(path) ->
        src = File.read!(path)
        lang = opts[:lang] || Code.language_for_path!(path)
        {path, src, lang}

      _ ->
        {@demo_path, @demo_src, opts[:lang] || @demo_lang}
    end
  end

  # The rename-identifier op as a reified data op-list (exactly the shape an agent
  # builds via q/rename-id and hands to code-apply) — one structural update over
  # every identifier node whose value is `from`.
  defp rename_ops(from, to) do
    [
      %{
        "op" => "update",
        "pattern" => %{"node" => "identifier", "value" => from},
        "template" => %{"node" => "identifier", "value" => to}
      }
    ]
  end
end
