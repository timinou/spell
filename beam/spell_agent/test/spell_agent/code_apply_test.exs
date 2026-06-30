defmodule SpellAgent.CodeApplyTest do
  @moduledoc """
  FEAT-025 — `code-apply`: the one-call edit sugar over the q/* data algebra.

  `code-apply {:path :ops}` collapses the read -> parse -> q/apply-ops -> gate ->
  write pipeline the agent otherwise threads by hand for `code-edit`. It is the
  NATIVE seam (effectful orchestration in Elixir); the `:ops` it consumes are
  plain data built by the PURE q/* sugar (q/rename-id, q/rewrite-op, q/wrap-op),
  so the recorded edit stays reifiable (PLAN-018) exactly as with `code-edit`.

  This suite defends the contract a caller depends on:
    * lang is inferred from the path extension (no :lang arg needed);
    * a sugar-built op-list rewrites the file end-to-end;
    * the SAME gates as code-edit hold (parse-gate rejects + leaves the file
      untouched; empty result refused; atomic write preserves mode);
    * an unknown op kind / empty ops / missing args fail LOUD as error maps,
      never a silent or partial write.
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Code

  setup do
    dir = Path.join(System.tmp_dir!(), "code_apply_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  # The q/* sugar op for renaming an identifier — built as plain DATA here so the
  # test exercises the exact value the prelude sugar (q/rename-id) produces, with
  # no PTC run needed in the test itself.
  defp rename_id_op(from, to) do
    %{
      "op" => "update",
      "pattern" => %{"node" => "identifier", "value" => from},
      "template" => %{"node" => "identifier", "value" => to}
    }
  end

  describe "code-apply — one-call edit via op-list" do
    test "infers lang from path and applies a sugar op-list", %{dir: dir} do
      path = Path.join(dir, "a.ex")
      File.write!(path, "x + 1")

      # No :lang passed — it is inferred from `.ex`.
      result = Code.apply_tool(%{"path" => path, "ops" => [rename_id_op("x", "y")]})

      assert %{"path" => ^path, "src" => src} = result
      refute Map.has_key?(result, "error")
      assert src =~ "y"
      refute src =~ "x"
      # the file on disk reflects the edit
      assert File.read!(path) == src
    end

    test "applies a multi-op list left-to-right", %{dir: dir} do
      path = Path.join(dir, "b.ex")
      File.write!(path, "a + b")

      result =
        Code.apply_tool(%{
          "path" => path,
          "ops" => [rename_id_op("a", "c"), rename_id_op("b", "d")]
        })

      assert %{"src" => src} = result
      assert src =~ "c"
      assert src =~ "d"
      refute src =~ "a"
      refute src =~ "b"
    end

    test "an explicit :lang overrides path inference", %{dir: dir} do
      # A file whose extension would not resolve, but :lang names the grammar.
      path = Path.join(dir, "script.weirdext")
      File.write!(path, "x + 1")

      result =
        Code.apply_tool(%{"path" => path, "lang" => "elixir", "ops" => [rename_id_op("x", "y")]})

      assert %{"src" => src} = result
      assert src =~ "y"
    end

    test "preserves the file mode through the atomic write", %{dir: dir} do
      path = Path.join(dir, "script.exs")
      File.write!(path, "x + 1")
      File.chmod!(path, 0o755)

      assert %{"src" => _} =
               Code.apply_tool(%{"path" => path, "ops" => [rename_id_op("x", "y")]})

      assert {:ok, %File.Stat{mode: mode}} = File.stat(path)
      assert Bitwise.band(mode, 0o777) == 0o755
    end
  end

  describe "code-apply — gates + loud failures (no silent/partial write)" do
    test "an unknown op kind fails LOUD and leaves the file untouched", %{dir: dir} do
      path = Path.join(dir, "c.ex")
      original = "x + 1"
      File.write!(path, original)

      bad_op = %{"op" => "frobnicate", "pattern" => %{"node" => "identifier"}, "template" => %{}}
      result = Code.apply_tool(%{"path" => path, "ops" => [bad_op]})

      assert %{"error" => msg} = result
      assert msg =~ "unknown op kind" or msg =~ "code-apply"
      # CRITICAL: the file is untouched
      assert File.read!(path) == original
    end

    test "an empty :ops list is refused", %{dir: dir} do
      path = Path.join(dir, "d.ex")
      original = "x + 1"
      File.write!(path, original)

      assert %{"error" => msg} = Code.apply_tool(%{"path" => path, "ops" => []})
      assert msg =~ "empty"
      assert File.read!(path) == original
    end

    test "missing :path / :ops is an error map", %{dir: dir} do
      assert %{"error" => m1} = Code.apply_tool(%{"ops" => [rename_id_op("x", "y")]})
      assert m1 =~ "path"

      assert %{"error" => m2} = Code.apply_tool(%{"path" => Path.join(dir, "x.ex")})
      assert m2 =~ "ops"
    end

    test "an unresolvable extension (no :lang) is a clean error, not a crash", %{dir: dir} do
      path = Path.join(dir, "mystery.zzz")
      File.write!(path, "x + 1")

      assert %{"error" => msg} =
               Code.apply_tool(%{"path" => path, "ops" => [rename_id_op("x", "y")]})

      assert msg =~ "language" or msg =~ "no known language"
    end

    test "a non-existent file is a clean read error", %{dir: dir} do
      path = Path.join(dir, "does_not_exist.ex")

      assert %{"error" => msg} =
               Code.apply_tool(%{"path" => path, "ops" => [rename_id_op("x", "y")]})

      assert msg =~ "read" or msg =~ "no such file" or msg =~ "enoent"
    end
  end
end
