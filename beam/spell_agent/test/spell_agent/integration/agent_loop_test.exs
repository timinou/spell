defmodule SpellAgent.Integration.AgentLoopTest do
  @moduledoc """
  Integration tests for full agent loops.
  Tests complete workflows from prompt to tool execution to result.
  """

  use ExUnit.Case, async: false
  
  alias SpellAgent.{Session, Tools, ToolRegistry, Config}
  alias SpellAgent.Tui.Store
  
  setup do
    # Start fresh registry and config for each test
    {:ok, registry} = ToolRegistry.start_link(name: nil)
    {:ok, config} = Config.start_link(name: nil)
    {:ok, store} = Store.start_link(name: nil)
    
    on_exit(fn ->
      if Process.alive?(registry), do: GenServer.stop(registry)
      if Process.alive?(config), do: GenServer.stop(config)
      if Process.alive?(store), do: GenServer.stop(store)
    end)
    
    %{registry: registry, config: config, store: store}
  end

  describe "Tool Definition and Usage" do
    test "agent defines and immediately uses a custom tool" do
      # Mock LLM that defines a tool then uses it
      llm = build_mock_llm([
        # Turn 1: Define the tool
        %{
          content: [%{
            type: "text",
            text: "I'll define a reusable tool for getting file stats."
          }, %{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: """
              (tool/define-tool {:name "file-stats"
                                :params [:path]
                                :doc "Get size and line count of a file"
                                :source "(str \\"Size: 1024 bytes, Lines: 42\\")"})
              """
            }
          }]
        },
        # Turn 2: Use the defined tool
        %{
          content: [%{
            type: "text",
            text: "Now I'll use the file-stats tool to check main.ex"
          }, %{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/file-stats {:path \"main.ex\"})"
            }
          }]
        },
        # Turn 3: Return result
        %{
          content: [%{
            type: "text",
            text: "File stats retrieved: Size: 1024 bytes, Lines: 42"
          }]
        }
      ])
      
      result = Session.run("check the stats of main.ex", llm: llm, max_turns: 3)
      
      assert {:ok, response} = result
      assert response =~ "1024 bytes"
      assert response =~ "42"
      
      # Verify tool was registered
      tools = ToolRegistry.all()
      assert Enum.any?(tools, &(&1.name == "file-stats"))
    end

    test "agent chains multiple tool definitions" do
      llm = build_mock_llm([
        # Define first tool
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: """
              (tool/define-tool {:name "doubler"
                                :params [:n]
                                :doc "Double a number"
                                :source "(* 2 data/n)"})
              """
            }
          }]
        },
        # Define second tool that uses first
        %{
          content: [%{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: """
              (tool/define-tool {:name "quadrupler"
                                :params [:n]
                                :doc "Quadruple a number"
                                :source "(tool/doubler {:n (tool/doubler {:n data/n})})"})
              """
            }
          }]
        },
        # Use the composed tool
        %{
          content: [%{
            type: "tool_use",
            id: "call_3",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/quadrupler {:n 10})"
            }
          }]
        },
        # Return result
        %{
          content: [%{
            type: "text",
            text: "Result: 40"
          }]
        }
      ])
      
      result = Session.run("quadruple the number 10", llm: llm, max_turns: 4)
      
      assert {:ok, response} = result
      assert response =~ "40"
      
      # Both tools should be registered
      tools = ToolRegistry.all()
      tool_names = Enum.map(tools, & &1.name)
      assert "doubler" in tool_names
      assert "quadrupler" in tool_names
    end
  end

  describe "Error Recovery" do
    test "agent handles tool execution failure gracefully" do
      # Pre-register a failing tool
      ToolRegistry.put(%{
        kind: :ptc,
        name: "failer",
        params: [],
        doc: "Always fails",
        source: "(fail \"Intentional failure for testing\")"
      })
      
      llm = build_mock_llm([
        # Try to use the failing tool
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/failer {})"
            }
          }]
        },
        # Acknowledge the error and recover
        %{
          content: [%{
            type: "text",
            text: "I see the tool failed. Let me try a different approach."
          }, %{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: "(str \"Recovered from failure\")"
            }
          }]
        },
        # Return recovery message
        %{
          content: [%{
            type: "text",
            text: "Successfully recovered from the tool failure."
          }]
        }
      ])
      
      result = Session.run("use the failer tool", llm: llm, max_turns: 3)
      
      assert {:ok, response} = result
      assert response =~ "recovered"
    end

    test "agent handles malformed PTC gracefully" do
      llm = build_mock_llm([
        # Submit malformed PTC
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: "(this-function-does-not-exist 123"  # Missing closing paren
            }
          }]
        },
        # Acknowledge parse error and fix
        %{
          content: [%{
            type: "text",
            text: "I see there was a syntax error. Let me fix it."
          }, %{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: "(str \"Fixed the syntax\")"
            }
          }]
        },
        # Return success
        %{
          content: [%{
            type: "text",
            text: "Syntax corrected and executed successfully."
          }]
        }
      ])
      
      result = Session.run("test error recovery", llm: llm, max_turns: 3)
      
      assert {:ok, response} = result
      assert response =~ "successfully"
    end
  end

  describe "Multi-Turn Conversations" do
    test "context accumulates across turns" do
      llm = build_mock_llm([
        # Turn 1: Define a stateful tool
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: """
              (do
                (tool/define-config {:key "counter" :value 0})
                (tool/define-tool {:name "increment"
                                  :params []
                                  :doc "Increment counter"
                                  :source "(let [c (tool/get-config {:key \\"counter\\"})]
                                            (tool/define-config {:key \\"counter\\" :value (+ c 1)})
                                            (+ c 1))"})
                "Counter initialized")
              """
            }
          }]
        },
        # Turn 2: Increment
        %{
          content: [%{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/increment {})"
            }
          }]
        },
        # Turn 3: Increment again
        %{
          content: [%{
            type: "tool_use",
            id: "call_3",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/increment {})"
            }
          }]
        },
        # Turn 4: Check value
        %{
          content: [%{
            type: "tool_use",
            id: "call_4",
            name: "ptc_lisp_repl",
            input: %{
              program: "(str \"Counter is now: \" (tool/get-config {:key \"counter\"}))"
            }
          }]
        },
        # Final response
        %{
          content: [%{
            type: "text",
            text: "Counter has been incremented to 2"
          }]
        }
      ])
      
      result = Session.run("create and increment a counter twice", llm: llm, max_turns: 5)
      
      assert {:ok, response} = result
      assert response =~ "2"
      
      # Verify config was updated
      assert Config.get("counter") == 2
    end
  end

  describe "Telemetry Integration" do
    test "agent actions emit telemetry events", %{store: store} do
      # Subscribe to store updates
      Store.subscribe(store)
      
      llm = build_mock_llm([
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: "(list 1 2 3)"
            }
          }]
        },
        %{
          content: [%{
            type: "text",
            text: "Computed list: [1, 2, 3]"
          }]
        }
      ])
      
      # Attach telemetry handler
      Store.attach(store)
      
      result = Session.run("create a list", llm: llm, max_turns: 2)
      
      assert {:ok, _} = result
      
      # Give telemetry time to propagate
      Process.sleep(50)
      
      # Check store received events
      spans = Store.spans(store)
      assert map_size(spans) > 0
      
      # Should have run and tool spans
      run_spans = Store.run_spans(spans)
      assert length(run_spans) > 0
    end
  end

  describe "Complex Workflows" do
    test "agent performs multi-step analysis" do
      llm = build_mock_llm([
        # Step 1: Define analysis tools
        %{
          content: [%{
            type: "tool_use",
            id: "call_1",
            name: "ptc_lisp_repl",
            input: %{
              program: """
              (do
                (tool/define-tool {:name "analyze-data"
                                  :params [:data]
                                  :doc "Analyze data structure"
                                  :source "(hash-map :count (count data/data)
                                                     :type (type data/data)
                                                     :first (first data/data))"})
                (tool/define-tool {:name "summarize"
                                  :params [:analysis]
                                  :doc "Summarize analysis"
                                  :source "(str \\"Count: \\" (get data/analysis :count)
                                               \\", Type: \\" (get data/analysis :type))"})
                "Tools defined")
              """
            }
          }]
        },
        # Step 2: Analyze
        %{
          content: [%{
            type: "tool_use",
            id: "call_2",
            name: "ptc_lisp_repl",
            input: %{
              program: "(def analysis (tool/analyze-data {:data [1 2 3 4 5]}))"
            }
          }]
        },
        # Step 3: Summarize
        %{
          content: [%{
            type: "tool_use",
            id: "call_3",
            name: "ptc_lisp_repl",
            input: %{
              program: "(tool/summarize {:analysis analysis})"
            }
          }]
        },
        # Final response
        %{
          content: [%{
            type: "text",
            text: "Analysis complete: Count: 5, Type: PersistentVector"
          }]
        }
      ])
      
      result = Session.run("analyze the list [1,2,3,4,5]", llm: llm, max_turns: 4)
      
      assert {:ok, response} = result
      assert response =~ "Count: 5"
      assert response =~ "Type"
    end
  end

  # Helper to build a mock LLM callback
  defp build_mock_llm(responses) do
    ref = make_ref()
    Agent.start_link(fn -> {0, responses} end, name: {:global, ref})
    
    fn _request ->
      Agent.get_and_update({:global, ref}, fn {index, resps} ->
        if index < length(resps) do
          response = %{
            id: "msg-#{index}",
            content: Enum.at(resps, index).content,
            model: "mock-model",
            role: "assistant",
            usage: %{input_tokens: 10, output_tokens: 10}
          }
          {{:ok, response}, {index + 1, resps}}
        else
          # Final response to end conversation
          response = %{
            id: "msg-final",
            content: [%{type: "text", text: "Task complete"}],
            model: "mock-model",
            role: "assistant",
            usage: %{input_tokens: 10, output_tokens: 10}
          }
          {{:ok, response}, {index + 1, resps}}
        end
      end)
    end
  end
end