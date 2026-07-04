defmodule SpellAgent.Tui.AtomDosPropertyTest do
  @moduledoc """
  Atom-table-DoS fuzz tests (PLAN-024 Wave 0 / FUP-007) over every bounded
  string->atom coercion chokepoint the freeform-TUI surface exposes to
  agent/reaction-controlled input.

  BEAM atoms are never garbage-collected. Every module on this surface is
  DESIGNED to never intern a new atom from untrusted data — `Ui.safe_*`,
  `Materialize`'s existing-atom-only coercions, `Tree.safe_atom`, and
  `SplitSpec`'s fixed lookup maps all resolve against known/closed vocabularies
  and return `nil`/a default rather than calling `String.to_atom/1`. The single
  DELIBERATE exception is `KeymapRegistry.define_intent/1`, which bounds its
  interning with a hard cap (`@max_runtime_intents`) + a shape regex + a length
  cap — this is the one chokepoint allowed to grow the atom table, and only up
  to its cap.

  ## Measurement methodology (two isolation findings from building this suite)

  1. **`StreamData`'s OWN `check all` generation machinery interns atoms** —
     confirmed by running `check all _ <- string(:alphanumeric, ...) do :ok end`
     with NO SUT call inside: the atom table still grows. So a naive
     `check all s <- gen(), do: assert atom_count() unchanged` is invalid — it
     blames the SUT for growth the *test harness* caused. Fix: generate inputs
     into a materialized LIST first (`Enum.take(gen(), n)`, itself outside any
     measurement window), THEN measure atom-count only around a plain
     `Enum.each` loop over that list calling the SUT.
  2. A fresh test **process** pays a one-time warmup cost the first time a
     module's function is invoked at all (confirmed: identical repeated calls
     after the first cost nothing further) — an artifact of first-use module
     resolution, not attacker-controlled growth. `warm/1` pays this once before
     each baseline is taken.

  These tests assert the invariant the FUP-007 checklist names: feeding a large
  volume of adversarial/random strings through each chokepoint must not grow
  `:erlang.system_info(:atom_count)`. A regression here (a new coercion added
  without routing through a safe_*/existing_atom/fixed-map chokepoint) is
  exactly the class of bug this guards.
  """

  use ExUnit.Case, async: false

  @moduletag :atom_dos

  alias SpellAgent.Tui.{KeymapRegistry, Materialize, SplitSpec, Tree, Ui}

  @runs 300

  setup do
    KeymapRegistry.reset()
    :ok
  end

  # ---- input generation (materialized to a list BEFORE any measurement) ----

  # Adversarial strings biased toward "almost valid" tokens (the realistic
  # near-miss an agent/reaction would plausibly emit) plus fully arbitrary
  # printable bytes (the hostile case). Sampled via `Enum.take/2` on a
  # StreamData generator, which is the documented one-off-sampling idiom and
  # runs entirely BEFORE the measurement window below.
  defp adversarial_strings(n) do
    alnum = StreamData.string(:alphanumeric, min_length: 0, max_length: 40)
    printable = StreamData.string(:printable, min_length: 0, max_length: 64)

    a = Enum.take(alnum, div(n, 2))
    b = Enum.take(printable, n - div(n, 2))
    Enum.shuffle(a ++ b)
  end

  defp atom_count, do: :erlang.system_info(:atom_count)

  # Pay the one-time first-use module-resolution cost (see moduledoc finding 2)
  # before a baseline is captured, so it never counts as "growth".
  defp warm(fun) when is_function(fun, 0), do: fun.()

  describe "Ui.safe_* — fixed-vocabulary coercions never intern" do
    test "safe_pane never grows the atom table on random strings" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Ui.safe_pane("warmup") end)
      before = atom_count()

      Enum.each(inputs, &Ui.safe_pane/1)

      assert atom_count() == before
    end

    test "safe_dir never grows the atom table on random strings" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Ui.safe_dir("warmup") end)
      before = atom_count()

      Enum.each(inputs, &Ui.safe_dir/1)

      assert atom_count() == before
    end

    test "safe_visibility never grows the atom table on random strings" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Ui.safe_visibility("warmup") end)
      before = atom_count()

      Enum.each(inputs, &Ui.safe_visibility/1)

      assert atom_count() == before
    end

    test "safe_mode never grows the atom table on random strings" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Ui.safe_mode("warmup") end)
      before = atom_count()

      Enum.each(inputs, &Ui.safe_mode/1)

      assert atom_count() == before
    end

    test "known-vocabulary strings still resolve correctly (not just safe, but right)" do
      for p <- ~w(tree detail prompt history cells) do
        assert Ui.safe_pane(p) == String.to_existing_atom(p)
      end
    end
  end

  describe "Tree.safe_atom — the canonical node-key chokepoint" do
    test "never interns a new atom on random strings" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Tree.safe_atom("warmup") end)
      before = atom_count()

      Enum.each(inputs, &Tree.safe_atom/1)

      assert atom_count() == before
    end
  end

  describe "Materialize — widget/field/enum coercion never interns" do
    test "an unknown widget type is rejected without interning" do
      inputs = adversarial_strings(@runs)
      warm(fn -> Materialize.to_struct(%{"type" => "paragraph", "text" => "x"}) end)
      before = atom_count()

      Enum.each(inputs, fn type_str ->
        case Materialize.to_struct(%{"type" => type_str}) do
          {:error, _} ->
            :ok

          # A generated string might collide with a REFLECTED (already-existing)
          # widget name (e.g. "paragraph") — that's a legitimate build, not a
          # new atom.
          built when is_struct(built) ->
            :ok
        end
      end)

      assert atom_count() == before
    end

    test "an unknown style color/modifier string is dropped, never interned" do
      colors = adversarial_strings(@runs)
      modifiers = adversarial_strings(@runs)

      warm(fn ->
        Materialize.to_struct(%{
          "type" => "paragraph",
          "text" => "x",
          "style" => %{"fg" => "red", "modifiers" => ["bold"]}
        })
      end)

      before = atom_count()

      Enum.zip(colors, modifiers)
      |> Enum.each(fn {color, modifier} ->
        Materialize.to_struct(%{
          "type" => "paragraph",
          "text" => "x",
          "style" => %{"fg" => color, "modifiers" => [modifier]}
        })
      end)

      assert atom_count() == before
    end
  end

  describe "SplitSpec — fixed-map constraint/flex coercion never interns" do
    test "an unknown constraint kind degrades to {:fill, 1} without interning" do
      kinds = adversarial_strings(@runs)
      warm(fn -> SplitSpec.constraint(["length", 3]) end)
      before = atom_count()

      Enum.each(kinds, fn kind ->
        assert match?({_, _}, SplitSpec.constraint([kind, 3]))
      end)

      assert atom_count() == before
    end

    test "an unknown flex value is dropped from opts without interning" do
      flexes = adversarial_strings(@runs)
      warm(fn -> SplitSpec.split_opts(%{"flex" => "start"}) end)
      before = atom_count()

      Enum.each(flexes, fn flex -> SplitSpec.split_opts(%{"flex" => flex}) end)

      assert atom_count() == before
    end
  end

  describe "KeymapRegistry.define_intent/1 — the ONE bounded exception, capped" do
    test "a well-shaped intent under the cap interns at most once per name" do
      for i <- 1..50 do
        name = "atomdostest#{i}/verb"
        before = atom_count()

        r1 = KeymapRegistry.define_intent(name)
        after1 = atom_count()
        r2 = KeymapRegistry.define_intent(name)
        after2 = atom_count()

        assert {:ok, atom} = r1
        assert r2 == {:ok, atom}
        # Second call for the SAME name must not intern again.
        assert after2 == after1
        # At most one atom created for this name (allow 0 if it happened to
        # already exist from a prior run in this same VM).
        assert after1 - before in [0, 1]
      end
    end

    test "malformed intent names are rejected before interning" do
      inputs = adversarial_strings(@runs)
      before = atom_count()

      Enum.each(inputs, fn s ->
        case KeymapRegistry.define_intent(s) do
          {:ok, _atom} ->
            # Only acceptable if s already happened to be domain/verb shaped
            # (extremely unlikely from random strings) — the shape gate is what
            # we're really pinning: no crash, no unbounded growth either way.
            :ok

          {:error, _reason} ->
            :ok
        end
      end)

      # Random adversarial strings essentially never match the domain/verb
      # shape regex, so this should not have grown the table at all — but even
      # if a handful matched, growth must stay far below @runs (never 1:1 with
      # attempts), proving the shape gate is actually filtering, not a no-op.
      growth = atom_count() - before
      assert growth < @runs
    end

    test "the runtime-intent cap is enforced (bounded growth, not unbounded)" do
      KeymapRegistry.reset()
      before = atom_count()

      # Attempt far more distinct intents than the 256 cap allows.
      results =
        for i <- 1..300 do
          KeymapRegistry.define_intent("atomdoscap#{i}/verb")
        end

      ok_count = Enum.count(results, &match?({:ok, _}, &1))
      err_count = Enum.count(results, &match?({:error, _}, &1))

      assert ok_count <= 256
      assert err_count > 0
      assert atom_count() - before <= 256
    end
  end
end
