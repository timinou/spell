defmodule SpellAgent.Mesh do
  @moduledoc """
  Front door to the agent mesh (PROJ-006) — the stigmergic-blackboard coordination
  substrate over which sessions cooperate WITHOUT messaging each other.

  Mirrors `SpellAgent.Hist`'s facade role: it closes over a `Hist.Store` impl and
  hands callers the `black/*` PTC-Lisp verb map for a region, so `Session.run/2`
  merges mesh verbs the same way it merges `Hist.verbs/2`.

  Full design: `docs/agent-mesh-theory/` (00-08). This module is the v0 aperture:
  the four monotone verbs (post/query/claim/fold) over `SpellAgent.Mesh.Store`.
  `watch`/`decide` are stubbed until FEAT-013/012.
  """

  alias SpellAgent.Hist
  alias SpellAgent.Mesh.Namespace

  @doc """
  The `black/*` tool map for `session_id` coordinating in a `region`.

  Options:
    * `:region` — REQUIRED; the region this session writes/reads.
    * `:store`  — the `Hist.Store` impl (default: `Hist.default_store/0`).
    * `:held`   — the session's write-capability set (default `[region]`).

  Returns `%{}` when no `:region` is given (a plain session merges no mesh verbs),
  so the wiring in `Session.run/2` is unconditional and safe.
  """
  @spec verbs(String.t(), keyword()) :: %{optional(String.t()) => (map() -> term())}
  def verbs(session_id, opts \\ []) when is_binary(session_id) do
    case opts[:region] do
      region when is_binary(region) ->
        impl = opts[:store] || Hist.default_store()
        Namespace.tools(impl, session_id, region, held: opts[:held] || [region])

      _ ->
        %{}
    end
  end
end
