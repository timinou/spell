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

  alias SpellAgent.Tui.{LayoutDiagnostic, Lens, LensFn, RenderProbe, Tree}

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
  Surgically replace the value at `path` WITHIN `slot`'s subtree (PLAN-021 W2) —
  the path-addressed write behind `lens/put`/`lens/update`. `update_fn` receives
  the value currently at the path and returns its replacement.

  The candidate (slot subtree with the path rewritten) is validated by the SAME
  render-probe failure ladder as `set/2`: a rewrite that cannot lay out is
  rejected and the prior tree kept. Returns `{:ok, new_slot_node}` (the rewritten
  slot subtree, for the receipt), or `{:error, reason}`.

  Errors: `:unknown_slot` (no such slot), `{:path_missing, path}` (the path does
  not resolve in the slot — no partial write), `{:bad_layout, slot, diagnostic}`
  (the rewrite failed validation).
  """
  @spec update_path(String.t(), [Tree.segment()], (term() -> term())) ::
          {:ok, tree()} | {:error, term()}
  def update_path(slot, path, update_fn)
      when is_binary(slot) and is_list(path) and is_function(update_fn, 1) do
    Agent.get_and_update(__MODULE__, fn st ->
      case Lens.at(st.tree, slot) do
        nil ->
          {{:error, {:unknown_slot, slot}}, st}

        slot_node ->
          # Guard: the path must resolve, AND the rewrite must actually change the
          # subtree. `Tree.update_path` returns the subtree UNCHANGED on a missing
          # segment, so equality after a rewrite that should have mutated is the
          # honest "path missing" signal (no silent no-op masquerading as success).
          new_slot = Tree.update_path(slot_node, path, update_fn)

          cond do
            not Tree.path?(slot_node, path) ->
              {{:error, {:path_missing, path}}, st}

            true ->
              new_slot = Map.put(new_slot, "slot", slot)

              case LayoutDiagnostic.validate(new_slot) do
                :ok ->
                  {{:ok, new_slot}, %{st | tree: put_slot(st.tree, slot, new_slot)}}

                {:error, diagnostic} ->
                  {{:error, {:bad_layout, slot, diagnostic}}, st}
              end
          end
      end
    end)
  end

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
      end,
      "lens/update" => fn args -> update_result(args) end,
      "lens/put" => fn args -> put_result(args) end
    }
  end

  # ---- lens/update + lens/put: path-addressed surgical edits (PLAN-021 W2) ----

  # `lens/update {:slot :path :fn}` — run a deferred, capability-bounded fn over
  # the value at a path. `data/current` (and `%` sugar) is the value now; any
  # render-time `~hole` the fn leaves survives live. See `LensFn`.
  defp update_result(args) do
    slot = strget(args, "slot")
    path = normalize_path(strget(args, "path"))
    frozen = strget(args, "fn")
    env = data_env(strget(args, "data"))

    cond do
      not is_binary(slot) -> %{"err" => "lens/update requires a :slot string"}
      is_nil(path) -> %{"err" => "lens/update requires a :path vector (strings / indices)"}
      not is_map(frozen) -> %{"err" => "lens/update requires a :fn (quote …) form"}
      true -> apply_path(slot, path, fn current -> LensFn.eval(frozen, current, env) end, "lens/update")
    end
  end

  # `lens/put {:slot :path :value}` — replace the value at a path outright. The
  # value may itself carry `tmpl::` holes (built with view/* or tmpl::); they
  # render live like any other node content.
  defp put_result(args) do
    slot = strget(args, "slot")
    path = normalize_path(strget(args, "path"))
    has_value = is_map(args) and (Map.has_key?(args, "value") or Map.has_key?(args, :value))
    value = strget(args, "value")

    cond do
      not is_binary(slot) -> %{"err" => "lens/put requires a :slot string"}
      is_nil(path) -> %{"err" => "lens/put requires a :path vector (strings / indices)"}
      not has_value -> %{"err" => "lens/put requires a :value"}
      true -> apply_path(slot, path, fn _current -> {:ok, value} end, "lens/put")
    end
  end

  # Shared body: evaluate `edit_fn` (returning {:ok, value} | {:error, msg})
  # against the CURRENT value at the path — read-only, so a fn failure or an
  # unresolvable path is surfaced BEFORE any mutation — then commit a pure
  # replacement and shape the receipt. The two failure modes are kept DISTINCT
  # (path_missing vs fn_failed) so the agent's fix is unambiguous: re-address vs
  # fix the form.
  defp apply_path(slot, path, edit_fn, verb) do
    case eval_edit(slot, path, edit_fn) do
      {:ok, new_value} -> commit_path(slot, path, new_value, verb)
      {:error, :unknown_slot} -> path_error(slot, path, {:unknown_slot, slot}, verb)
      {:error, :path_missing} -> path_error(slot, path, {:path_missing, path}, verb)
      {:fn_error, msg} -> %{"err" => "#{verb} fn failed: #{msg}", "reason" => "fn_failed", "slot" => slot}
    end
  end

  # Read-only pre-flight: resolve the slot + path, then run the edit fn on the
  # current value. Returns {:ok, new_value} | {:error, :unknown_slot | :path_missing}
  # | {:fn_error, msg}. NB the path check precedes the fn so a bad address never
  # reads as a fn failure (W2 review).
  defp eval_edit(slot, path, edit_fn) do
    case show(slot) do
      {:error, _} ->
        {:error, :unknown_slot}

      {:ok, slot_node} ->
        if Tree.path?(slot_node, path) do
          case edit_fn.(Tree.get_path(slot_node, path)) do
            {:ok, value} -> {:ok, value}
            {:error, msg} -> {:fn_error, msg}
          end
        else
          {:error, :path_missing}
        end
    end
  end

  # Commit a pure path replacement and build the receipt.
  defp commit_path(slot, path, new_value, verb) do
    case update_path(slot, path, fn _old -> new_value end) do
      {:ok, new_slot} -> edit_receipt(slot, path, new_slot, verb)
      {:error, reason} -> path_error(slot, path, reason, verb)
    end
  end

  defp set_result(slot, node) do
    case set(slot, node) do
      :ok ->
        # A compact receipt, NOT a whole-tree echo (PLAN-021 W2). The agent set
        # one slot; it gets back confirmation + a render peek of THAT slot + a
        # hint toward surgical follow-up edits. `layout/tree` is there for the
        # rare time the whole tree is actually wanted.
        %{"ok" => true, "slot" => slot}
        |> maybe_peek(node)
        |> Map.put("hint", set_hint(slot))

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

  # A best-effort ASCII preview of the just-set node, folded into the success
  # result so the agent can confirm rendering inline (PLAN-017 / FEAT-022). Holes
  # resolve against an empty env (a `tmpl::` slot shows the `·` placeholder —
  # shape ok, holes live); a pane-only node returns :empty_render; any render
  # failure simply omits the peek. It NEVER gates a successful set.
  @peek_width 64
  @peek_height 8

  defp peek(node) do
    case RenderProbe.render(node, width: @peek_width, height: @peek_height) do
      {:ok, %{buffer: buffer}} -> buffer
      _ -> nil
    end
  rescue
    _ -> nil
  catch
    _, _ -> nil
  end

  defp reset_to_result(slot) do
    case reset(slot) do
      :ok -> tree()
      {:error, _} -> %{"err" => "unknown slot #{slot}"}
    end
  end

  # ---- edit receipts (PLAN-021 W2): a path-scoped confirmation, not a tree echo ----

  # The success receipt for a lens/* path edit. Carries WHAT changed (slot+path),
  # a render PEEK of the rewritten slot (holes show as `·` — the FEAT-022 contract,
  # so a live edit reads as live, not baked), and a one-line HINT naming the verb
  # to tweak the same path again. It deliberately does NOT echo the whole tree:
  # the agent addressed one path; the receipt answers at that granularity.
  defp edit_receipt(slot, path, new_slot, verb) do
    base = %{"ok" => true, "slot" => slot, "path" => path, "verb" => verb}

    base
    |> maybe_peek(new_slot)
    |> Map.put("hint", edit_hint(slot, path))
  end

  defp maybe_peek(receipt, node) do
    case peek(node) do
      nil -> receipt
      ascii -> Map.put(receipt, "peek", ascii)
    end
  end

  defp set_hint(slot) do
    "set slot #{inspect(slot)} (whole subtree). To tweak ONE leaf next time — a " <>
      "title, a color, one row — don't resend the slot: address it with " <>
      "(lens/update {:slot #{inspect(slot)} :path […] :fn (quote ~…)}). " <>
      "Inspect the shape first with (layout/show {:slot #{inspect(slot)}})."
  end

  defp edit_hint(slot, path) do
    addr = ":slot #{inspect(slot)} :path #{inspect(path)}"
    "edited #{slot}#{format_path(path)}. tweak this same leaf again with " <>
      "(lens/update {#{addr} :fn (quote ~…)}) — wrap a ~hole to keep it live, " <>
      "or replace it with (lens/put {#{addr} :value …})."
  end

  defp path_error(slot, path, reason, verb) do
    case reason do
      {:bad_layout, bad_slot, diagnostic} ->
        bad_layout_result(bad_slot, diagnostic)

      {:unknown_slot, bad_slot} ->
        %{"err" => "unknown slot #{bad_slot}", "reason" => "unknown_slot", "slot" => bad_slot}

      {:path_missing, miss} ->
        %{
          "err" =>
            "#{verb}: path #{inspect(miss)} does not resolve in slot #{inspect(slot)}; " <>
              "read the current shape with (layout/show {:slot #{inspect(slot)}}) and address an existing node",
          "reason" => "path_missing",
          "slot" => slot,
          "path" => path
        }

      other ->
        %{"err" => "#{verb} rejected: #{inspect(other)}", "slot" => slot}
    end
  end

  # ---- path argument coercion ----

  # A `:path` arrives as a PTC vector of string keys / integer indices. Accept a
  # single scalar as a one-segment path for convenience. Any non-string/non-int
  # segment rejects the whole path (nil) — a malformed address must not silently
  # truncate to a shorter, valid-looking one.
  defp normalize_path(nil), do: nil
  defp normalize_path(seg) when is_binary(seg) or is_integer(seg), do: [seg]

  defp normalize_path(list) when is_list(list) do
    if Enum.all?(list, &valid_segment?/1), do: list, else: nil
  end

  defp normalize_path(_), do: nil

  defp valid_segment?(seg), do: is_binary(seg) or (is_integer(seg) and seg >= 0)

  # The optional `:data` arg — extra `data/*` bindings a lens/update fn may read
  # alongside `data/current`. Only a string-keyed map passes; anything else is %{}.
  defp data_env(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), v} end)
  defp data_env(_), do: %{}

  # A compact path rendering for hints/messages: `[1 "block" "title"]` -> `·1·block·title`.
  defp format_path([]), do: ""
  defp format_path(path), do: "·" <> Enum.map_join(path, "·", &to_string/1)

  # ---- internals ----

  # Replace the node whose slot == `slot` with `node` (carrying the new node's
  # contents but keeping it slotted). Routed through the canonical Tree walk
  # (PLAN-021 W1) -- the rose-tree recursion lives once.
  defp put_slot(tree, slot, replacement),
    do: Tree.update_slot(tree, slot, fn _old -> Map.put(replacement, "slot", slot) end)

  defp slot_present?(tree, slot), do: Lens.at(tree, slot) != nil

  # The pane identity frozen at seed time: the body split's direct-child slot
  # names while the body is still the NATIVE pane arrangement. Captured here so a
  # later body reshape (which drops those slots) cannot change it. A degraded tree
  # with no body yields `[]` (the empty-placeholder start state).
  defp pane_identity_of(tree) when is_map(tree), do: Lens.body_pane_slots(tree)
  defp pane_identity_of(_), do: []

  defp strget(m, key), do: Tree.get(m, key)
end
