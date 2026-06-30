defmodule SpellAgent.Hist.Effect do
  @moduledoc """
  Classify a realized tool call's EFFECT CLASS (PLAN-018 W4).

  Reducibility is a function of a call's effect, NOT its token size: a read can be
  CSE'd and stale-collapsed (it re-runs to the same answer and is restorable); a
  mutation, check, or external call cannot be treated as an idempotent read.

  | class      | examples                | idempotent | safe to stale-collapse |
  |------------|-------------------------|------------|------------------------|
  | `:read`    | cat, grep, ls, find     | yes        | YES                    |
  | `:mutation`| edit, write, rm, mkdir  | no         | no                     |
  | `:check`   | mix test, cargo, lint   | no (light) | no                     |
  | `:external`| curl, date, random      | no         | NEVER (no path back)   |
  | `:unknown` | anything unclassified   | unknown    | no (conservative)      |

  The classifier is intentionally CONSERVATIVE: only calls it can positively
  identify as `:read` are treated as collapsible. Everything it is unsure about is
  `:unknown`, which the reducer treats as non-collapsible. A wrong `:read` would
  drop a load-bearing distinct result (a lossless violation); a wrong `:unknown`
  only forgoes a reduction. We err toward keeping data.

  ## How a call is classified

    1. The tool NAME. Native read tools (`find`, `code-parse`) are `:read`;
       mutation tools (`edit`, `code-edit`, `code-apply`, `write`) are `:mutation`.
    2. For `sh` / `sh-pipe`, the underlying COMMAND HEAD (everything in this agent
       is a shell composition): `cat`/`rg`/`ls`/... -> `:read`; `mix test`/`cargo`
       -> `:check`; `curl`/`date` -> `:external`; `rm`/`>` -> `:mutation`. The head
       is read from the recorded call's `args` (the realized `:argv`), since a
       `sees` entry carries the args it ran with.

  This mirrors the substrate `hist/forms {:shell head}` already projects (the same
  head -> class mapping), so the effect classifier is that projection with a
  verdict attached.
  """

  @read_tools ~w(find grep grep-n code-parse list-tools hist/env hist/messages)
  @mutation_tools ~w(edit write code-edit code-apply define-tool define-config)

  # Shell command heads, by class. Conservative: an unlisted head is :unknown.
  @read_heads ~w(cat rg grep ls find head tail wc sed awk sort uniq cut tr echo pwd stat file dirname basename realpath which env printenv date_unused)
  @check_heads ~w(mix cargo npm bun pytest eslint clippy rustc tsc dialyzer credo)
  @external_heads ~w(curl wget date random uuidgen ssh ping nc dig host)
  @mutation_heads ~w(rm mkdir mv cp touch chmod chown ln tee dd truncate)

  @type class :: :read | :mutation | :check | :external | :unknown

  @doc """
  Classify a realized `sees` tool-call entry (`%{name, args, ...}`, atom- or
  string-keyed) into its effect class.
  """
  @spec classify(map()) :: class()
  def classify(see) when is_map(see) do
    name = see |> get(:name) |> to_string()

    cond do
      name in ["sh", "sh-pipe"] -> classify_shell(see)
      name in @read_tools -> :read
      name in @mutation_tools -> :mutation
      true -> :unknown
    end
  end

  def classify(_), do: :unknown

  @doc "Whether a call is safe to treat as an idempotent, restorable read."
  @spec read?(map()) :: boolean()
  def read?(see), do: classify(see) == :read

  @doc """
  Classify a NODE's program (its `form`) by its most-dangerous effect.

  Unlike `classify/1` (one realized `sees` entry), this reads the whole program
  AST: every shell command head (`Lens.shell_heads/1`) and every native tool call
  (`Lens.tool_call_names/1`). A program is :read only if EVERY effect it performs
  is a read; any mutation/check/external/unknown effect dominates. Used by W6's
  result-spill to decide RESTORABILITY — only a `:read` (or `:check`) program's
  output is reproducible, so only its result may be spilled to a re-fetchable stub.
  """
  @spec classify_program(term()) :: class()
  def classify_program(form) do
    shell_classes = form |> SpellAgent.Hist.Lens.shell_heads() |> Enum.map(&head_class/1)

    # The non-shell native tool calls. `sh`/`sh-pipe` are EXCLUDED here — they are
    # shell wrappers already classified by their command head (shell_classes
    # above); counting their bare name as an :unknown tool would wrongly dominate
    # a real read program (e.g. `(tool/sh {:argv ["cat" ...]})` would become
    # :unknown instead of :read).
    tool_classes =
      form
      |> SpellAgent.Hist.Lens.tool_call_names()
      |> Enum.reject(&(&1 in ["sh", "sh-pipe"]))
      |> Enum.map(&tool_class/1)

    case shell_classes ++ tool_classes do
      [] -> :unknown
      classes -> most_dangerous(classes)
    end
  end

  @doc """
  Whether a program's RESULT is restorable — reproducible by re-running, so it is
  safe to spill to a re-fetchable stub (W6). A read or check is restorable; a
  mutation, external, or unknown program is NOT (no reproducible path back).
  """
  @spec restorable_program?(term()) :: boolean()
  def restorable_program?(form), do: classify_program(form) in [:read, :check]

  defp tool_class(name) do
    cond do
      name in @read_tools -> :read
      name in @mutation_tools -> :mutation
      true -> :unknown
    end
  end

  # --- shell classification ---------------------------------------------------

  defp head_class(head) do
    cond do
      head in @external_heads -> :external
      head in @mutation_heads -> :mutation
      head in @check_heads -> :check
      head in @read_heads -> :read
      true -> :unknown
    end
  end

  # Classify a shell call by the MOST DANGEROUS class across all its command
  # heads/predicates — a pipeline is only as safe as its least-safe stage. A
  # `cat | tee dst` pipe mutates via `tee`; classifying it by the first head
  # (`cat` -> read) would wrongly collapse a mutation (S4 swarm finding).
  defp classify_shell(see) do
    case shell_heads(get(see, :args)) do
      [] -> :unknown
      heads -> heads |> Enum.map(&head_class/1) |> most_dangerous()
    end
  end

  # Combine stage classes by danger precedence: any external/mutation/check/unknown
  # stage dominates a read. The result is :read ONLY if EVERY stage is a read.
  @danger_order [:external, :mutation, :check, :unknown, :read]
  defp most_dangerous(classes) do
    Enum.find(@danger_order, :unknown, fn c -> c in classes end)
  end

  # Every command head a shell call runs: the argv head (sh) or each stage head
  # (sh-pipe). A `find` with a mutating predicate (-delete / -exec) is reported as
  # an extra "rm" head so it classifies :mutation, not :read.
  defp shell_heads(args) when is_map(args) do
    cond do
      is_list(argv = get(args, :argv)) -> argv_heads(argv)
      is_list(stages = get(args, :stages)) -> Enum.flat_map(stages, &argv_heads/1)
      true -> []
    end
  end

  defp shell_heads(_), do: []

  # The head of one argv vector, plus a synthetic "rm" head when the command
  # carries a mutating predicate (so e.g. `find . -delete` is not a pure read).
  defp argv_heads([h | rest]) when is_binary(h) do
    if Enum.any?(rest, &mutating_predicate?/1), do: [h, "rm"], else: [h]
  end

  defp argv_heads(_), do: []

  @mutating_predicates ~w(-delete -exec -execdir -fprint -fprintf > >> | tee)
  defp mutating_predicate?(arg) when is_binary(arg), do: arg in @mutating_predicates
  defp mutating_predicate?(_), do: false

  # atom- or string-keyed read (never mints an atom). Presence-aware so a key
  # bound to false/nil is not mistaken for absent.
  defp get(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, to_string(key))
    end
  end

  defp get(_map, _key), do: nil
end
