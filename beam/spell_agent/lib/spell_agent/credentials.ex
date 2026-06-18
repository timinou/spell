defmodule SpellAgent.Credentials do
  @moduledoc """
  Reads Spell's existing `~/.spell/agent/agent.db` (SQLite) READ-ONLY and
  returns a subscription OAuth credential (FEAT-824, PLAN-344).

  Zero-migration: the schema is Spell's own and is left untouched. The DB is
  opened in `:readonly` mode so the parallel TypeScript Spell is never write-
  locked or otherwise disturbed.

  ## Schema (verified)

      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT,            -- e.g. "anthropic"
        credential_type TEXT,     -- e.g. "oauth"
        data TEXT,                -- JSON: {"access","refresh","expires"}
        disabled_cause TEXT,
        identity_key TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )

  For an Anthropic subscription the `data` JSON is
  `{"access":"sk-ant-oat01…","refresh":"…","expires":<unix MILLIS int>}`.

  > NB: `expires` is unix MILLISECONDS, not seconds (verified against a live db,
  > e.g. `1777907810140`). Compare with `System.os_time(:millisecond)`.
  """



  @enforce_keys [:provider, :access, :refresh, :expires_ms]
  defstruct [:provider, :access, :refresh, :expires_ms]

  @type t :: %__MODULE__{
          provider: String.t(),
          access: String.t(),
          refresh: String.t() | nil,
          expires_ms: non_neg_integer()
        }

  @default_skew_ms 300_000

  @doc """
  Load the freshest non-disabled OAuth credential for `provider`.

  Returns `{:ok, %SpellAgent.Credentials{}}` or `{:error, reason}` where reason
  is `:no_credential`, `:db_missing`, or a `{:db_error | :decode_error, detail}`.
  """
  @spec load(String.t(), keyword()) :: {:ok, t} | {:error, term()}
  def load(provider \\ "anthropic", opts \\ []) do
    path = Keyword.get(opts, :db_path, db_path())

    if File.exists?(path) do
      with {:ok, conn} <- open_readonly(path) do
        try do
          fetch_credential(conn, provider)
        after
          Exqlite.Sqlite3.close(conn)
        end
      end
    else
      {:error, :db_missing}
    end
  end

  @doc """
  True when the credential is expired or within `skew_ms` of expiry (default 5
  minutes) — i.e. a refresh should happen before the next request.
  """
  @spec expired?(t, non_neg_integer()) :: boolean()
  def expired?(%__MODULE__{expires_ms: expires_ms}, skew_ms \\ @default_skew_ms) do
    System.os_time(:millisecond) > expires_ms - skew_ms
  end

  @doc "Resolved path to Spell's agent.db; overridable via `SPELL_AGENT_DB`."
  @spec db_path() :: String.t()
  def db_path do
    case System.get_env("SPELL_AGENT_DB") do
      nil -> Path.expand("~/.spell/agent/agent.db")
      override -> override
    end
  end

  # --- internals ------------------------------------------------------------

  defp open_readonly(path) do
    case Exqlite.Sqlite3.open(path, mode: :readonly) do
      {:ok, conn} -> {:ok, conn}
      {:error, reason} -> {:error, {:db_error, reason}}
    end
  end

  defp fetch_credential(conn, provider) do
    sql = """
    SELECT data FROM auth_credentials
    WHERE provider = ?1 AND credential_type = 'oauth' AND disabled_cause IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
    """

    with {:ok, stmt} <- Exqlite.Sqlite3.prepare(conn, sql),
         :ok <- Exqlite.Sqlite3.bind(stmt, [provider]) do
      try do
        case Exqlite.Sqlite3.step(conn, stmt) do
          {:row, [data]} when is_binary(data) -> decode(data, provider)
          :done -> {:error, :no_credential}
          {:error, reason} -> {:error, {:db_error, reason}}
        end
      after
        Exqlite.Sqlite3.release(conn, stmt)
      end
    else
      {:error, reason} -> {:error, {:db_error, reason}}
    end
  end

  defp decode(json, provider) do
    case Jason.decode(json) do
      {:ok, %{"access" => access} = map} when is_binary(access) ->
        {:ok,
         %__MODULE__{
           provider: provider,
           access: access,
           refresh: Map.get(map, "refresh"),
           expires_ms: normalize_expires(Map.get(map, "expires"))
         }}

      {:ok, _other} ->
        {:error, {:decode_error, :missing_access_token}}

      {:error, reason} ->
        {:error, {:decode_error, reason}}
    end
  end

  # `expires` is unix millis. Tolerate nil (treat as already-expired => 0) and
  # an accidental seconds value (heuristic: < year-2001 in millis => seconds).
  defp normalize_expires(nil), do: 0
  defp normalize_expires(ms) when is_integer(ms) and ms > 1_000_000_000_000, do: ms
  defp normalize_expires(secs) when is_integer(secs), do: secs * 1000
  defp normalize_expires(_), do: 0
end
