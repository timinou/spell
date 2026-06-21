defmodule SpellAgent.SessionTest do
  use ExUnit.Case, async: false

  alias SpellAgent.{Config, Session, ToolRegistry}

  setup do
    for e <- ToolRegistry.all(), do: ToolRegistry.remove(e.name)
    Config.put("model", "claude-sonnet-4-5-20250929")
    :ok
  end

  test "system_prompt mentions the homoiconic define-tool capability" do
    sp = Session.system_prompt()
    assert sp =~ "define-tool"
    assert sp =~ "data/"
  end

  test "system_prompt includes the reflected freeform-TUI prelude (PLAN-009)" do
    sp = Session.system_prompt()
    # The capability is always advertised, and the builder table is reflected
    # from the widget registry (no drift).
    assert sp =~ "layout/set"
    assert sp =~ "view/paragraph"
    assert sp =~ "theme/set"
    # A reflected widget that is NOT in the static frame proves the table is
    # generated from Reflect, not hand-written.
    assert sp =~ "view/gauge"
  end

  test "system_prompt appends a live config addendum" do
    Config.put("system-addendum", "EXTRA-DIRECTIVE-XYZ")
    assert Session.system_prompt() =~ "EXTRA-DIRECTIVE-XYZ"
  after
    Config.put("system-addendum", nil)
  end

  # Live: the full node-free loop over the real subscription.
  describe "live [requires agent.db + network]" do
    @describetag :live

    setup do
      case SpellAgent.Credentials.load("anthropic") do
        {:ok, _} -> :ok
        {:error, reason} -> {:skip, "no anthropic credential: #{inspect(reason)}"}
      end
    end

    test "answers a simple arithmetic mission" do
      assert {:ok, result} = Session.run("What is 17 + 25? Reply with just the number.")
      assert to_string(result) =~ "42"
    end

    test "homoiconic loop: defines a tool at runtime then calls it" do
      prompt = """
      Do these steps in order, using PTC-Lisp programs:
      1. Call (tool/define-tool {:name "triple" :params [:n] :doc "multiply by 3" :source "(* 3 data/n)"}).
      2. Then call (tool/triple {:n 14}) and (return) its result.
      Report only the final number.
      """

      assert {:ok, result} = Session.run(prompt)
      assert to_string(result) =~ "42"
      # The agent-authored tool is now registered.
      assert "triple" in Enum.map(ToolRegistry.all(), & &1.name)
    end
  end
end
