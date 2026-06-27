defmodule SpellAgent.Mesh.Combinators do
  @moduledoc """
  The ergonomic mesh combinators (FEAT-018 S-A/S-B) \u2014 `mesh/ask`, `mesh/scatter`,
  `mesh/gather`, `mesh/mesh-map` \u2014 shipped AS PTC-LISP SOURCE, not compiled Elixir.

  These are PURE COMPOSITIONS of the FEAT-011 await-free primitives
  (`spawn-session` + `await-session`), so by the boundary doctrine ("reach for
  data, not code" \u2014 docs/elixir-ptc-boundary.md) they live as `.ptc` files the
  agent can read, copy, and FORK at runtime, exactly like the `hist/*` lenses
  (`SpellAgent.Hist.Lens`). Writing them in Elixir would re-trap policy in compiled
  code the agent cannot reshape \u2014 the anti-pattern the boundary doc warns against.

  ## How they run

  Each verb is a session-merged closure (the same seam as `Mesh.Spawn.verbs/2`)
  that runs its `.ptc` source through the ONE sandbox `PtcRunner.Lisp.run/2`, with:

    * the call's args injected as `data/<key>` (the inject job), and
    * the SESSION's tool map passed as `:tools`, so the combinator body can call
      `(tool/spawn-session \u2026)` / `(tool/await-session \u2026)` \u2014 the primitives it
      composes. The tools map is threaded in by `Session.run` (it has the live
      spawn verbs); a combinator never rebuilds it.

  A combinator failure is surfaced as `{:error, _}` data, never a crash (best-effort,
  the lens posture).
  """

  # The combinator library, loaded from priv at compile time. Each entry maps a
  # `mesh/<verb>` name to its PTC-Lisp source. @external_resource recompiles this
  # module when a `.ptc` changes; the source ships as DATA (agent-forkable).
  @combinator_dir Path.join([
                    :code.priv_dir(:spell_agent) |> to_string(),
                    "mesh",
                    "combinators"
                  ])

  @combinators %{
    "ask" => "ask.ptc",
    "scatter" => "scatter.ptc",
    "gather" => "gather.ptc",
    "mesh-map" => "mesh-map.ptc"
  }

  for {_name, file} <- @combinators do
    @external_resource Path.join(@combinator_dir, file)
  end

  @sources (for {name, file} <- @combinators, into: %{} do
              {name, File.read!(Path.join(@combinator_dir, file))}
            end)

  @doc "The combinator library: verb name (no `mesh/` prefix) => PTC-Lisp source."
  @spec sources() :: %{optional(String.t()) => String.t()}
  def sources, do: @sources

  @doc """
  Inventory rows for `list-tools` (so the combinators are discoverable).
  """
  @spec inventory() :: [map()]
  def inventory do
    [
      row("mesh/ask", ["prompt", "tools", "region", "inherit-memory"],
        "Spawn a child toward :prompt and await it; returns its result (the 90% " <>
          "synchronous LLM call). Sugar over spawn-session + await-session."),
      row("mesh/scatter", ["items", "prompt", "region", "tools", "inherit-memory"],
        "Fan out: spawn one await-free child per item (shared :prompt prefix + " <>
          ":region); returns the list of handles. Pair with mesh/gather."),
      row("mesh/gather", ["handles"],
        "Fan in: await each handle from scatter, returning the results in order."),
      row("mesh/mesh-map", ["items", "prompt", "region", "tools", "inherit-memory"],
        "scatter + gather fused: spawn a child per item, await all, return results.")
    ]
  end

  defp row(name, params, doc), do: %{"name" => name, "params" => params, "doc" => doc, "kind" => "ptc"}

  @doc """
  The `mesh/*` combinator verbs as a tool map to merge into the agent's tools.

  `tools_fun` is a 0-arity fn returning the SESSION's full tool map (with the live
  spawn verbs) \u2014 lazily called per invocation so the combinator body resolves
  `tool/spawn-session`. Passed by `Session.run`, which holds the assembled map.
  """
  @spec verbs((-> map())) :: %{optional(String.t()) => (map() -> term())}
  def verbs(tools_fun) when is_function(tools_fun, 0) do
    Map.new(@sources, fn {name, source} ->
      {"mesh/" <> name, fn args -> run(source, args || %{}, tools_fun) end}
    end)
  end

  # A combinator BLOCKS on its child missions (await-session waits for a full
  # child Session.run), so its sandbox needs a generous wall-clock budget — far
  # more than the default 1000ms a pure lens uses. Bound it so a runaway combinator
  # still terminates.
  @combinator_timeout_ms 600_000

  # Run a combinator's source through the one sandbox, with the call args as
  # data/<key> and the session tools available so it can call the spawn primitives.
  defp run(source, args, tools_fun) do
    context = stringify_keys(args)

    case PtcRunner.Lisp.run(source,
           context: context,
           # filter_context: false — inject ALL args (mirroring Hist.Lens.run). The
           # default true filters to statically-accessed data/ keys, which drops a
           # hyphenated key like data/inherit-memory, silently nil-ing the arg.
           filter_context: false,
           tools: tools_fun.(),
           timeout: @combinator_timeout_ms,
           caller: :in_process_v1
         ) do
      {:ok, step} -> step.return
      {:error, step} -> %{"err" => inspect(step.fail || step.return || :combinator_failed)}
    end
  rescue
    e -> %{"err" => Exception.message(e)}
  catch
    :exit, reason -> %{"err" => "mesh combinator exit: #{inspect(reason)}"}
  end

  defp stringify_keys(map) when is_map(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)
  defp stringify_keys(other), do: other
end
