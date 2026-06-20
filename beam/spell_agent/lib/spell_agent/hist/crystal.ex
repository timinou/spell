defmodule SpellAgent.Hist.Crystal do
  @moduledoc """
  A crystallized slice of history — episodic session log distilled into semantic,
  long-term memory (PLAN-001, C2).

  This is the transform that makes the substrate worth building: a successful
  multi-turn investigation (a slice of nodes that *worked*) is compiled — via
  `PtcRunner.SubAgent.compile/2` → `CompiledAgent` — into a single deterministic
  PTC-Lisp program that reproduces the outcome with NO further LLM calls. Lived
  experience becomes a reusable, LLM-free tool.

  Stored as data (`source` + `signature` + provenance), NOT as the live
  `CompiledAgent` — the `execute` closure is rebuilt from `source` on load (the
  only non-serializable field a CompiledAgent has).

  `origin.nodes` is the provenance chain back to the turns it was distilled from,
  so a crystal expands back to its evidence (the `DISTILLED_FROM` lineage).
  """

  @type t :: %__MODULE__{
          id: String.t(),
          name: String.t(),
          signature: String.t() | nil,
          source: String.t(),
          origin: %{session: String.t(), nodes: [String.t()]} | nil,
          metadata: %{
            compiled_at: String.t() | nil,
            tokens_used: non_neg_integer(),
            turns: non_neg_integer(),
            llm_model: String.t() | nil
          },
          t: integer()
        }

  @enforce_keys [:id, :name, :source]
  defstruct id: nil,
            name: nil,
            signature: nil,
            source: nil,
            origin: nil,
            metadata: %{compiled_at: nil, tokens_used: 0, turns: 0, llm_model: nil},
            t: 0
end
