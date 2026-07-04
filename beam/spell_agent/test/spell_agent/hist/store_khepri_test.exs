defmodule SpellAgent.Hist.Store.KhepriTest do
  @moduledoc """
  The durable store must satisfy the SAME `Hist.Store` contract as the Memory impl
  (PLAN-001 W4) — round-trip, delete, and session-scoped `list/2` — but against a
  real on-disk Khepri instance. Tagged `:khepri`; run with `--include khepri`
  (excluded by default because it boots a Ra system + writes to disk).
  """
  use ExUnit.Case, async: false

  @moduletag :khepri

  alias SpellAgent.Hist.{Node, Session, ToolDef}
  alias SpellAgent.Hist.Store
  alias SpellAgent.Hist.Store.Khepri

  setup_all do
    # Khepri boots the default `khepri` Ra system bound to ONE data dir; starting
    # it repeatedly with different dirs in the same BEAM yields {:error, :enoent}
    # (a documented Khepri/Ra limitation — the Ra system's data-dir config does
    # not cleanly reset across a stop/start cycle within one BEAM). So boot once
    # for the WHOLE module (including PLAN-024 Wave 4's layout/keymap durability
    # tests below), clear between tests — one Khepri lifecycle, not two files
    # each trying to own their own.
    dir = Path.join(System.tmp_dir!(), "hist_khepri_#{:erlang.unique_integer([:positive])}")
    {:ok, _} = Khepri.start(dir)

    on_exit(fn ->
      Khepri.stop()
      File.rm_rf(dir)
    end)

    %{dir: dir}
  end

  setup do
    Store.clear(Khepri)
    :ok
  end

  test "put/fetch round-trips a node verbatim through Khepri" do
    node = %Node{id: "n1", session: "s1", seq: 1, say: "hi", binds: %{x: 1}}
    :ok = Store.put(Khepri, {:node, "s1", "n1"}, node)
    assert {:ok, ^node} = Store.fetch(Khepri, {:node, "s1", "n1"})
  end

  test "fetch of an absent key is :error" do
    assert :error = Store.fetch(Khepri, {:node, "s1", "ghost"})
  end

  test "delete removes a key" do
    Store.put(Khepri, {:session, "s1"}, %Session{id: "s1"})
    Store.delete(Khepri, {:session, "s1"})
    assert :error = Store.fetch(Khepri, {:session, "s1"})
  end

  test "list(:node, sid) is session-scoped" do
    Store.put(Khepri, {:node, "s1", "n1"}, %Node{id: "n1", session: "s1", seq: 1})
    Store.put(Khepri, {:node, "s1", "n2"}, %Node{id: "n2", session: "s1", seq: 2})
    Store.put(Khepri, {:node, "s2", "n3"}, %Node{id: "n3", session: "s2", seq: 1})

    assert Khepri |> Store.list(:node, "s1") |> Enum.map(& &1.id) |> Enum.sort() == ["n1", "n2"]
    assert Khepri |> Store.list(:node, nil) |> length() == 3
  end

  test "session-global kinds ignore session scope" do
    Store.put(Khepri, {:tool, "blast"}, %ToolDef{name: "blast", source: "(...)"})
    assert [%ToolDef{name: "blast"}] = Store.list(Khepri, :tool, "anything")
  end

  test "durability: a value survives a stop/start cycle on the same dir", %{dir: dir} do
    Store.put(Khepri, {:crystal, "c1"}, %SpellAgent.Hist.Crystal{id: "c1", name: "hot", source: "(x)"})
    # force the write to disk, then cycle the store on the SAME data dir
    :ok = :khepri.fence(:spell_hist)
    Khepri.stop()
    {:ok, _} = Khepri.start(dir)

    assert {:ok, %{id: "c1"}} = Store.fetch(Khepri, {:crystal, "c1"})
  end

  describe ":layout / :keymap durability (PLAN-024 Wave 4 / FUP-009)" do
    test "a durable layout map round-trips through Khepri" do
      layout = %{"status" => %{"type" => "paragraph", "text" => "custom"}}
      :ok = Store.put(Khepri, {:layout, "default"}, layout)
      assert {:ok, ^layout} = Store.fetch(Khepri, {:layout, "default"})
    end

    test "a durable keymap map round-trips through Khepri" do
      keymap = %{bindings: %{{:tree, "C-l"} => :"span/expand"}, reactions: %{}}
      :ok = Store.put(Khepri, {:keymap, "default"}, keymap)
      assert {:ok, ^keymap} = Store.fetch(Khepri, {:keymap, "default"})
    end

    test "a persisted layout survives a stop/start cycle on the same dir (the FEAT-020 acceptance shape)",
         %{dir: dir} do
      layout = %{"status" => %{"type" => "paragraph", "text" => "survived a restart"}}
      Store.put(Khepri, {:layout, "default"}, layout)
      :ok = :khepri.fence(:spell_hist)
      Khepri.stop()
      {:ok, _} = Khepri.start(dir)

      assert {:ok, ^layout} = Store.fetch(Khepri, {:layout, "default"})
    end
  end

  describe "FUP-009 full acceptance: LayoutRegistry.rehydrate/3 + KeymapRegistry.rehydrate_into/3 against REAL Khepri" do
    alias SpellAgent.Tui.{Chord, DefaultLayout, KeymapRegistry, LayoutRegistry, Lens, Ui}

    defp default_tree do
      DefaultLayout.tree(Ui.new(panes: [:tree, :detail], focus: :tree), ["tree", "detail"])
    end

    test "a layout customization survives a full Khepri stop/start cycle (simulating quit + relaunch)", %{dir: dir} do
      custom = %{"type" => "paragraph", "slot" => "status", "text" => "CUSTOM STATUS SURVIVED A QUIT+RELAUNCH"}
      tree_with_shadow = Lens.put_at(default_tree(), "status", custom)
      :ok = Store.put(Khepri, {:layout, "acceptance"}, tree_with_shadow)

      :ok = :khepri.fence(:spell_hist)
      Khepri.stop()
      {:ok, _} = Khepri.start(dir)

      # rehydrate/3 is the SAME code a fresh `start_link(durable: true, store:
      # Khepri)` calls internally — the actual "quit the BEAM, relaunch" proof.
      rehydrated = LayoutRegistry.rehydrate(Khepri, "acceptance", default_tree())
      assert Lens.at(rehydrated, "status")["text"] == "CUSTOM STATUS SURVIVED A QUIT+RELAUNCH"
    end

    test "a keymap binding survives a full Khepri stop/start cycle", %{dir: dir} do
      :ok =
        Store.put(Khepri, {:keymap, "acceptance-keymap"}, %{
          "bindings" => [%{"context" => "tree", "chord" => "g", "intent" => "span/goto"}],
          "reactions" => [%{"context" => "tree", "intent" => "span/goto", "source" => "(harness/expand {})"}]
        })

      :ok = :khepri.fence(:spell_hist)
      Khepri.stop()
      {:ok, _} = Khepri.start(dir)

      base = %{bindings: %{}, reactions: %{}, intents: MapSet.new()}
      rehydrated = KeymapRegistry.rehydrate_into(base, Khepri, "acceptance-keymap")

      assert rehydrated.bindings == %{{:tree, Chord.parse("g")} => :"span/goto"}
      assert rehydrated.reactions == %{{:tree, :"span/goto"} => "(harness/expand {})"}
    end

    test "a persisted layout that no longer materializes degrades to native (never bricks a real Khepri boot)", %{
      dir: dir
    } do
      stale = Lens.put_at(default_tree(), "status", %{"type" => "renamed_or_removed_widget", "slot" => "status"})
      :ok = Store.put(Khepri, {:layout, "stale-acceptance"}, stale)

      :ok = :khepri.fence(:spell_hist)
      Khepri.stop()
      {:ok, _} = Khepri.start(dir)

      native = default_tree()
      result = LayoutRegistry.rehydrate(Khepri, "stale-acceptance", native)
      assert result == native
    end
  end
end
