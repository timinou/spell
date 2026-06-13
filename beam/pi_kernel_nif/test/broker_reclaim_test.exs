defmodule BrokerReclaimTest do
  use ExUnit.Case, async: false

  # GATE 3 (P3.8) — the BEAM TRIGGER of owner reclaim, end to end.
  #
  # P3.5 proved the broker reclaims a dropped connection's intents
  # (crates/pi-edit-broker/tests/owner_reclaim.rs). This proves the BEAM side:
  # an owner's broker connection is held inside a NIF ResourceArc and monitored;
  # when the owning BEAM process DIES, the NIF's Resource::down fires, closes the
  # connection, and the broker reclaims the intent — so a second owner acquires
  # the same file. No deadlock.
  #
  # Runs against a throwaway broker socket so it never touches a real one.

  @socket Path.join(
            System.tmp_dir!(),
            "pi_kernel_nif_broker_#{:erlang.unique_integer([:positive])}.sock"
          )

  # The broker binary built by `cargo build -p pi-edit-broker`. Resolved at
  # runtime from the mix project cwd (stable during `mix test`): the spell repo
  # root is two levels up from beam/pi_kernel_nif.
  defp broker_bin do
    Path.expand(Path.join(File.cwd!(), "../../target/debug/pi-edit-broker"))
  end

  setup do
    bin = broker_bin()

    unless File.exists?(bin) do
      flunk("broker binary missing: #{bin} — run `cargo build -p pi-edit-broker`")
    end

    on_exit(fn -> File.rm_rf(@socket) end)

    {:ok, socket: @socket, bin: bin}
  end

  test "a dead owner's held intent is reclaimed so a new owner can acquire", %{
    socket: socket,
    bin: bin
  } do
    file = "/tmp/gate3_beam.ts"
    code_path = "::Widget.render#body"

    parent = self()

    # Owner A: a separate process that claims the intent and is monitored by the
    # NIF. It hands the parent BOTH its result AND the resource term, then blocks
    # until killed.
    #
    # CRITICAL (gate-3 credibility): the parent RETAINS the resource term, so when
    # A is killed the ResourceArc refcount does NOT hit 0 — the natural struct
    # Drop (Mutex<Option<UnixStream>> closing the socket) CANNOT fire. The only
    # thing that can close A's held connection is the NIF's Resource::down monitor
    # callback (keyed on A's pid). So a successful reclaim here PROVES the :DOWN
    # monitor drove it, not GC-drop.
    a =
      spawn(fn ->
        result = PiKernelNif.claim_intent(socket, bin, "ownerA-beam", file, code_path)
        send(parent, {:a_claimed, result})
        receive do
          :never -> :ok
        end
      end)

    assert_receive {:a_claimed, {:ok, {res_a, true}}}, 5_000
    # Pin the resource in THIS (surviving) process so GC cannot reclaim it on A's
    # death — see the CRITICAL note above. Kept referenced to the end of the test.
    _pinned = res_a

    # Owner B: while A holds, B must be REJECTED (the lock is real).
    assert {:ok, {res_b1, granted_b1}} =
             PiKernelNif.claim_intent(socket, bin, "ownerB-beam", file, code_path)

    refute granted_b1, "owner B must be rejected while A holds the intent"
    PiKernelNif.release_intent(res_b1)

    # ── Owner A DIES: kill A. The parent still holds the resource term (_pinned),
    # so GC cannot drop it — ONLY the NIF's Resource::down monitor (on A's pid)
    # can close A's held connection → the broker reclaims A's intents.
    ref = Process.monitor(a)
    Process.exit(a, :kill)
    assert_receive {:DOWN, ^ref, :process, ^a, :killed}, 5_000

    # Give the broker a beat to process the disconnect + deregister.
    Process.sleep(300)

    # Owner B retries — A's intent must be RECLAIMED, so B is now granted.
    assert {:ok, {res_b2, granted_b2}} =
             PiKernelNif.claim_intent(socket, bin, "ownerB-beam", file, code_path)

    assert granted_b2,
           "after owner A died, owner B must acquire the reclaimed intent (no deadlock)"

    PiKernelNif.release_intent(res_b2)
    # Keep A's resource referenced to here so the pinning above is real (the
    # compiler/GC can't drop _pinned earlier).
    assert is_reference(res_a)
  end
end
