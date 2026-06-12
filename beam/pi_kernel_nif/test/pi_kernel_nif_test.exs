defmodule PiKernelNifTest do
  use ExUnit.Case, async: false

  # P3.3b GATE 1 (cross-runtime) + P3.4 GATE 2 (panic-safety).
  #
  # Gate-1 fidelity chain: the NIF calls the SAME `pi_kernel::resolve_target`
  # the NAPI skin's read branch calls. The Rust in-process parity test
  # (crates/pi-natives kernel_parity_tests) already proves resolve_target ==
  # execute_code_path_inner byte-for-byte. So here we prove the FFI boundary
  # faithfully carries that result into the BEAM: the NIF resolves the corpus to
  # the expected node shapes (non-empty, correct kinds/locators), and the JSON
  # round-trips. Transitively: NIF == resolve_target == NAPI.

  @fixture Path.join(System.tmp_dir!(), "pi_kernel_nif_fixture_#{:erlang.unique_integer([:positive])}")

  setup_all do
    File.mkdir_p!(Path.join(@fixture, "src"))

    File.write!(
      Path.join(@fixture, "foo.ts"),
      "export function bar(x) {\n  return x + 1;\n}\n\nclass Baz {\n  method() { return 2; }\n}\n"
    )

    File.write!(
      Path.join(@fixture, "src/lib.rs"),
      "pub fn hello() -> u32 {\n    42\n}\n\npub fn world() -> u32 {\n    7\n}\n"
    )

    on_exit(fn -> File.rm_rf!(@fixture) end)
    {:ok, root: @fixture}
  end

  describe "gate 1 — cross-runtime read resolution" do
    test "resolves a plain file path to a file node", %{root: root} do
      assert {:ok, %{"nodes" => nodes, "diagnostics" => diags}} =
               PiKernelNif.resolve("foo.ts", root)

      assert is_list(nodes)
      assert length(nodes) == 1
      assert [%{"locator" => loc}] = nodes
      assert String.ends_with?(loc, "foo.ts")
      assert diags == []
    end

    test "resolves a symbol query to the function node", %{root: root} do
      assert {:ok, %{"nodes" => nodes}} = PiKernelNif.resolve("foo.ts::bar", root)
      assert length(nodes) >= 1
      assert Enum.any?(nodes, fn n -> String.contains?(n["kind"], "function") end)
    end

    test "resolves a universal-function query in rust", %{root: root} do
      assert {:ok, %{"nodes" => nodes}} = PiKernelNif.resolve("src/lib.rs::§function", root)
      # hello + world
      assert length(nodes) == 2
    end

    test "resolves a glob to multiple file nodes", %{root: root} do
      assert {:ok, %{"nodes" => nodes}} = PiKernelNif.resolve("src/**/*.rs", root)
      assert length(nodes) >= 1
    end

    test "resolves a line slice", %{root: root} do
      assert {:ok, %{"nodes" => nodes}} = PiKernelNif.resolve("foo.ts:1-3", root)
      assert [%{"kind" => "§line"}] = nodes
    end

    test "semantic qualifiers are rejected (host-only)", %{root: root} do
      assert {:error, reason} = PiKernelNif.resolve_target("foo.ts::bar#hover", root)
      assert reason =~ "semantic"
    end
  end

  describe "gate 2 — panic-safety" do
    test "a panic in the NIF is caught and the BEAM node survives", %{root: root} do
      # The injected-panic sentinel forces a Rust panic inside the NIF boundary.
      assert {:error, reason} = PiKernelNif.resolve_target("foo.ts::__panic__", root)
      assert reason =~ "panic caught in NIF"

      # DECISIVE: the node is still alive after the caught panic — a normal call
      # in the SAME VM succeeds, and the liveness probe answers.
      assert :ok = PiKernelNif.ping()
      assert {:ok, %{"nodes" => [_ | _]}} = PiKernelNif.resolve("foo.ts", root)
    end
  end
end
