defmodule SpellAgent.Tui.DefaultLayoutPresentationTest do
  @moduledoc """
  PLAN-027 M3 (FUP-038): the status strip's label+color and the composer's
  text+title+fg are DERIVED by a PTC projection in `default_layout.ptc`
  (`presentation`), frozen into layout holes by `DefaultLayout` — no longer by
  Elixir in `DataBag`. This test pins the DERIVATION CONTRACT: the layout's
  presentation holes, resolved against the raw `data/*` inputs, produce the exact
  strings + colors the retired Elixir `*_presentation` functions did, across
  every branch (running/done/failed/idle, insert/normal), and never-brick when
  the data is malformed.
  """
  # async: false — the never-brick test mutates the GLOBAL `:persistent_term`
  # DefaultLayout data cache, which any other test reading `DefaultLayout.tree/*`
  # shares. Running serially prevents that contamination (the demo-9 / hole-
  # resolver splice tests read the default layout concurrently).
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{DefaultLayout, HoleResolver, Lens, Ui}

  # Resolve the status/composer slot text (or a style/title field) against a raw
  # data/* env, exactly as the render loop does.
  defp resolve(slot, field, env) do
    tree = DefaultLayout.tree(Ui.new(focus: :prompt, mode: :normal))
    node = Lens.at(tree, slot)
    resolved = HoleResolver.resolve_holes(node, env)
    get_in_field(resolved, field)
  end

  defp get_in_field(node, :text), do: node["text"]
  defp get_in_field(node, :color), do: node["style"]["fg"]
  defp get_in_field(node, :title), do: node["block"]["title"]

  defp status_env(overrides) do
    base = %{"running?" => false, "result" => nil, "turns" => 0, "tools" => 0}
    %{"status" => Map.merge(base, overrides), "ui" => %{"mode" => "normal"}, "composer" => "", "composer-hint" => ""}
  end

  defp composer_env(mode, composer, hint) do
    %{
      "status" => %{"running?" => false, "result" => nil, "turns" => 0, "tools" => 0},
      "ui" => %{"mode" => mode},
      "composer" => composer,
      "composer-hint" => hint
    }
  end

  describe "status label (byte-identical to the retired Elixir derivation)" do
    test "running" do
      env = status_env(%{"running?" => true, "turns" => 3, "tools" => 5})
      assert resolve("status", :text, env) == "● running…  turns 3 · tools 5"
      assert resolve("status", :color, env) == "yellow"
    end

    test "done (ok)" do
      env = status_env(%{"result" => "ok", "turns" => 2, "tools" => 1})
      assert resolve("status", :text, env) == "✓ done  turns 2 · tools 1"
      assert resolve("status", :color, env) == "green"
    end

    test "failed (error)" do
      env = status_env(%{"result" => "error", "turns" => 4, "tools" => 2})
      assert resolve("status", :text, env) == "✗ failed  turns 4 · tools 2"
      assert resolve("status", :color, env) == "red"
    end

    test "done (generic non-nil result)" do
      env = status_env(%{"result" => "done", "turns" => 1, "tools" => 0})
      assert resolve("status", :text, env) == "✓ done  turns 1 · tools 0"
      assert resolve("status", :color, env) == "green"
    end

    test "idle" do
      env = status_env(%{})
      assert resolve("status", :text, env) == "idle — type a prompt below, then ↵"
      assert resolve("status", :color, env) == "dark_gray"
    end
  end

  describe "composer (byte-identical to the retired Elixir derivation)" do
    test "idle shows the hint, NORMAL title, dark_gray" do
      env = composer_env("normal", "", "type…")
      assert resolve("composer", :text, env) == "type…"
      assert resolve("composer", :title, env) == " prompt — NORMAL "
      assert resolve("composer", :color, env) == "dark_gray"
    end

    test "insert shows composer + cursor glyph, INSERT title, white" do
      env = composer_env("insert", "hi", "h")
      assert resolve("composer", :text, env) == "hi▎"
      assert resolve("composer", :title, env) == " prompt — INSERT "
      assert resolve("composer", :color, env) == "white"
    end

    test "normal with typed text shows the text, white" do
      env = composer_env("normal", "abc", "h")
      assert resolve("composer", :text, env) == "abc"
      assert resolve("composer", :color, env) == "white"
    end
  end

  describe "never-brick (the compiled fallback floor)" do
    test "a corrupt presentation data file falls back to the compiled derivation" do
      # Force the data cache to a map whose presentation entries are malformed;
      # DefaultLayout must still freeze the compiled floor (identical output).
      :persistent_term.put({DefaultLayout, :data}, %{"presentation" => %{"status-label" => 12345}})
      on_exit(fn -> DefaultLayout.reload() end)

      env = status_env(%{"running?" => true, "turns" => 1, "tools" => 1})
      out = resolve("status", :text, env)
      # Restore the GLOBAL persistent_term cache IMMEDIATELY (not just on_exit) so
      # the corruption window can't contaminate a concurrent test reading the
      # default layout.
      DefaultLayout.reload()
      assert out == "● running…  turns 1 · tools 1"
    end

    test "a NON-MAP presentation section falls back to the floor, never BadMapError (review Sβ P1)" do
      # The malformed shape the reviewer flagged: `presentation` is a valid
      # top-level entry but its VALUE is a string, not a map. Map.get/2 on a
      # non-map would raise BadMapError and brick the render path; the guard must
      # route it to the compiled floor instead.
      :persistent_term.put({DefaultLayout, :data}, %{"presentation" => "not a map"})
      on_exit(fn -> DefaultLayout.reload() end)

      env = status_env(%{"result" => "error", "turns" => 2, "tools" => 0})
      cenv = composer_env("insert", "hi", "h")
      # Capture all three derivations against the corrupted cache, THEN restore
      # the global immediately (before asserting) so a concurrent reader never
      # sees the corrupt value.
      status_text = resolve("status", :text, env)
      status_color = resolve("status", :color, env)
      composer_text = resolve("composer", :text, cenv)
      DefaultLayout.reload()

      assert status_text == "✗ failed  turns 2 · tools 0"
      assert status_color == "red"
      assert composer_text == "hi▎"
    end
  end
end
