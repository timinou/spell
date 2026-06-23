defmodule SpellAgent.Tui.LayoutRegistry do
  @moduledoc """
  The live, canonical layout TREE (PLAN-009) — the third registry beside
  `ToolRegistry` (tools) and `KeymapRegistry` (keymaps). The render mirror as
  data: the native UI is the DEFAULT tree, and the agent reshapes it by SHADOWING
  a slot.

  ## The tree is the App's canonical state

  Unlike the other registries (which hold overrides consulted at use-time), this
  one holds the WHOLE current tree — the App's render reads it, navigation
  re-tags it (`Lens`), and a slot shadow replaces one named subtree. The gaze
  lives ON the tree as tags, so there is no `%Ui{}` to keep in sync (D1).

  ## Slots + shadowing

  A slot is a named subtree (`"frame"`, `"status"`, `"body"`, `"composer"`, the
  `"pane/*"` nodes). The default tree is seeded once (from
  `SpellAgent.Tui.DefaultLayout`). `set/2` replaces the subtree at a slot with an
  agent-authored node; `show/1` reads a slot's current source; `reset/1` restores
  the default for a slot (or the whole tree).

  ## Failure ladder (Edge B, per slot)

  A slot's authored node is validated by a render PROBE before it is committed: if
  it cannot produce placements, the set is REJECTED and the prior (last-good)
  subtree stays. Since the default subtree is itself render-tested, a slot always
  has SOMETHING valid. (The App's render additionally degrades a node that throws
  at paint time — belt and braces.)

  v0 storage is in-memory (`Agent`), session-scoped — same posture as the sibling
  registries. Durable layouts are FUP-009.
  """

  use Agent

  alias SpellAgent.Tui.{LayoutDiagnostic, Lens}

  @type tree :: %{optional(String.t()) => term()}

  @doc """
  Start the registry. `:default` seeds the canonical tree (the App passes the
  native default from `DefaultLayout.tree/1`); without it, an empty placeholder
  tree is used until `replace/1`.
  """
  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(opts \\ []) do
    default = opts[:default] || %{"type" => "split", "dir" => "vertical", "children" => []}
    identity = pane_identity_of(default)

    Agent.start_link(
      fn -> %{tree: default, default: default, pane_identity: identity} end,
      name: __MODULE__
    )
  end

  @doc "The live canonical tree."
  @spec tree() :: tree()
  def tree, do: Agent.get(__MODULE__, & &1.tree)

  @doc """
  The FROZEN pane identity — the body-pane slot names captured at seed time
  (`["history", "tree", "detail"]` live). This is the STABLE answer to "which pane
  set is this registry for", independent of any later body reshape: the agent may
  replace the whole `body` subtree with a custom widget arrangement, and this
  identity does not move. The render-adoption gate keys on THIS, not on the body's
  mutable children (BUG-012) — a recomputed `body_pane_slots/1` of a reshaped body
  is `[]`, which used to make the live tree silently un-adopt.
  """
  @spec pane_identity() :: [String.t()]
  def pane_identity, do: Agent.get(__MODULE__, & &1.pane_identity)

  @doc """
  The live tree paired with its frozen pane identity, read atomically — the
  render-adoption gate's single read (so the tree and the identity it is judged
  against can never tear across a concurrent reshape).
  """
  @spec tree_with_identity() :: {tree(), [String.t()]}
  def tree_with_identity, do: Agent.get(__MODULE__, fn st -> {st.tree, st.pane_identity} end)

  @doc """
  Replace the WHOLE tree (e.g. the App seeding the native default at mount, or a
  navigation step re-tagging it). No validation — this is the trusted internal
  write path (App / Lens), not the agent surface. Use `set/2` for agent shadows.
  """
  @spec replace(tree()) :: :ok
  def replace(new_tree) when is_map(new_tree) do
    Agent.update(__MODULE__, &%{&1 | tree: new_tree})
  end

  @doc """
  Seed the default tree (and current tree) — used by the App at mount to install
  the native layout as the default both `reset/1` and the failure ladder fall
  back to. Idempotent.
  """
  @spec seed_default(tree()) :: :ok
  def seed_default(default) when is_map(default) do
    identity = pane_identity_of(default)

    Agent.update(__MODULE__, fn st ->
      %{st | tree: default, default: default, pane_identity: identity}
    end)
  end

  @doc """
  Shadow the subtree at `slot` with `node` — the agent-facing reshape. Validated
  by a render probe (the failure ladder): a node that can't lay out is rejected
  and the prior subtree kept.

  Returns `:ok`, or `{:error, reason}` (rejected — last-good preserved).
  """
  @spec set(String.t(), tree()) :: :ok | {:error, term()}
  def set(slot, node) when is_binary(slot) and is_map(node) do
    Agent.get_and_update(__MODULE__, fn st ->
      candidate = put_slot(st.tree, slot, node)

      cond do
        # The registry was never seeded with a real layout (empty placeholder):
        # its frozen pane identity is `[]`, so the App's render-adoption gate can
        # NEVER adopt this tree, and any shadow would be silently discarded every
        # frame. Reject loudly instead of returning a hollow `:ok` the agent would
        # trust (BUG-012 honesty fix B). A live App always seeds the registry at
        # mount, so this only fires in a degraded/unseeded state.
        st.pane_identity == [] ->
          {{:error, {:not_adoptable, slot}}, st}

        not slot_present?(st.tree, slot) ->
          {{:error, {:unknown_slot, slot}}, st}

        true ->
          case LayoutDiagnostic.validate(node) do
            :ok -> {:ok, %{st | tree: candidate}}
            {:error, diagnostic} -> {{:error, {:bad_layout, slot, diagnostic}}, st}
          end
      end
    end)
  end

  @doc """
  Whether the live tree would be ADOPTED by the App's render gate — i.e. its frozen
  pane identity is non-empty (the registry was seeded with a real layout). A `set/2`
  on a non-adoptable registry is futile (the shadow is discarded every frame), so
  `set/2` rejects in that state and this is the honest self-check behind it.

  NB the App also requires the identity to MATCH its own pane set; that
  cross-check lives in the App (which knows its panes). This is the registry-side
  necessary condition.
  """
  @spec adoptable?() :: boolean()
  def adoptable?, do: pane_identity() != []

  @doc "The current source node at `slot`, or `{:error, :unknown_slot}`."
  @spec show(String.t()) :: {:ok, tree()} | {:error, :unknown_slot}
  def show(slot) when is_binary(slot) do
    Agent.get(__MODULE__, fn st ->
      case Lens.at(st.tree, slot) do
        nil -> {:error, :unknown_slot}
        node -> {:ok, node}
      end
    end)
  end

  @doc """
  Reset a slot to its node in the DEFAULT tree, or the whole tree when `slot` is
  nil. Gaze tags on the live tree are preserved across a whole-tree reset by
  folding them back (so resetting visuals doesn't lose your place).
  """
  @spec reset(String.t() | nil) :: :ok | {:error, :unknown_slot}
  def reset(nil) do
    Agent.update(__MODULE__, fn st ->
      ui = Lens.to_ui(st.tree)
      %{st | tree: Lens.from_ui(st.default, ui)}
    end)
  end

  def reset(slot) when is_binary(slot) do
    Agent.get_and_update(__MODULE__, fn st ->
      case Lens.at(st.default, slot) do
        nil -> {{:error, :unknown_slot}, st}
        default_node -> {:ok, %{st | tree: put_slot(st.tree, slot, default_node)}}
      end
    end)
  end

  @doc "Reset to the seeded default and forget shadows (tests / `--fresh`)."
  @spec reset_all() :: :ok
  def reset_all, do: Agent.update(__MODULE__, fn st -> %{st | tree: st.default} end)

  @doc """
  The `layout/` tool entries (qualified name => `(args -> term)`) — the homoiconic
  surface a slot program / the agent calls: `layout/set`, `layout/show`,
  `layout/tree`, `layout/reset`.
  """
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "layout/set" => fn args ->
        slot = strget(args, "slot")
        node = strget(args, "source") || strget(args, "node")

        cond do
          not is_binary(slot) -> %{"err" => "layout/set requires a :slot string"}
          not is_map(node) -> %{"err" => "layout/set requires a :source node map"}
          true -> set_result(slot, node)
        end
      end,
      "layout/show" => fn args ->
        case strget(args, "slot") do
          slot when is_binary(slot) ->
            case show(slot) do
              {:ok, node} -> node
              {:error, _} -> %{"err" => "unknown slot #{slot}"}
            end

          _ ->
            %{"err" => "layout/show requires a :slot string"}
        end
      end,
      "layout/tree" => fn _args -> tree() end,
      "layout/reset" => fn args ->
        slot = strget(args, "slot")
        if is_binary(slot), do: reset_to_result(slot), else: reset(nil) && tree()
      end
    }
  end

  defp set_result(slot, node) do
    case set(slot, node) do
      :ok ->
        tree()

      {:error, {:bad_layout, bad_slot, diagnostic}} ->
        bad_layout_result(bad_slot, diagnostic)

      {:error, {:not_adoptable, bad_slot}} ->
        %{
          "err" =>
            "rejected: the layout is not live yet, so a shadow on slot " <>
              "#{inspect(bad_slot)} would not render. The inspector App seeds the " <>
              "layout at mount; reshape from inside a running session.",
          "reason" => "not_adoptable",
          "slot" => bad_slot
        }

      {:error, {:unknown_slot, bad_slot}} ->
        %{"err" => "unknown slot #{bad_slot}", "reason" => "unknown_slot", "slot" => bad_slot}

      {:error, reason} ->
        %{"err" => "rejected: #{inspect(reason)}"}
    end
  end

  defp bad_layout_result(slot, diagnostic) do
    %{
      "err" =>
        "rejected: bad layout for slot #{inspect(slot)}: " <>
          LayoutDiagnostic.format(diagnostic),
      "reason" => "bad_layout",
      "slot" => slot,
      "diagnostic" => diagnostic
    }
  end

  defp reset_to_result(slot) do
    case reset(slot) do
      :ok -> tree()
      {:error, _} -> %{"err" => "unknown slot #{slot}"}
    end
  end

  # ---- internals ----

  # Replace the (first) node whose slot == `slot` with `node` (carrying the new
  # node's contents but keeping it slotted), rebuilding the tree.
  defp put_slot(node, slot, replacement) when is_map(node) do
    if Map.get(node, "slot") == slot or Map.get(node, :slot) == slot do
      Map.put(replacement, "slot", slot)
    else
      case Map.get(node, "children") || Map.get(node, :children) do
        kids when is_list(kids) ->
          Map.put(node, "children", Enum.map(kids, &put_slot(&1, slot, replacement)))

        _ ->
          node
      end
    end
  end

  defp put_slot(other, _slot, _replacement), do: other

  defp slot_present?(tree, slot), do: Lens.at(tree, slot) != nil

  # The pane identity frozen at seed time: the body split's direct-child slot
  # names while the body is still the NATIVE pane arrangement. Captured here so a
  # later body reshape (which drops those slots) cannot change it. A degraded tree
  # with no body yields `[]` (the empty-placeholder start state).
  defp pane_identity_of(tree) when is_map(tree), do: Lens.body_pane_slots(tree)
  defp pane_identity_of(_), do: []

  defp strget(m, key) when is_map(m), do: Map.get(m, key) || Map.get(m, safe_atom(key))
  defp strget(_m, _key), do: nil

  defp safe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end

  defp safe_atom(_), do: nil
end
