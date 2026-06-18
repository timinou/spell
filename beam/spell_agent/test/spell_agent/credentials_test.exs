defmodule SpellAgent.CredentialsTest do
  use ExUnit.Case, async: true

  alias SpellAgent.Credentials

  # Build a throwaway agent.db-shaped SQLite fixture with the verified schema,
  # seed `rows` (list of {provider, credential_type, data_json, updated_at,
  # disabled_cause}), and return its path. The DB is created with a normal
  # (writable) handle here; `Credentials.load/2` re-opens it read-only.
  defp fixture_db(rows) do
    path = Path.join(System.tmp_dir!(), "spell_agent_creds_#{System.unique_integer([:positive])}.db")
    on_exit(fn -> File.rm(path) end)

    {:ok, conn} = Exqlite.Sqlite3.open(path)

    :ok =
      Exqlite.Sqlite3.execute(conn, """
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT DEFAULT NULL,
        identity_key TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
      """)

    for {provider, type, data, updated_at, disabled} <- rows do
      {:ok, stmt} =
        Exqlite.Sqlite3.prepare(
          conn,
          "INSERT INTO auth_credentials (provider, credential_type, data, updated_at, disabled_cause) VALUES (?1,?2,?3,?4,?5)"
        )

      :ok = Exqlite.Sqlite3.bind(stmt, [provider, type, data, updated_at, disabled])
      :done = Exqlite.Sqlite3.step(conn, stmt)
      :ok = Exqlite.Sqlite3.release(conn, stmt)
    end

    :ok = Exqlite.Sqlite3.close(conn)
    path
  end

  defp cred_json(access, refresh, expires_ms) do
    Jason.encode!(%{"access" => access, "refresh" => refresh, "expires" => expires_ms})
  end

  test "loads the freshest non-disabled anthropic oauth credential" do
    future = System.os_time(:millisecond) + 3_600_000

    path =
      fixture_db([
        {"anthropic", "oauth", cred_json("sk-ant-oat01-OLD", "r-old", future), 100, nil},
        {"anthropic", "oauth", cred_json("sk-ant-oat01-NEW", "r-new", future), 200, nil},
        {"zai", "api_key", cred_json("zai-key", nil, future), 300, nil}
      ])

    assert {:ok, cred} = Credentials.load("anthropic", db_path: path)
    assert cred.provider == "anthropic"
    # Freshest by updated_at wins.
    assert cred.access == "sk-ant-oat01-NEW"
    assert cred.refresh == "r-new"
    assert cred.expires_ms == future
  end

  test "skips disabled credentials" do
    future = System.os_time(:millisecond) + 3_600_000

    path =
      fixture_db([
        {"anthropic", "oauth", cred_json("sk-ant-oat01-DISABLED", "r", future), 200, "revoked"},
        {"anthropic", "oauth", cred_json("sk-ant-oat01-OK", "r", future), 100, nil}
      ])

    assert {:ok, cred} = Credentials.load("anthropic", db_path: path)
    assert cred.access == "sk-ant-oat01-OK"
  end

  test "no matching row -> {:error, :no_credential}" do
    path = fixture_db([{"openai-codex", "oauth", cred_json("x", "y", 1), 1, nil}])
    assert {:error, :no_credential} = Credentials.load("anthropic", db_path: path)
  end

  test "missing db file -> {:error, :db_missing}" do
    assert {:error, :db_missing} =
             Credentials.load("anthropic", db_path: "/nonexistent/spell_agent/agent.db")
  end

  test "expired?/2 honours the skew window and millis epoch" do
    now = System.os_time(:millisecond)

    fresh = %Credentials{provider: "anthropic", access: "a", refresh: "r", expires_ms: now + 3_600_000}
    stale = %Credentials{provider: "anthropic", access: "a", refresh: "r", expires_ms: now - 1000}
    # Inside the 5-min skew window => treated as expired (refresh soon).
    near = %Credentials{provider: "anthropic", access: "a", refresh: "r", expires_ms: now + 60_000}

    refute Credentials.expired?(fresh)
    assert Credentials.expired?(stale)
    assert Credentials.expired?(near)
  end

  test "expires given in seconds is normalized to millis" do
    # A value below the year-2001-in-millis threshold is read as seconds.
    secs = div(System.os_time(:millisecond), 1000) + 3600
    path = fixture_db([{"anthropic", "oauth", cred_json("sk-ant", "r", secs), 1, nil}])

    assert {:ok, cred} = Credentials.load("anthropic", db_path: path)
    assert cred.expires_ms == secs * 1000
    refute Credentials.expired?(cred)
  end
end
