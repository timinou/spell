defmodule SpellAgent.Hist.Result do
  @moduledoc """
  Single source of truth for classifying a tool-call result as ok or error
  (PLAN-001, BUG-001 B5).

  Both `Hist.Query` (status filtering) and `Hist.Tools` (authored-tool error
  counts) must agree on what "errored" means, or promotion/pruning decisions skew
  against the query view. This module is that one classifier; neither caller
  re-implements the heuristic.

  A result is an ERROR when it is:
    * `{:error, _}` — the canonical tuple, OR
    * a map carrying any of the keys `"err"`, `"error"`, `:err`, `:error` — the
      shapes PTC-Lisp tools and `psettled` use for settled failures
      (`{"err" => reason}`) and the conventional error maps.

  Everything else (including a bare value, an `{:ok, _}` tuple, or a normal map
  without an error key) is ok.
  """

  @type status :: :ok | :error

  @doc "Classify a tool-call `result` term as `:ok` or `:error`."
  @spec status(term()) :: status()
  def status({:error, _}), do: :error
  def status(%{"err" => _}), do: :error
  def status(%{"error" => _}), do: :error
  def status(%{err: _}), do: :error
  def status(%{error: _}), do: :error
  def status(_), do: :ok

  @doc "Whether a tool-call `result` term is an error."
  @spec error?(term()) :: boolean()
  def error?(result), do: status(result) == :error
end
