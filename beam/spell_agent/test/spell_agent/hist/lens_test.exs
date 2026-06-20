defmodule SpellAgent.Hist.LensTest do
  @moduledoc """
  Tests the PTC-Lisp query-lens layer (PLAN-005, FUP-PTC-LENSES).

  The core contract is PARITY: each PTC lens, run over a session's projection,
  must return the same answer as the Elixir `Query.*` verb it replaces — on hand
  seeded sessions AND on randomly generated node DAGs (property-based). That parity
  is what lets us trust a reimplementation in a language the agent can rewrite at
  runtime. We also pin the projection invariants (string-keyed, JSON-safe,
  seq-ordered), heap-safety on a large session, the runtime-authorship surface
  (`hist/lens` over agent-authored source), and namespace integration.

  PTC results are string-keyed (sandbox convention); the Elixir verbs return
  atom-keyed maps. `normalize/1` rekeys to a common string-keyed shape so parity
  is asserted on VALUES, not key-encoding.
  """
  use ExUnit.Case, async: false
  use ExUnitProperties

  alias SpellAgent.Hist.{Lens, Namespace, Query, Recorder, Store}
  alias SpellAgent.Hist.Store.Memory

  @runs 60

  setup do
    Store.clear(Memory)
    :ok
  end

  # --- hand-seeded parity (readable, specific) -------------------------------

  describe "parity on a seeded session" do
    setup do
      a =
        node(
          %{
            program: {:tool_call, "edit", %{target: "a.ex"}},
            sees: [%{name: "edit", args: %{}, result: %{"ok" => 1}}],
            tokens: %{input: 10, output: 2}
          },
          nil
        )

      b =
        node(
          %{
            program: {:def, :plan, 1, %{}},
            sees: [%{name: "find", args: %{}, result: %{"err" => "boom"}}],
            tokens: %{input: 5, output: 1}
          },
          a.id
        )

      c =
        node(
          %{
            program: {:tool_call, "edit", %{target: "c.ex"}},
            sees: [%{name: "edit", args: %{}, result: %{"ok" => 1}}],
            tokens: %{input: 3, output: 3}
          },
          b.id
        )

      %{ids: %{a: a.id, b: b.id, c: c.id}}
    end

    test "hist/forms == Query.forms (turns calling tool/edit)", %{ids: ids} do
      ptc = run_lens("forms", %{"tool" => "edit"})
      elixir = Query.forms(Memory, "s", {:tool_call, "edit"})

      assert Enum.map(ptc, & &1["id"]) == Enum.map(elixir, & &1.id)
      assert Enum.map(ptc, & &1["id"]) == [ids.a, ids.c]
    end

    test "hist/defs == Query.defq (where plan was defined)", %{ids: ids} do
      ptc = run_lens("defs", %{"sym" => "plan"})
      elixir = Query.defq(Memory, "s", "plan")

      assert Enum.map(ptc, & &1["node_id"]) == Enum.map(elixir, & &1.node_id)
      assert Enum.map(ptc, & &1["node_id"]) == [ids.b]
    end

    test "hist/tool_calls == Query.tool_calls (all, and filtered by status)" do
      assert normalize(run_lens("tool_calls", %{})) ==
               normalize_elixir(Query.tool_calls(Memory, "s"))

      assert normalize(run_lens("tool_calls", %{"status" => "error"})) ==
               normalize_elixir(Query.tool_calls(Memory, "s", status: :error))

      assert normalize(run_lens("tool_calls", %{"name" => "edit"})) ==
               normalize_elixir(Query.tool_calls(Memory, "s", name: "edit"))
    end

    test "hist/cost == Query.cost (token totals + nodes_counted)" do
      ptc = run_lens("cost", %{})
      elixir = Query.cost(Memory, "s")

      assert ptc["input"] == elixir.input
      assert ptc["output"] == elixir.output
      assert ptc["total"] == elixir.total
      assert ptc["nodes_counted"] == elixir.nodes_counted
    end
  end

  # --- property-based parity (broad, generative) -----------------------------

  describe "parity on generated sessions (property)" do
    property "forms lens matches Query.forms for any generated session + tool" do
      check all(spec <- session_spec(), max_runs: @runs) do
        seed_session(spec)
        tool = "edit"

        ptc_ids = run_lens("forms", %{"tool" => tool}) |> Enum.map(& &1["id"])
        elixir_ids = Query.forms(Memory, "s", {:tool_call, tool}) |> Enum.map(& &1.id)

        assert ptc_ids == elixir_ids
        Store.clear(Memory)
      end
    end

    property "defs lens matches Query.defq for any generated session + symbol" do
      check all(spec <- session_spec(), max_runs: @runs) do
        seed_session(spec)
        sym = "plan"

        ptc_ids = run_lens("defs", %{"sym" => sym}) |> Enum.map(& &1["node_id"])
        elixir_ids = Query.defq(Memory, "s", sym) |> Enum.map(& &1.node_id)

        assert ptc_ids == elixir_ids
        Store.clear(Memory)
      end
    end

    property "tool_calls lens matches Query.tool_calls (all + each status filter)" do
      check all(spec <- session_spec(), max_runs: @runs) do
        seed_session(spec)

        assert normalize(run_lens("tool_calls", %{})) ==
                 normalize_elixir(Query.tool_calls(Memory, "s"))

        assert normalize(run_lens("tool_calls", %{"status" => "error"})) ==
                 normalize_elixir(Query.tool_calls(Memory, "s", status: :error))

        assert normalize(run_lens("tool_calls", %{"status" => "ok"})) ==
                 normalize_elixir(Query.tool_calls(Memory, "s", status: :ok))

        Store.clear(Memory)
      end
    end

    property "cost lens matches Query.cost for any generated session" do
      check all(spec <- session_spec(), max_runs: @runs) do
        seed_session(spec)
        ptc = run_lens("cost", %{})
        elixir = Query.cost(Memory, "s")

        assert ptc["input"] == elixir.input
        assert ptc["output"] == elixir.output
        assert ptc["total"] == elixir.total
        assert ptc["nodes_counted"] == elixir.nodes_counted
        Store.clear(Memory)
      end
    end
  end

  # --- projection invariants (property) --------------------------------------

  describe "projection invariants" do
    property "every projected node is string-keyed, seq-ordered, JSON-round-trips" do
      check all(spec <- session_spec(), max_runs: @runs) do
        seed_session(spec)
        proj = Lens.project(Memory, "s")

        # seq-ordered
        seqs = Enum.map(proj, & &1["seq"])
        assert seqs == Enum.sort(seqs)

        for node <- proj do
          # string-keyed at the top level
          assert Enum.all?(Map.keys(node), &is_binary/1)
          # tool-call statuses are constrained
          for c <- node["tool_calls"], do: assert(c["status"] in ["ok", "error"])
          # JSON round-trips without loss of the structural fields
          decoded = node |> Jason.encode!() |> Jason.decode!()
          assert decoded["id"] == node["id"]
          assert decoded["defs"] == node["defs"]
          assert decoded["form_tools"] == node["form_tools"]
        end

        Store.clear(Memory)
      end
    end
  end

  # --- heap safety -----------------------------------------------------------

  test "a large session runs a lens without memory_exceeded" do
    Enum.reduce(1..2_000, nil, fn i, parent ->
      n =
        node(
          %{
            program: {:tool_call, "edit", %{n: i}},
            sees: [%{name: "edit", args: %{}, result: %{"ok" => i}}],
            tokens: %{input: 1, output: 1}
          },
          parent
        )

      n.id
    end)

    result = run_lens("cost", %{})
    assert result["nodes_counted"] == 2_000
    assert result["total"] == 4_000
  end

  # --- runtime authorship (hist/lens) ----------------------------------------

  test "hist/lens runs an agent-authored lens over the projection, zero Elixir" do
    node(
      %{
        program: {:def, :plan, 1, %{}},
        sees: [%{name: "find", args: %{}, result: %{"err" => "x"}}]
      },
      nil
    )

    node(
      %{
        program: {:tool_call, "edit", %{}},
        sees: [%{name: "edit", args: %{}, result: %{"ok" => 1}}]
      },
      nil
    )

    verbs = Namespace.tools(Memory, "s")
    # A novel lens the agent could author: ids of turns that BOTH defined a symbol
    # AND have an errored tool call — expressible only by composing, not a built-in.
    src =
      ~S|(->> data/nodes (filter (fn [n] (and (not (empty? (get n "defs"))) (some (fn [c] (= (get c "status") "error")) (get n "tool_calls"))))) (map (fn [n] (get n "id"))))|

    result = verbs["hist/lens"].(%{"source" => src})
    assert is_list(result)
    assert length(result) == 1
  end

  test "hist/lens without a source returns an error map, never crashes" do
    verbs = Namespace.tools(Memory, "s")
    assert %{"err" => _} = verbs["hist/lens"].(%{})
  end

  test "Lens.run on a broken lens returns {:error, _}, never raises" do
    node(%{program: "1", sees: []}, nil)
    assert {:error, _} = Lens.run(Memory, "s", "(this is not valid (", %{})
  end

  # --- namespace integration -------------------------------------------------

  test "Namespace exposes PTC lenses as primary names + Elixir ! fast paths" do
    node(
      %{
        program: {:tool_call, "edit", %{}},
        sees: [%{name: "edit", args: %{}, result: %{"ok" => 1}}],
        tokens: %{input: 7, output: 3}
      },
      nil
    )

    verbs = Namespace.tools(Memory, "s")

    assert Map.has_key?(verbs, "hist/forms")
    assert Map.has_key?(verbs, "hist/forms!")
    assert Map.has_key?(verbs, "hist/cost")
    assert Map.has_key?(verbs, "hist/cost!")
    assert Map.has_key?(verbs, "hist/lens")

    # primary (PTC) and fast-path (Elixir) agree on cost totals
    ptc_cost = verbs["hist/cost"].(%{})
    elixir_cost = verbs["hist/cost!"].(%{})
    assert ptc_cost["input"] == elixir_cost.input
    assert ptc_cost["total"] == elixir_cost.total
  end

  # --- BUG-004 regressions ---------------------------------------------------

  test "BUG-004 L1: cost lens honors since_mark, matching Query.cost" do
    a = node(%{program: "1", sees: [], tokens: %{input: 10, output: 2}}, nil)
    b = node(%{program: "2", sees: [], tokens: %{input: 5, output: 1}}, a.id)
    # mark on b: cost since the mark should count only b.
    Store.put(Memory, {:mark, "s", "bm"}, %SpellAgent.Hist.Mark{
      id: "bm",
      session: "s",
      node_id: b.id,
      kind: :bookmark
    })

    ptc = run_lens("cost", %{"since_mark" => "bm"})
    elixir = Query.cost(Memory, "s", since_mark: "bm")

    assert ptc["nodes_counted"] == elixir.nodes_counted
    assert ptc["total"] == elixir.total
    assert ptc["nodes_counted"] == 1
  end

  test "BUG-004 L2: a false tool result is preserved in the projection, not nilled" do
    node(%{program: "(f)", sees: [%{name: "flag", args: %{}, result: false}]}, nil)
    [proj] = Lens.project(Memory, "s")
    [call] = proj["tool_calls"]
    assert call["result"] == false
    refute is_nil(call["result"])
  end

  # === helpers ===============================================================

  defp run_lens(name, args) do
    src = Map.fetch!(Lens.sources(), name)
    Lens.run(Memory, "s", src, args)
  end

  defp node(attrs, parent_id) do
    attrs =
      attrs
      |> Map.put_new(:memory, %{})
      |> rename(:sees, :tool_calls)

    Recorder.record_node(Memory, "s", attrs, parent_id)
  end

  # record_node reads tool effects from :tool_calls; tests author them as :sees for
  # readability (it is what the node field is called). Bridge the two.
  defp rename(map, from, to) do
    case Map.pop(map, from) do
      {nil, m} -> m
      {v, m} -> Map.put(m, to, v)
    end
  end

  # Normalize Query.tool_calls (atom-keyed) and the PTC lens (string-keyed) to a
  # common comparable shape: {tool, status} pairs in order (args/result encodings
  # differ between the two paths; tool+status+order is the contract that matters).
  defp normalize(ptc_list) when is_list(ptc_list) do
    Enum.map(ptc_list, fn c -> {c["tool"], c["status"]} end)
  end

  defp normalize_elixir(elixir_list) do
    Enum.map(elixir_list, fn c -> {c.tool, Atom.to_string(c.status)} end)
  end

  # A generated session: a list of turn specs, each either a tool-call turn or a
  # def turn, with a status and optional tokens. seed_session/1 records them in a
  # linear chain (parent = previous), which is the common conversation shape.
  defp session_spec do
    gen all(turns <- list_of(turn_spec(), min_length: 0, max_length: 12)) do
      turns
    end
  end

  defp turn_spec do
    one_of([
      gen all(
            tool <- member_of(["edit", "find", "bash"]),
            ok? <- boolean(),
            i <- integer(0..50),
            o <- integer(0..50)
          ) do
        {:tool, tool, ok?, {i, o}}
      end,
      gen all(
            sym <- member_of(["plan", "helper", "x"]),
            i <- integer(0..50),
            o <- integer(0..50)
          ) do
        {:def, sym, {i, o}}
      end
    ])
  end

  defp seed_session(turns) do
    Enum.reduce(turns, nil, fn spec, parent ->
      attrs = turn_attrs(spec)
      n = Recorder.record_node(Memory, "s", attrs, parent)
      n.id
    end)
  end

  defp turn_attrs({:tool, tool, ok?, {i, o}}) do
    result = if ok?, do: %{"ok" => 1}, else: %{"err" => "boom"}

    %{
      program: {:tool_call, tool, %{}},
      memory: %{},
      tool_calls: [%{name: tool, args: %{}, result: result}],
      tokens: %{input: i, output: o}
    }
  end

  defp turn_attrs({:def, sym, {i, o}}) do
    %{
      program: {:def, String.to_atom(sym), 1, %{}},
      memory: %{},
      tool_calls: [],
      tokens: %{input: i, output: o}
    }
  end
end
