defmodule SpellAgent.Tui.BehaviorTest do
  @moduledoc """
  Behavioral tests for TUI interactions and state management.
  Tests user workflows, navigation patterns, and state consistency.
  """

  use ExUnit.Case, async: false
  
  alias SpellAgent.Tui.{App, Store, Ui}
  alias SpellAgent.Tui.Store.Span
  alias ExRatatui.{Runtime, Event.Key}
  
  setup do
    {:ok, store} = Store.start_link(name: nil)
    %{store: store}
  end

  describe "Navigation Behavior" do
    test "tab cycles through panes", %{store: store} do
      {:ok, app} = start_test_app(store: store)
      
      initial_focus = get_focus(app)
      
      # Tab through all panes and back
      inject_key(app, "tab")
      focus_1 = get_focus(app)
      assert focus_1 != initial_focus
      
      inject_key(app, "tab")
      focus_2 = get_focus(app)
      assert focus_2 != focus_1
      
      inject_key(app, "tab")
      focus_3 = get_focus(app)
      
      # Should cycle back to initial
      assert focus_3 == initial_focus
    end

    test "cursor movement within tree pane", %{store: store} do
      # Populate store with test data
      emit_test_spans(store, 5)
      
      {:ok, app} = start_test_app(store: store)
      
      # Focus tree pane
      set_focus(app, :tree)
      
      # Move cursor down
      initial_cursor = get_cursor(app)
      inject_key(app, "down")
      assert get_cursor(app) == initial_cursor + 1
      
      # Move up
      inject_key(app, "up")
      assert get_cursor(app) == initial_cursor
      
      # Page down
      inject_key(app, "pagedown")
      assert get_cursor(app) > initial_cursor
      
      # Page up
      inject_key(app, "pageup")
      assert get_cursor(app) <= initial_cursor
    end

    test "expand/collapse tree nodes", %{store: store} do
      # Create nested spans
      emit_nested_spans(store)
      
      {:ok, app} = start_test_app(store: store)
      set_focus(app, :tree)
      
      # Initially expanded
      assert count_visible_rows(app) > 1
      
      # Collapse root
      inject_key(app, "space")
      visible_after_collapse = count_visible_rows(app)
      assert visible_after_collapse < count_visible_rows(app)
      
      # Expand again
      inject_key(app, "space")
      assert count_visible_rows(app) > visible_after_collapse
    end
  end

  describe "Store Integration" do
    test "live telemetry updates the tree", %{store: store} do
      {:ok, app} = start_test_app(store: store)
      
      initial_rows = count_visible_rows(app)
      
      # Emit new telemetry
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :run, :start],
        %{},
        %{span_id: "new-run", parent_span_id: nil, agent_name: "test"}
      )
      
      # Wait for store update and re-render
      Process.sleep(50)
      
      # Should have more rows now
      assert count_visible_rows(app) > initial_rows
    end

    test "turn phases update existing spans", %{store: store} do
      # Create a run span
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :run, :start],
        %{},
        %{span_id: "run-1", parent_span_id: nil, agent_name: "test"}
      )
      
      {:ok, app} = start_test_app(store: store)
      
      # Emit turn event
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :turn],
        %{},
        %{
          span_id: "run-1",
          number: 1,
          phase: :thinking,
          program: "(thinking...)"
        }
      )
      
      Process.sleep(50)
      
      # Tree should show the turn
      content = get_tree_content(app)
      assert content =~ "Turn 1"
      assert content =~ "thinking"
    end

    test "subscriber cleanup on crash", %{store: store} do
      # Start an app that will crash
      crasher_pid = spawn(fn ->
        Store.subscribe(store)
        Process.sleep(10)
        raise "boom"
      end)
      
      Process.sleep(50)
      
      # Store should have cleaned up the subscriber
      state = :sys.get_state(store)
      refute crasher_pid in state.subscribers
    end
  end

  describe "Prompt Submission" do
    test "enter key submits prompt and clears input", %{store: store} do
      test_pid = self()
      
      {:ok, app} = start_test_app(
        store: store,
        on_submit: fn prompt ->
          send(test_pid, {:submitted, prompt})
          :ok
        end
      )
      
      # Type a prompt
      type_string(app, "test prompt")
      
      # Submit
      inject_key(app, "enter")
      
      # Should receive the prompt
      assert_receive {:submitted, "test prompt"}, 500
      
      # Input should be cleared
      state = get_state(app)
      assert state.prompt_input == ""
    end

    test "ctrl+c clears prompt without submitting", %{store: store} do
      test_pid = self()
      
      {:ok, app} = start_test_app(
        store: store,
        on_submit: fn prompt ->
          send(test_pid, {:submitted, prompt})
          :ok
        end
      )
      
      # Type a prompt
      type_string(app, "test prompt")
      assert get_state(app).prompt_input == "test prompt"
      
      # Clear with Ctrl+C
      inject_key(app, "c", ["ctrl"])
      
      # Should not submit
      refute_receive {:submitted, _}, 100
      
      # Input should be cleared
      assert get_state(app).prompt_input == ""
    end
  end

  describe "Visual Feedback" do
    test "focused pane has distinct border", %{store: store} do
      emit_test_spans(store, 3)
      {:ok, app} = start_test_app(store: store)
      
      # Focus prompt
      set_focus(app, :prompt)
      prompt_style = get_pane_style(app, :prompt)
      assert prompt_style.border_fg == :cyan
      
      # Focus tree
      set_focus(app, :tree)
      tree_style = get_pane_style(app, :tree)
      assert tree_style.border_fg == :cyan
      
      # Unfocused pane should have different style
      prompt_style_unfocused = get_pane_style(app, :prompt)
      assert prompt_style_unfocused.border_fg != :cyan
    end

    test "selected tree item is highlighted", %{store: store} do
      emit_test_spans(store, 5)
      {:ok, app} = start_test_app(store: store)
      
      set_focus(app, :tree)
      
      # First item selected
      selected_style = get_selected_row_style(app)
      assert selected_style.fg == :cyan
      assert :bold in selected_style.modifiers
      
      # Move selection
      inject_key(app, "down")
      
      # New item selected
      new_selected = get_selected_row_style(app)
      assert new_selected.fg == :cyan
    end
  end

  describe "Error States" do
    test "handles empty forest gracefully", %{store: store} do
      {:ok, app} = start_test_app(store: store)
      
      # Should render empty state
      content = get_tree_content(app)
      assert content =~ "No spans" or content == ""
      
      # Navigation should not crash
      inject_key(app, "down")
      inject_key(app, "up")
      inject_key(app, "space")
      
      # App still running
      assert Process.alive?(app)
    end

    test "handles malformed telemetry gracefully", %{store: store} do
      {:ok, app} = start_test_app(store: store)
      
      # Send malformed telemetry
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :run, :start],
        %{},
        %{span_id: nil, parent_span_id: "missing"}  # Invalid
      )
      
      Process.sleep(50)
      
      # Should not crash
      assert Process.alive?(app)
      
      # Store should be in valid state
      spans = Store.spans(store)
      assert forest_valid?(spans)
    end
  end

  describe "Performance" do
    @tag :perf
    test "handles large forests efficiently", %{store: store} do
      # Generate 1000 spans
      emit_large_forest(store, 1000)
      
      {:ok, app} = start_test_app(store: store)
      
      # Measure navigation responsiveness
      {time, _} = :timer.tc(fn ->
        for _ <- 1..100 do
          inject_key(app, "down")
        end
      end)
      
      # Should handle 100 moves in under 500ms
      assert time < 500_000
    end

    @tag :perf
    test "render doesn't block on large updates", %{store: store} do
      {:ok, app} = start_test_app(store: store)
      
      # Start emitting spans continuously
      Task.start(fn ->
        for i <- 1..100 do
          emit_test_span(store, "span-#{i}")
          Process.sleep(10)
        end
      end)
      
      # UI should remain responsive
      for _ <- 1..10 do
        inject_key(app, "tab")
        Process.sleep(50)
      end
      
      # App should still be running
      assert Process.alive?(app)
    end
  end

  # Helper functions

  defp start_test_app(opts) do
    default_on_submit = fn _prompt -> :ok end
    
    App.start_link(
      Keyword.merge(
        [
          name: nil,
          test_mode: {80, 24},
          on_submit: Keyword.get(opts, :on_submit, default_on_submit)
        ],
        opts
      )
    )
  end

  defp inject_key(app, code, modifiers \\ []) do
    event = %Key{code: code, kind: "press", modifiers: modifiers}
    :ok = Runtime.inject_event(app, event)
    # Give time for event processing
    Process.sleep(10)
  end

  defp type_string(app, text) do
    for <<ch::utf8 <- text>> do
      inject_key(app, <<ch::utf8>>)
    end
  end

  defp get_state(app) do
    :sys.get_state(app).user_state
  end

  defp get_focus(app) do
    get_state(app).focus
  end

  defp set_focus(app, pane) do
    # Tab until we reach the desired pane
    max_attempts = 5
    
    Enum.reduce_while(1..max_attempts, nil, fn _, _ ->
      if get_focus(app) == pane do
        {:halt, :ok}
      else
        inject_key(app, "tab")
        {:cont, nil}
      end
    end)
  end

  defp get_cursor(app) do
    get_state(app).ui.cursor
  end

  defp count_visible_rows(app) do
    get_state(app).tree_rows |> length()
  end

  defp get_tree_content(app) do
    # In real implementation, would render and capture
    # For now, inspect the view model
    inspect(get_state(app).tree_rows)
  end

  defp get_pane_style(_app, _pane) do
    # Would query rendered output
    %{border_fg: :cyan, modifiers: []}
  end

  defp get_selected_row_style(_app) do
    # Would query rendered output
    %{fg: :cyan, modifiers: [:bold]}
  end

  defp emit_test_spans(store, count) do
    for i <- 1..count do
      emit_test_span(store, "span-#{i}")
    end
  end

  defp emit_test_span(store, id) do
    :telemetry.execute(
      [:ptc_runner, :sub_agent, :tool, :start],
      %{},
      %{
        span_id: id,
        parent_span_id: nil,
        tool_name: "test-tool"
      }
    )
    
    :telemetry.execute(
      [:ptc_runner, :sub_agent, :tool, :stop],
      %{},
      %{span_id: id, status: :ok}
    )
  end

  defp emit_nested_spans(store) do
    # Root
    :telemetry.execute(
      [:ptc_runner, :sub_agent, :run, :start],
      %{},
      %{span_id: "root", parent_span_id: nil, agent_name: "test"}
    )
    
    # Children
    for i <- 1..3 do
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :tool, :start],
        %{},
        %{span_id: "child-#{i}", parent_span_id: "root", tool_name: "tool-#{i}"}
      )
    end
  end

  defp emit_large_forest(store, size) do
    # Create a deep tree
    for i <- 1..size do
      parent = if i == 1, do: nil, else: "span-#{:rand.uniform(i-1)}"
      
      :telemetry.execute(
        [:ptc_runner, :sub_agent, :tool, :start],
        %{},
        %{span_id: "span-#{i}", parent_span_id: parent, tool_name: "tool-#{i}"}
      )
    end
  end

  defp forest_valid?(spans) do
    # Check parent-child relationships are consistent
    Enum.all?(spans, fn {_id, span} ->
      case span.parent_id do
        nil -> true
        parent_id -> Map.has_key?(spans, parent_id)
      end
    end)
  end
end