defmodule PtcRuntime.PeerHarness do
  @moduledoc """
  Test harness that plays the Node side of the JSON-RPC peer.

  Starts a `PtcRuntime.Peer` with a writer that forwards every outbound frame to
  the calling test process as `{:out, frame_map}`. The test feeds inbound frames
  with `send_frame/2` and asserts on captured output with `recv/1`.

  Because the writer forwards *decoded* maps, tests work with data, not strings.
  """

  alias PtcRuntime.Peer

  @doc "Start a Peer wired to forward outbound frames to `dest` (default: self)."
  def start(dest \\ self()) do
    writer = fn iodata ->
      iodata
      |> IO.iodata_to_binary()
      |> String.split("\n", trim: true)
      |> Enum.each(fn line ->
        send(dest, {:out, Jason.decode!(line)})
      end)

      :ok
    end

    {:ok, peer} = Peer.start_link(writer: writer, autostart: false, name: nil)
    peer
  end

  @doc "Feed an inbound frame (map) to the peer."
  def send_frame(peer, frame) when is_map(frame) do
    send(peer, {:frame, Jason.encode!(frame)})
    :ok
  end

  @doc "Feed a raw inbound line (for malformed-frame tests)."
  def send_line(peer, line) when is_binary(line) do
    send(peer, {:frame, line})
    :ok
  end

  @doc "Receive the next outbound frame, or fail after `timeout` ms."
  def recv(timeout \\ 1_000) do
    receive do
      {:out, frame} -> frame
    after
      timeout -> ExUnit.Assertions.flunk("no outbound frame within #{timeout}ms")
    end
  end

  @doc """
  Receive outbound frames until one matches `pred`, returning it. Other frames
  are returned in the order seen as the second element.
  """
  def recv_until(pred, timeout \\ 1_000, acc \\ []) do
    frame = recv(timeout)

    if pred.(frame) do
      {frame, Enum.reverse(acc)}
    else
      recv_until(pred, timeout, [frame | acc])
    end
  end
end
