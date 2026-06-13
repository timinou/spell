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

  describe "P5.A — graph edges from the warm kernel index" do
    # A cross-file reference: `helper` defined in lib.ts, imported + called in
    # main.ts. def→ must traverse the STATIC pi-code-graph index (not an LSP) and
    # return the referencing file. Proves the BEAM serves edges from the SAME
    # warm resident index resolve_target reads from (WS-B).
    setup %{root: root} do
      File.write!(Path.join(root, "lib.ts"), "export function helper() { return 42; }\n")

      File.write!(
        Path.join(root, "main.ts"),
        "import { helper } from './lib';\nexport const x = helper();\n"
      )

      :ok
    end

    test "def→ resolves a cross-file reference through the NIF", %{root: root} do
      assert {:ok, %{"nodes" => nodes}} =
               PiKernelNif.resolve_edges_decoded("lib.ts::helper def→", root)

      assert is_list(nodes)
      assert nodes != [], "def→ must resolve the cross-file reference, got 0 nodes"
      # The reference lives in main.ts (where helper is imported/called).
      assert Enum.any?(nodes, fn n -> String.contains?(n["locator"], "main.ts") end),
             "resolved reference must point at main.ts, got #{inspect(Enum.map(nodes, & &1["locator"]))}"
    end

    test "a non-edge target is rejected (use resolve_target instead)", %{root: root} do
      assert {:error, reason} = PiKernelNif.resolve_edges("foo.ts::bar", root)
      assert reason =~ "edge" or reason =~ "UnsupportedOperation"
    end
  end

  describe "P5.B — apply edits through the warm BEAM registry" do
    test "a body-scoped write commits to a real file via the NIF", %{root: root} do
      file = Path.join(root, "edit_me.ts")
      File.write!(file, "export function foo() { return 1; }\n")
      target = "#{file}::foo"
      action = ~s({"kind":"write","scope":"body","content":"{ return 2; }"})

      assert {:ok, %{"edit_count" => n}} =
               PiKernelNif.apply_edit_decoded("beam-test-session", target, action)

      assert n >= 1
      # The write committed to disk through the registry transaction.
      after_text = File.read!(file)
      assert after_text =~ "return 2", "file must reflect the BEAM-applied edit: #{after_text}"
      refute after_text =~ "return 1"
    end

    test "an unknown action kind returns a clean error (no node crash)", %{root: root} do
      file = Path.join(root, "edit_bad.ts")
      File.write!(file, "export const x = 1;\n")
      assert {:error, reason} =
               PiKernelNif.apply_edit("", "#{file}::x", ~s({"kind":"no-such"}))
      assert is_binary(reason)
      # Node survives.
      assert :ok = PiKernelNif.ping()
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
