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
  Classify a NODE by the most-dangerous effect across its REALIZED tool calls.

  Reads the node's `sees` (the actual calls it ran, with realized argv) and runs
  each through `classify/1` — the SAME hardened classifier the W4 reducer uses, so
  the mutating-predicate detection (find -delete), the most-dangerous-stage pipe
  rule, and the conservative :unknown default all apply uniformly. A node is
  classified by `most_dangerous/1` over its sees' classes; a node that ran NO tool
  call (pure computation) is :unknown.

  Why `sees`, not the form AST: the realized call carries the actual argv (so a
  computed/dynamic shell head is concrete, not unparseable), and reusing
  `classify/1` means there is ONE classifier, not a second, laxer one (the S6
  swarm found the form-based variant under-detected mutations and unknowns).
  """
  @spec classify_node([map()]) :: class()
  def classify_node(sees) when is_list(sees) do
    case sees do
      [] -> :unknown
      _ -> sees |> Enum.map(&classify/1) |> most_dangerous()
    end
  end

  def classify_node(_), do: :unknown

  @doc """
  Whether a node's RESULT is restorable — reproducible by re-running, so it is safe
  to spill to a re-fetchable stub (W6). ONLY a pure-`:read` node qualifies: every
  realized call is a read (idempotent + reproducible). A mutation, external,
  check, or unknown effect makes it non-restorable.

  `:check` is deliberately EXCLUDED (unlike a first instinct): a test/lint run is
  NOT reproducible byte-for-byte (flaky tests, timing, nondeterministic output),
  so spilling its result to a re-fetchable stub could recover different bytes.
  Only a read is safely restorable (S6 swarm finding).
  """
  @spec restorable_node?([map()]) :: boolean()
  def restorable_node?(sees), do: classify_node(sees) == :read

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
