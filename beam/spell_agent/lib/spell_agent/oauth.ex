defmodule SpellAgent.OAuth do
  @moduledoc """
  Holds the active subscription credential and refreshes it before expiry
  (FEAT-825, PLAN-344).

  Seeded lazily from `SpellAgent.Credentials.load/2` (FEAT-824). When the held
  credential is within the refresh skew of expiry, `ensure_fresh/0` performs the
  OAuth refresh-token grant and keeps the new token IN MEMORY (v0 does not write
  back to agent.db, to avoid clobbering the parallel TS Spell).

  > NB: this is a STUB carrying the public shape + lazy-load only. The refresh
  > HTTP grant lands in FEAT-825.
  """

  use GenServer

  require Logger

  alias SpellAgent.Credentials

  @type state :: %{provider: String.t(), cred: Credentials.t() | nil}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    provider = Keyword.get(opts, :provider, "anthropic")
    GenServer.start_link(__MODULE__, %{provider: provider, cred: nil}, name: __MODULE__)
  end

  @doc """
  Return a non-expired credential, loading from agent.db on first use and
  refreshing if near expiry. `{:ok, cred}` or `{:error, reason}`.

  v0: refresh is not yet implemented (FEAT-825); a near-expiry token is returned
  as-is with a warning so the loop still functions while the grant is built.
  """
  @spec ensure_fresh() :: {:ok, Credentials.t()} | {:error, term()}
  def ensure_fresh do
    GenServer.call(__MODULE__, :ensure_fresh)
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:ensure_fresh, _from, %{cred: nil, provider: provider} = state) do
    case Credentials.load(provider) do
      {:ok, cred} -> maybe_refresh(cred, %{state | cred: cred})
      {:error, _} = err -> {:reply, err, state}
    end
  end

  def handle_call(:ensure_fresh, _from, %{cred: cred} = state) do
    maybe_refresh(cred, state)
  end

  # FEAT-825 will replace this with a real refresh-token grant. For now, an
  # expired/near-expiry credential is a first-class error at the call boundary
  # (BUG-025) rather than a silently-returned stale token that only surfaces as
  # an opaque downstream 401.
  defp maybe_refresh(cred, state) do
    if Credentials.expired?(cred) do
      Logger.warning(
        "[spell_agent] anthropic subscription token expired; refresh-token grant not yet implemented (FEAT-825)"
      )

      {:reply, {:error, :token_expired}, state}
    else
      {:reply, {:ok, cred}, state}
    end
  end
end
