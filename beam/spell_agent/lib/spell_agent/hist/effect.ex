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

  # FEAT-037: the classification TABLES are POLICY, loaded from
  # priv/hist/reducers/effect_classes.ptc (rewritable data). The compiled @*
  # constants below are the FALLBACK — used verbatim when the data file is
  # missing/malformed (never-brick), and as the default the loaded data supersedes.
  # The COMBINING RULES (peel a wrapper, most-dangerous pipe stage, synthetic
  # mutating-predicate head) stay compiled: they are mechanism, not policy.
  @read_tools ~w(find grep grep-n code-parse list-tools hist/env hist/messages)
  @mutation_tools ~w(edit write code-edit code-apply define-tool define-config)

  # Shell command heads, by class. Conservative: an unlisted head is :unknown.
  # Heads that READ when invoked plainly. `sed`/`awk` are reads UNLESS they carry
  # an in-place flag (handled as a mutating predicate below). `env` is NOT here:
  # it is a wrapper whose real effect is the command it runs, peeled before
  # classification (L2 finding).
  @read_heads ~w(cat rg grep ls find head tail wc sed awk sort uniq cut tr echo pwd stat file dirname basename realpath which printenv)

  # Wrapper commands whose effect is the WRAPPED command, not themselves: peel the
  # leading wrapper (+ its assignments/flags) and classify the inner head (L2
  # finding: `env MIX_ENV=test mix test` is a :check, `env rm f` a :mutation).
  @wrapper_heads ~w(env nice nohup timeout xargs sudo doas stdbuf time)
  @check_heads ~w(mix cargo npm bun pytest eslint clippy rustc tsc dialyzer credo)
  @external_heads ~w(curl wget date random uuidgen ssh ping nc dig host)
  @mutation_heads ~w(rm mkdir mv cp touch chmod chown ln tee dd truncate)

  # The compiled fallback table set (name/key => the default list). Superseded
  # per-key by the data file when it provides that key.
  @fallback_tables %{
    "read-tools" => @read_tools,
    "mutation-tools" => @mutation_tools,
    "read-heads" => @read_heads,
    "wrapper-heads" => @wrapper_heads,
    "check-heads" => @check_heads,
    "external-heads" => @external_heads,
    "mutation-heads" => @mutation_heads
  }

  @classes_path Path.join([
                  :code.priv_dir(:spell_agent) |> to_string(),
                  "hist",
                  "reducers",
                  "effect_classes.ptc"
                ])
  @external_resource @classes_path
  @classes_source File.read!(@classes_path)

  @type class :: :read | :mutation | :check | :external | :unknown

  @doc false
  # The effect-class tables (key => MapSet of names), loaded from the .ptc data
  # (superseding the compiled fallback per key) and memoized in :persistent_term.
  # A missing/malformed data file degrades to the compiled fallback so
  # classification never breaks (never-brick). Parsing failures per-key keep that
  # key's fallback.
  @spec tables() :: %{optional(String.t()) => MapSet.t(String.t())}
  def tables do
    case :persistent_term.get({__MODULE__, :tables}, :unset) do
      :unset ->
        t = build_tables()
        :persistent_term.put({__MODULE__, :tables}, t)
        t

      t ->
        t
    end
  end

  # Rebuild the memoized tables from the current data file (test hook: after a
  # runtime edit, call to pick up the change). Returns the fresh table set.
  @doc false
  def reload_tables do
    t = build_tables()
    :persistent_term.put({__MODULE__, :tables}, t)
    t
  end

  defp build_tables do
    # Re-READ the data file at runtime (review S2): the compiled @classes_source is
    # only the boot default; a runtime edit + reload_tables/0 must pick up the new
    # file. Falls back to the compiled source if the file is unreadable now.
    source =
      case File.read(@classes_path) do
        {:ok, s} -> s
        _ -> @classes_source
      end

    loaded = parse_classes(source)

    Map.new(@fallback_tables, fn {key, fallback} ->
      names =
        case Map.get(loaded, key) do
          list when is_list(list) and list != [] -> list
          _ -> fallback
        end

      {key, MapSet.new(names)}
    end)
  end

  # Parse the effect_classes.ptc data map (key-string => list-of-strings). Uses
  # the sandboxed PTC evaluator on the pure data literal; any failure returns %{}
  # so every key falls back to its compiled default.
  defp parse_classes(source) when is_binary(source) do
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

  # Normalize a decoded map to string-keyed lists-of-strings.
  defp stringify(map) do
    Map.new(map, fn {k, v} ->
      {to_string(k), Enum.map(List.wrap(v), &to_string/1)}
    end)
  rescue
    _ -> %{}
  end

  defp member?(key, name), do: MapSet.member?(Map.get(tables(), key, MapSet.new()), name)

  @doc """
  Classify a realized `sees` tool-call entry (`%{name, args, ...}`, atom- or
  string-keyed) into its effect class.
  """
  @spec classify(map()) :: class()
  def classify(see) when is_map(see) do
    name = see |> get(:name) |> to_string()

    cond do
      name in ["sh", "sh-pipe"] -> classify_shell(see)
      member?("read-tools", name) -> :read
      member?("mutation-tools", name) -> :mutation
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
      member?("external-heads", head) -> :external
      member?("mutation-heads", head) -> :mutation
      member?("check-heads", head) -> :check
      member?("read-heads", head) -> :read
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

  # The head(s) of one argv vector. Three refinements (all L2-hardened):
  #   * a WRAPPER head (env/nice/sudo/...) is peeled — classify the command it
  #     runs, not the wrapper, by recursing on the remaining argv past the
  #     wrapper's VAR=val assignments and flags;
  #   * a mutating predicate (-delete, sed -i, >, tee) adds a synthetic "rm" head
  #     so the call classifies :mutation;
  #   * a bare read head returns itself.
  defp argv_heads([h | rest]) when is_binary(h) do
    cond do
      member?("wrapper-heads", h) ->
        # peel the wrapper + its assignments/flags, classify the inner command.
        case strip_wrapper_args(rest) do
          [] -> [h]
          inner -> argv_heads(inner)
        end

      Enum.any?(rest, &universal_mutating_predicate?/1) or in_place_edit?(h, rest) ->
        [h, "rm"]

      true ->
        [h]
    end
  end

  defp argv_heads(_), do: []

  # Drop a wrapper's leading `VAR=val` assignments and `-flags` to reach the inner
  # command head (`env MIX_ENV=test mix test` -> `mix test`).
  defp strip_wrapper_args(args) do
    Enum.drop_while(args, fn a ->
      is_binary(a) and (String.contains?(a, "=") or String.starts_with?(a, "-"))
    end)
  end

  # Flags/predicates that turn an otherwise-read command into a MUTATION: find's
  # -delete/-exec, an in-place sed/awk edit (-i / --in-place / -i.bak), a redirect,
  # or a tee. Presence of any makes the call classify :mutation (L2 finding).
  # Head-INDEPENDENT mutating predicates: find's -delete/-exec, a redirect, a tee.
  # These mutate regardless of the command.
  @mutating_predicates ~w(-delete -exec -execdir -fprint -fprintf > >> | tee)
  defp universal_mutating_predicate?(arg) when is_binary(arg), do: arg in @mutating_predicates
  defp universal_mutating_predicate?(_), do: false

  # Commands whose -i flag means EDIT-IN-PLACE (a mutation). For other heads (grep
  # -i case-insensitive, ls -i inode) -i is harmless, so in-place detection is
  # head-specific (L2 re-review: do not flag `grep -i` as a mutation).
  @in_place_heads ~w(sed awk perl gawk)
  defp in_place_edit?(head, args) do
    head in @in_place_heads and Enum.any?(args, &in_place_flag?/1)
  end

  # The in-place flag in any spelling: --in-place[=...], -i, -i.bak, -ibak, or a
  # short-flag cluster containing i (-Ei, -nri). Conservative for the sed-family.
  defp in_place_flag?("--in-place" <> _), do: true

  defp in_place_flag?("-" <> rest) when rest != "" do
    not String.starts_with?(rest, "-") and
      (rest |> String.split(".", parts: 2) |> hd() |> String.contains?("i"))
  end

  defp in_place_flag?(_), do: false

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
