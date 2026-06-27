defmodule SpellAgent.Code.Prelude do
  @moduledoc """
  The compiled `q/*` structural-transform prelude (PLAN-020 W7).

  `q.clj` is the shared structural algebra over `form_tree` (q/match, q/equal?,
  q/update, q/apply-ops, q/body, …). For the agent to USE it — and for a durable
  codemod authored via `define-tool` to call `q/*` — the compiled prelude must be
  attached wherever PTC runs: the main SubAgent loop AND every `:ptc` tool body.

  This module compiles `priv/preludes/q.clj` ONCE (at compile time the source is
  read via `@external_resource`; the compiled artifact is built lazily on first
  use and cached in `:persistent_term`), mirroring `Hist.Lens`'s lens-source
  loader. `compiled/0` returns the `%PtcRunner.Lisp.Prelude{}` to pass as
  `runtime_prelude:` / `prelude:`.

  Degrades safely: if the prelude fails to compile (it should not — it ships with
  the app), `compiled/0` returns `nil` and callers run without `q/*` rather than
  crashing the agent (the never-brick-the-surface rule).
  """

  @q_path Path.join([:code.priv_dir(:spell_agent) |> to_string(), "preludes", "q.clj"])
  @external_resource @q_path
  @q_source File.read!(@q_path)

  @doc "The raw q.clj source (for tests / inspection)."
  @spec source() :: String.t()
  def source, do: @q_source

  @doc """
  The compiled `q/*` prelude artifact, cached in `:persistent_term`. Returns the
  `%PtcRunner.Lisp.Prelude{}` or `nil` if compilation failed (best-effort).
  """
  @spec compiled() :: PtcRunner.Lisp.Prelude.t() | nil
  def compiled do
    case :persistent_term.get({__MODULE__, :compiled}, :unset) do
      :unset ->
        result =
          case PtcRunner.Lisp.Prelude.Compiler.compile(@q_source) do
            {:ok, prelude} -> prelude
            {:error, _} -> nil
          end

        :persistent_term.put({__MODULE__, :compiled}, result)
        result

      cached ->
        cached
    end
  end
end
