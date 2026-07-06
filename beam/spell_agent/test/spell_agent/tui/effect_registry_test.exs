defmodule SpellAgent.Tui.EffectRegistryTest do
  @moduledoc """
  PLAN-027 M5 (FUP-040): the bounded App-effect registry + the reaction
  effect-return protocol. Defends: the bounded-effect invariant (unknown name =
  no-op, never an arbitrary call), the kill-switch firewall (a protected effect
  is unreachable from the reaction path), and the end-to-end reaction → effect
  classification.
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{EffectRegistry, Ui}
  alias SpellAgent.Tui.Reaction.Ptc

  setup do
    case Process.whereis(EffectRegistry) do
      nil -> start_supervised!({EffectRegistry, []})
      _ -> :ok
    end

    EffectRegistry.reset()
    on_exit(fn -> if Process.whereis(EffectRegistry), do: EffectRegistry.reset() end)
    :ok
  end

  defp state(ui \\ Ui.new(focus: :prompt, mode: :normal)), do: %{ui: ui, other: :untouched}

  describe "invoke — the bounded-effect invariant" do
    test "a registered effect's handler runs and returns its reply" do
      :ok = EffectRegistry.register("test/flip", fn s, _a -> {:noreply, Map.put(s, :flipped, true)} end)

      assert {:noreply, new_state} = EffectRegistry.invoke("test/flip", state(), %{})
      assert new_state.flipped == true
    end

    test "an UNKNOWN effect name is a no-op with the unchanged state (never an arbitrary call)" do
      s = state()
      assert {:noreply, ^s} = EffectRegistry.invoke("never/registered", s, %{})
    end

    test "a handler that RAISES degrades to no-op, never bricks the input path" do
      :ok = EffectRegistry.register("test/boom", fn _s, _a -> raise "kaboom" end)
      s = state()
      assert {:noreply, ^s} = EffectRegistry.invoke("test/boom", s, %{})
    end

    test "args reach the handler" do
      :ok = EffectRegistry.register("test/args", fn s, a -> {:noreply, Map.put(s, :got, a["k"])} end)
      assert {:noreply, ns} = EffectRegistry.invoke("test/args", state(), %{"k" => 42})
      assert ns.got == 42
    end
  end

  describe "the kill-switch firewall (protected effects)" do
    test "a PROTECTED effect is UNREACHABLE from invoke — no-op, never fires" do
      # Register a protected 'quit' whose handler WOULD stop the app; invoke must
      # refuse it (the reaction path cannot halt the runtime).
      :ok = EffectRegistry.register("app/quit", fn s, _a -> {:stop, s} end, protected?: true)

      s = state()
      # invoke returns {:noreply, s} (no-op), NOT {:stop, _} — the firewall held.
      assert {:noreply, ^s} = EffectRegistry.invoke("app/quit", s, %{})
    end

    test "an UNprotected effect with the same {:stop} handler DOES fire (proving protection is the gate)" do
      :ok = EffectRegistry.register("app/soft-quit", fn s, _a -> {:stop, s} end)
      s = state()
      assert {:stop, ^s} = EffectRegistry.invoke("app/soft-quit", s, %{})
    end
  end

  describe "bounds" do
    test "an empty name is rejected; the cap is enforced" do
      assert {:error, _} = EffectRegistry.register("", fn s, _ -> {:noreply, s} end)

      for i <- 1..64, do: :ok = EffectRegistry.register("e#{i}", fn s, _ -> {:noreply, s} end)
      assert {:error, reason} = EffectRegistry.register("overflow", fn s, _ -> {:noreply, s} end)
      assert reason =~ "limit"
    end
  end

  describe "reaction → effect classification (Reaction.Ptc.run_effectful)" do
    setup do
      %{ui: Ui.new(focus: :prompt, mode: :normal)}
    end

    test "a reaction returning an effect envelope yields {:effect, name, args}", %{ui: ui} do
      # The envelope shape a reaction author writes: {\"__effect__\" name \"args\" {..}}.
      src = ~s|{"__effect__" "cockpit/drill" "args" {"id" "sess-1"}}|
      assert {:effect, "cockpit/drill", %{"id" => "sess-1"}} = Ptc.run_effectful(src, ui, %{})
    end

    test "a reaction returning a plain gaze map yields {:gaze, ui}", %{ui: ui} do
      # A normal gaze transform (set focus to tree) — no effect key.
      src = ~s|{"focus" "tree"}|
      assert {:gaze, %Ui{focus: :tree}} = Ptc.run_effectful(src, ui, %{})
    end

    test "a malformed effect envelope (non-string name) degrades to a gaze, never a bad effect", %{ui: ui} do
      src = ~s|{"__effect__" 42}|
      assert {:gaze, %Ui{}} = Ptc.run_effectful(src, ui, %{})
    end

    test "SOLE-KEY: a gaze map with a STRAY __effect__ key does NOT fire the effect (review Sβ P2)", %{ui: ui} do
      # A normal gaze return (sets focus) that ALSO carries an __effect__ key must
      # be treated as a GAZE, not silently execute the effect — looking never acts
      # by accident. Only a PURE {__effect__ [args]} envelope is an effect.
      src = ~s|{"focus" "tree" "__effect__" "ui/set-flag"}|
      assert {:gaze, %Ui{focus: :tree}} = Ptc.run_effectful(src, ui, %{})
    end

    test "the Ui-only run/5 wrapper IGNORES an effect return (pre-M5 contract preserved)", %{ui: ui} do
      src = ~s|{"__effect__" "cockpit/drill"}|
      # run/5 must still return a %Ui{} (the unchanged gaze), never the effect.
      assert %Ui{} = Ptc.run(src, ui, %{})
    end
  end
end
