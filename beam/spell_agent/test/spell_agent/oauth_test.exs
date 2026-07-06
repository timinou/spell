defmodule SpellAgent.OAuthTest do
  use ExUnit.Case, async: false

  alias SpellAgent.Credentials
  alias SpellAgent.OAuth

  # BUG-025: expired/near-expiry credential must surface as a first-class
  # {:error, :token_expired} at ensure_fresh/0, not a silently-returned stale
  # token. Each test starts its own named GenServer to avoid cross-test state
  # (the app-started `SpellAgent.OAuth` singleton is untouched).

  defp start_oauth!(name) do
    {:ok, pid} = GenServer.start_link(OAuth, %{provider: "anthropic", cred: nil}, name: name)
    pid
  end

  test "expired credential -> {:error, :token_expired}" do
    pid = start_oauth!(:"oauth_test_expired_#{System.unique_integer([:positive])}")

    stale = %Credentials{
      provider: "anthropic",
      access: "sk-ant-oat01-stale",
      refresh: "r",
      expires_ms: System.os_time(:millisecond) - 1_000
    }

    assert {:reply, {:error, :token_expired}, _state} =
             OAuth.handle_call(:ensure_fresh, self(), %{provider: "anthropic", cred: stale})

    GenServer.stop(pid)
  end

  test "valid (non-expired) credential -> {:ok, cred} unchanged (happy path regression)" do
    fresh = %Credentials{
      provider: "anthropic",
      access: "sk-ant-oat01-fresh",
      refresh: "r",
      expires_ms: System.os_time(:millisecond) + 3_600_000
    }

    assert {:reply, {:ok, ^fresh}, _state} =
             OAuth.handle_call(:ensure_fresh, self(), %{provider: "anthropic", cred: fresh})
  end
end
