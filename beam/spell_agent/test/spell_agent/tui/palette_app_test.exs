defmodule SpellAgent.Tui.PaletteAppTest do
  @moduledoc """
  FEAT-047 W2: the command palette wired into the App's modal input path.

  Drives real key events through `App.handle_event/2` to defend the input-level
  contract the oracle gated (agent 30): C-p opens; typing filters; Enter fires
  the selected binding through the SHARED `apply_intent/2` (so App-only intents
  like app/quit → {:stop} actually work, not silently no-op); Esc and the
  out-of-band C-r both recover; an open palette consumes keys (no leak).
  """
  use ExUnit.Case, async: false

  alias SpellAgent.Tui.{App, KeymapIntrospect, Palette, Store, Ui}
  alias ExRatatui.Event.Key
  alias ExRatatui.Frame

  setup do
    {:ok, store} = Store.start_link(name: nil)
    %{store: store}
  end

  defp key(code, mods \\ []), do: %Key{code: code, kind: "press", modifiers: mods}

  defp state(store, overrides) do
    Map.merge(
      %{
        store: store,
        panes: [
          %{name: :tree, module: SpellAgent.Tui.Panes.SpanTree, assigns: %{}},
          %{name: :detail, module: SpellAgent.Tui.Panes.Detail, assigns: %{}}
        ],
        vms: %{tree: %{rows: [], count: 0}, detail: %{title: "detail", body: "(empty)"}},
        composer: "",
        on_submit: fn _ -> :ok end,
        running?: false,
        result: nil,
        last_prompt: nil,
        pending_leader: false,
        data_cache: nil,
        hist_store: nil,
        hist_session: nil,
        data_sources: %{"keybindings" => KeymapIntrospect.rows()},
        ui: Ui.new(focus: :tree, panes: [:prompt, :tree, :detail])
      },
      overrides
    )
  end

  defp open_state(store, overrides \\ %{}) do
    {:noreply, opened} = App.handle_event(key("p", ["ctrl"]), state(store, overrides))
    opened
  end

  test "C-p opens the palette (modal flag set)", %{store: store} do
    assert Palette.open?(open_state(store).ui)
  end

  test "the palette overlay renders when open", %{store: store} do
    placements = App.render(open_state(store), %Frame{width: 100, height: 40})

    text =
      Enum.map_join(placements, "\n", fn {w, _r} -> inspect(w) end)

    assert text =~ "commands"
  end

  test "typing filters the query; Esc closes", %{store: store} do
    {:noreply, s1} = App.handle_event(key("o"), open_state(store))
    assert Palette.query(s1.ui) == "o"

    {:noreply, s2} = App.handle_event(key("esc"), s1)
    refute Palette.open?(s2.ui)
  end

  test "Enter fires the selected binding through the shared intent path", %{store: store} do
    # Filter to the cockpit binding, then fire it. app/cockpit is App-intercepted
    # in apply_intent (Cockpit.show + reproject) — it must NOT silently no-op.
    opened = open_state(store)
    {:noreply, filtered} = App.handle_event(key("c"), opened)
    {:noreply, filtered} = App.handle_event(key("o"), filtered)
    {:noreply, filtered} = App.handle_event(key("c"), filtered)
    {:noreply, filtered} = App.handle_event(key("k"), filtered)
    {:noreply, filtered} = App.handle_event(key("p"), filtered)
    {:noreply, filtered} = App.handle_event(key("i"), filtered)
    {:noreply, filtered} = App.handle_event(key("t"), filtered)

    # Only the cockpit row matches "cockpit".
    assert Palette.filter(KeymapIntrospect.rows(), Palette.query(filtered.ui)) |> length() == 1

    result = App.handle_event(key("enter"), filtered)
    # Firing closes the palette and applies app/cockpit (a {:noreply, state}).
    assert {:noreply, after_fire} = result
    refute Palette.open?(after_fire.ui)
  end

  test "Enter on the app/quit row STOPS the app (proves App-only intents fire)", %{store: store} do
    # Type "quit" to isolate the app/quit binding, then Enter.
    opened = open_state(store)

    typed =
      Enum.reduce(String.graphemes("quit"), opened, fn ch, acc ->
        {:noreply, next} = App.handle_event(key(ch), acc)
        next
      end)

    # "quit" isolates the app/quit intent (bound to both esc and C-c — either row
    # fires the same intent). Every match is app/quit.
    quit_rows = Palette.filter(KeymapIntrospect.rows(), "quit")
    assert quit_rows != []
    assert Enum.all?(quit_rows, &(&1["intent"] == "app/quit"))
    # app/quit routed through apply_intent returns {:stop, _} — the palette did
    # NOT swallow it into a no-op (the whole point of the shared path).
    assert {:stop, _state} = App.handle_event(key("enter"), typed)
  end

  test "the out-of-band C-r closes a wedged palette (emergency escape)", %{store: store} do
    opened = open_state(store)
    assert Palette.open?(opened.ui)
    {:noreply, reset} = App.handle_event(key("r", ["ctrl"]), opened)
    refute Palette.open?(reset.ui)
  end

  test "an open palette consumes an unbound key (no leak to normal mode)", %{store: store} do
    opened = open_state(store)
    # A stray function-ish key that is neither printable nor a palette control:
    # the palette stays open and unchanged, nothing dispatched.
    {:noreply, after_key} = App.handle_event(key("f5"), opened)
    assert Palette.open?(after_key.ui)
  end
end
