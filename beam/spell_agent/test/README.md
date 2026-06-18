# SpellAgent Test Infrastructure

Comprehensive testing framework for the BEAM spell_agent following ex_ratatui patterns.

## Test Layers

### 1. Visual Testing (`test/support/headless_harness.ex`)
- Headless terminal rendering without TTY
- Cell-level style assertions
- Snapshot testing for visual regression
- Text pattern matching

### 2. Property Testing (`test/support/dsl_generators.ex`)
- PTC-Lisp source generators (valid/invalid)
- Telemetry event stream generators
- Forest structure generators with parent-child relationships
- UI state and cursor operation generators

### 3. Behavioral Testing (`test/spell_agent/tui/behavior_test.exs`)
- Navigation: tab cycling, cursor movement, tree expand/collapse
- Store integration with telemetry events
- Prompt submission and clearing
- Visual feedback and selection
- Error state handling

### 4. DSL Property Tests (`test/spell_agent/tools/dsl_property_test.exs`)
- Tool definition invariants
- Referential transparency validation
- Parameter binding correctness
- Meta-tool protection
- Registry consistency

### 5. Integration Testing (`test/spell_agent/integration/agent_loop_test.exs`)
- Full agent loops with mock LLM
- Tool definition and usage
- Multi-turn conversations
- Error recovery
- Telemetry integration

### 6. Performance Benchmarks (`test/spell_agent/benchmarks/performance_test.exs`)
- Tool execution: <1ms simple, <10ms chains
- Store: 10k events in <1s
- TUI: 1000 spans render in <100ms
- Memory bounds verification

## Running Tests

```bash
# All tests
mix test

# Specific categories
mix test --only property      # Property tests
mix test --only benchmark     # Performance benchmarks
mix test test/spell_agent/integration  # Integration tests

# With coverage
mix test --cover
mix coveralls.html

# Visual test browser
mix visual_test_browser [--baseline] [--diffs] [--live]
```

## Visual Test Browser

Interactive TUI for browsing test outputs:

- **List Mode**: Navigate snapshots, diffs, and live components
- **View Mode**: Zoom in/out, view metadata, save as baseline
- **Compare Mode**: Side-by-side baseline vs current with diff overlay

### Keyboard Shortcuts

| Mode | Key | Action |
|------|-----|--------|
| All | `q` | Quit |
| All | `Esc` | Back to list |
| List | `↑/↓` | Navigate |
| List | `Enter` | View item |
| List | `/` | Filter |
| List | `r` | Refresh |
| View | `+/-` | Zoom |
| View | `s` | Save as baseline |
| Compare | `Tab` | Toggle view |
| Compare | `d` | Overlay diff |

## CI Integration

GitHub Actions workflow (`.github/workflows/beam-tests.yml`):

- Matrix testing: OTP 26/27, Elixir 1.16/1.17
- Coverage reporting with ExCoveralls
- Property tests with deterministic seeds
- Performance benchmarks
- Visual regression artifacts

## Test Patterns

### Property Test Example
```elixir
property "tools preserve referential transparency" do
  check all source <- deterministic_ptc_gen(),
            params <- tool_params_gen() do
    tool = define_and_invoke(source, params)
    assert invoke(tool, params) == invoke(tool, params)
  end
end
```

### Behavioral Test Example
```elixir
test "tab cycles through panes" do
  {:ok, app} = start_test_app()
  
  initial_focus = get_focus(app)
  inject_key(app, "tab")
  new_focus = get_focus(app)
  
  assert new_focus != initial_focus
end
```

### Visual Assertion Example
```elixir
test "renders tree structure correctly" do
  harness = HeadlessHarness.new()
  component = SpanTree.new(spans: test_forest())
  
  harness
  |> render(component)
  |> assert_text("▼ [run] main")
  |> assert_style_at(4, 1, %{fg: :cyan, modifiers: [:bold]})
end
```

## Dependencies

Add to `mix.exs`:
```elixir
{:stream_data, "~> 1.1", only: [:test]},
{:excoveralls, "~> 0.18", only: [:test]},
{:benchee, "~> 1.3", only: [:dev, :test]},
{:mox, "~> 1.2", only: [:test]}
```

## Philosophy

1. **Behavioral First**: Test what the system does, not how
2. **Property-Driven**: Explore state space with generators
3. **Visual Confidence**: See what users see
4. **Fast Feedback**: Tests run in milliseconds
5. **Production-Like**: Real supervisors, real telemetry