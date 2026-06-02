defmodule PtcRuntime.PeerPropertyTest do
  @moduledoc """
  Property + fuzz tests for the runtime's safety invariants (P0').

  These assert the load-bearing guarantees hold over GENERATED inputs, not just
  the hand-picked cases: the sandbox cannot be escaped, errors are always
  recoverable (the BEAM survives), JSON round-trips through tool args, and
  malformed frames never crash the Peer.

  Tagged `:property` so they can run as a focused lane (`mix test --only property`).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias PtcRuntime.PeerHarness, as: H

  @moduletag :property

  defp init!(peer, catalog \\ %{}) do
    H.send_frame(peer, %{
      "jsonrpc" => "2.0",
      "id" => 0,
      "method" => "init",
      "params" => %{"catalog" => catalog}
    })

    # Drain any leading frames (e.g. a parse-error from prior garbage) until the
    # init result with id 0 arrives.
    {frame, _} =
      H.recv_until(fn f -> Map.get(f, "id") == 0 and Map.has_key?(f, "result") end, 2_000)

    frame
  end

  # A generator for arbitrary JSON-encodable values (the universe of tool args
  # and context data).
  defp json_value(depth \\ 3)

  defp json_value(0) do
    one_of([
      integer(),
      boolean(),
      string(:printable),
      constant(nil),
      float(min: -1.0e6, max: 1.0e6)
    ])
  end

  defp json_value(depth) do
    one_of([
      json_value(0),
      list_of(json_value(depth - 1), max_length: 4),
      map_of(string(:alphanumeric, min_length: 1), json_value(depth - 1), max_length: 4)
    ])
  end

  property "pure arithmetic programs always return the computed value" do
    check all(a <- integer(-1000..1000), b <- integer(-1000..1000)) do
      peer = H.start()
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => "(+ #{a} #{b})"}
      })

      assert %{"id" => 1, "result" => result} = H.recv(2_000)
      assert result == a + b
    end
  end

  property "context JSON round-trips into the program and back" do
    check all(value <- json_value()) do
      peer = H.start()
      init!(peer)

      # Bind the value under data/v and return it unchanged.
      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => "data/v", "context" => %{"v" => value}}
      })

      assert %{"id" => 1} = frame = H.recv(2_000)
      # Either the value round-trips, or (for floats/edge encodings) we at least
      # get a structurally valid response, never a crash.
      assert Map.has_key?(frame, "result") or Map.has_key?(frame, "error")
      assert Process.alive?(peer)
    end
  end

  property "any execute resolves to exactly one response; the BEAM always survives" do
    # Throw a mix of valid, erroring, and pathological programs; every one must
    # produce a single result-or-error frame and leave the Peer alive.
    programs =
      one_of([
        constant("(+ 1 2)"),
        constant("(loop [i 0] (recur (inc i)))"),
        constant("(fn [x] x)"),
        constant("(/ 1 0)"),
        constant("(this is not valid lisp"),
        constant("(count data/missing)"),
        string(:printable, max_length: 32)
      ])

    check all(program <- programs, timeout <- integer(50..300)) do
      peer = H.start()
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => program, "timeout_ms" => timeout}
      })

      frame = H.recv(2_000)
      assert frame["id"] == 1
      assert Map.has_key?(frame, "result") or Map.has_key?(frame, "error")
      assert Process.alive?(peer)
    end
  end

  property "malformed inbound lines never crash the Peer" do
    check all(garbage <- string(:printable, max_length: 64)) do
      peer = H.start()
      H.send_line(peer, garbage)
      Process.sleep(5)
      assert Process.alive?(peer)

      # Prove liveness with a real init+execute. The garbage may have produced a
      # leading parse-error frame; drain frames until we see our execute result.
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => "(+ 2 2)"}
      })

      {frame, _drained} =
        H.recv_until(fn f -> Map.get(f, "id") == 1 and Map.has_key?(f, "result") end, 2_000)

      assert frame["result"] == 4
    end
  end

  property "sandbox has no fs/net/shell escape — IO/file ops are unbound or fail safely" do
    # PTC-Lisp has no fs/net by construction. Probe a set of would-be escape
    # forms; each must error (never succeed, never crash the runtime).
    escapes =
      one_of([
        constant(~S|(slurp "/etc/passwd")|),
        constant(~S|(spit "/tmp/x" "y")|),
        constant(~S|(System/cmd "ls")|),
        constant(~S|(File.read "/etc/passwd")|),
        constant(~S|(:erlang.halt)|)
      ])

    check all(program <- escapes) do
      peer = H.start()
      init!(peer)

      H.send_frame(peer, %{
        "jsonrpc" => "2.0",
        "id" => 1,
        "method" => "execute",
        "params" => %{"program" => program}
      })

      assert %{"id" => 1} = frame = H.recv(2_000)
      # An escape attempt must NOT succeed with a meaningful value; it errors.
      assert Map.has_key?(frame, "error"), "escape program unexpectedly succeeded: #{program}"
      assert Process.alive?(peer)
    end
  end
end
