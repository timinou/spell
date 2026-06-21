defmodule SpellAgent.LlmCassette do
  @moduledoc """
  Wire-level record/replay for the Anthropic `/v1/messages` adapter (FEAT-006).

  A cassette is a deterministic capture of the RAW `text/event-stream` responses
  the subscription endpoint returns for an agent run. Replaying it drives the
  real `SpellAgent.Anthropic` adapter (and its `parse_response/1` SSE folder)
  with zero network, so the loop-correctness + visual suites (PLAN-347 Design
  C/A) run offline and deterministically.

  ## How it hooks in

  `SpellAgent.Anthropic.call_with_token/3` reads extra Req options from
  `Application.get_env(:spell_agent, :anthropic_req_options)` (empty in
  production). This module sets that to `plug: {Req.Test, __MODULE__}` for the
  duration of a `with_cassette/3` block and registers a `Req.Test` stub that
  serves recorded SSE. Stubs are set to SHARED mode so the stub is visible from
  whatever process the SubAgent loop issues the request on.

  ## Modes (env `LLM_CASSETTE`, default `replay`)

    * `replay` (default) \u2014 serve only from the cassette; a request whose digest
      is missing RAISES (the test must be deterministic and offline).
    * `record_missing` \u2014 if the cassette file is absent, hit the REAL endpoint
      (requires a credential + `--include live`), capture, write, then replay;
      otherwise replay.
    * `record` \u2014 always hit the real endpoint and overwrite the cassette.

  Default `mix test` is `replay`, so it needs no network and no credential.

  ## Cassette format

  `test/fixtures/llm/<name>.cassette` is `:erlang.term_to_binary/1` of:

      %{
        version: 1,
        interactions: [
          %{request_digest: "<sha256hex>", status: 200,
            resp_headers: [{"content-type", "text/event-stream"}],
            sse_body: "<raw SSE bytes>"}
        ]
      }

  Interactions are matched by `request_digest` \u2014 a sha256 over the CANONICAL
  request (model + messages + tools + system), with the volatile billing-header
  fields excluded so the digest is stable run to run. Multiple interactions per
  cassette support a multi-turn run (each turn is a distinct request).

  ## Redaction

  Cassettes never carry secrets: only the response SSE + the request DIGEST are
  stored (not the raw request, not headers), so no `authorization: Bearer` token
  is ever written. `assert_no_secrets/1` is provided for a belt-and-braces test.
  """

  @cassette_dir Path.join([__DIR__, "..", "fixtures", "llm"])
  @app :spell_agent
  @req_opts_key :anthropic_req_options

  # ---- public API ----

  @doc "Absolute path of a named cassette file."
  @spec path(String.t()) :: String.t()
  def path(name), do: Path.join(@cassette_dir, name <> ".cassette")

  @doc "The active mode, from the `LLM_CASSETTE` env var (default `:replay`)."
  @spec mode() :: :replay | :record_missing | :record
  def mode do
    case System.get_env("LLM_CASSETTE") do
      "record_missing" -> :record_missing
      "record" -> :record
      _ -> :replay
    end
  end

  @doc """
  Run `fun` with the Anthropic adapter wired to the named cassette.

  In `:replay` mode (default) installs a `Req.Test` stub that serves the recorded
  SSE for each request by digest, sets the adapter's Req-options seam to point at
  it, runs `fun`, and tears the seam down afterwards (always, even on raise).

  `opts`:
    * `:match` \u2014 a 1-arity fn `(canonical_request -> digest_override)` to force a
      match (rare; default hashes the canonical request).
  """
  @spec with_cassette(String.t(), keyword(), (-> result)) :: result when result: term()
  def with_cassette(name, opts \\ [], fun) when is_function(fun, 0) do
    case mode() do
      :replay -> replay(name, opts, fun)
      :record_missing -> if File.exists?(path(name)), do: replay(name, opts, fun), else: record(name, opts, fun)
      :record -> record(name, opts, fun)
    end
  end

  @doc """
  An `llm:` callback bound to a cassette, for
  `Session.run(prompt, llm: LlmCassette.llm(name))`.

  NB: prefer `with_cassette/3` around the whole run so the seam is installed +
  cleaned up deterministically; this helper assumes the caller already opened a
  cassette scope (it just returns the live adapter callback).
  """
  @spec llm(String.t()) :: (map() -> {:ok, map()} | {:error, term()})
  def llm(model \\ "claude-sonnet-4-5-20250929"), do: SpellAgent.Anthropic.callback(model)

  @doc """
  The canonical request digest \u2014 sha256 hex over the stable parts of the request
  (model + messages + tools + system). Excludes the volatile billing header so it
  is reproducible. Public for tests that want to assert match behaviour.
  """
  @spec digest(map()) :: String.t()
  def digest(canonical) when is_map(canonical) do
    canonical
    |> canonical_terms()
    |> Jason.encode!()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  @doc "Assert a cassette file contains no obvious secret (bearer token)."
  @spec assert_no_secrets(String.t()) :: :ok
  def assert_no_secrets(name) do
    raw = name |> path() |> File.read!()

    if String.contains?(raw, "Bearer ") or String.contains?(raw, "sk-ant") do
      raise "cassette #{name} appears to contain a secret"
    end

    :ok
  end

  @doc """
  Capture a self-consistent cassette OFFLINE: serve `canned_sse` responses in
  order while recording the digest of each request the code under test actually
  produces, then write the cassette keyed by those digests.

  This is how a committable fixture stays consistent with the LIVE system prompt +
  tools map without a network round-trip: the digests are computed from the real
  requests the loop emits NOW. If the system prompt or tool surface changes so the
  digests shift, re-capture (the test that uses the cassette will tell you, since
  replay raises on an unknown digest).

  `canned_sse` is a list of raw SSE strings, one per expected request (turn). Runs
  `fun` with the capture stub installed; returns `{fun_result, cassette_path}`.
  """
  @spec capture(String.t(), [String.t()], (-> result)) :: {result, String.t()} when result: term()
  def capture(name, canned_sse, fun) when is_list(canned_sse) and is_function(fun, 0) do
    {:ok, agent} = Agent.start_link(fn -> {canned_sse, []} end)
    Req.Test.set_req_test_to_shared()

    Req.Test.stub(__MODULE__, fn conn ->
      digest = conn_request_digest(conn)

      sse =
        Agent.get_and_update(agent, fn
          {[next | rest], recorded} -> {next, {rest, [{digest, next} | recorded]}}
          {[], recorded} -> {"", {[], recorded}}
        end)

      conn
      |> Plug.Conn.put_resp_header("content-type", "text/event-stream")
      |> Plug.Conn.resp(200, sse)
    end)

    install_seam()

    try do
      result = fun.()
      recorded = agent |> Agent.get(fn {_rest, rec} -> Enum.reverse(rec) end)

      pairs =
        Enum.map(recorded, fn {digest, sse} ->
          # Store keyed directly by the captured digest (bypass canonicalization,
          # since the digest already IS the canonical hash of the real request).
          %{request_digest: digest, status: 200,
            resp_headers: [{"content-type", "text/event-stream"}], sse_body: sse}
        end)

      p = write_interactions(name, pairs)
      {result, p}
    after
      uninstall_seam()
      Agent.stop(agent)
    end
  end

  # ---- replay ----

  defp replay(name, _opts, fun) do
    interactions = load(name)
    Req.Test.set_req_test_to_shared()

    Req.Test.stub(__MODULE__, fn conn ->
      digest = conn_request_digest(conn)
      serve(conn, interactions, digest, name)
    end)

    install_seam()

    try do
      fun.()
    after
      uninstall_seam()
    end
  end

  # Serve the interaction whose digest matches; raise (loudly, offline contract)
  # if none does so a stale/missing cassette fails the test instead of hanging on
  # a real request.
  defp serve(conn, interactions, digest, name) do
    case Enum.find(interactions, &(&1.request_digest == digest)) do
      nil ->
        raise """
        LLM cassette #{inspect(name)} has no interaction for request digest
        #{digest}. Re-record with `LLM_CASSETTE=record_missing mix test --include live`,
        or check the request changed. Known digests: #{inspect(Enum.map(interactions, & &1.request_digest))}.
        """

      interaction ->
        conn = Enum.reduce(interaction.resp_headers, conn, fn {k, v}, c -> Plug.Conn.put_resp_header(c, k, v) end)
        Plug.Conn.resp(conn, interaction.status, interaction.sse_body)
    end
  end

  # ---- record ----

  defp record(name, _opts, fun) do
    # Recording installs a Req.Test stub that PROXIES to the real endpoint while
    # capturing the SSE, then writes the cassette. Requires a live credential.
    # Implemented in the FEAT-006 follow-up that wires the real proxy; for now,
    # recording is a documented manual step to keep the offline suite the default.
    raise """
    LLM cassette recording (#{name}) is not yet wired (FEAT-006 follow-up).
    Provide the cassette fixture at #{path(name)} or run in :replay mode.
    """

    fun
  end

  # ---- cassette IO ----

  @doc false
  def load(name) do
    case File.read(path(name)) do
      {:ok, bin} ->
        %{interactions: interactions} = :erlang.binary_to_term(bin)
        interactions

      {:error, _} ->
        raise "LLM cassette not found: #{path(name)} (mode=#{mode()})"
    end
  end

  @doc """
  Write a cassette from a list of `{canonical_request, {status, resp_headers,
  sse_body}}` pairs. Used by the recorder + by tests that synthesize a fixture.
  """
  @spec write(String.t(), [{map(), {non_neg_integer(), [{String.t(), String.t()}], String.t()}}]) :: String.t()
  def write(name, pairs) do
    File.mkdir_p!(@cassette_dir)

    interactions =
      Enum.map(pairs, fn {canonical, {status, headers, sse}} ->
        %{request_digest: digest(canonical), status: status, resp_headers: headers, sse_body: sse}
      end)

    write_interactions(name, interactions)
  end

  @doc false
  @spec write_interactions(String.t(), [map()]) :: String.t()
  def write_interactions(name, interactions) do
    File.mkdir_p!(@cassette_dir)
    payload = %{version: 1, interactions: interactions}
    p = path(name)
    File.write!(p, :erlang.term_to_binary(payload))
    p
  end

  # ---- seam control ----

  defp install_seam do
    Application.put_env(@app, @req_opts_key, plug: {Req.Test, __MODULE__})
  end

  defp uninstall_seam do
    Application.delete_env(@app, @req_opts_key)
  end

  # ---- digest canonicalization ----

  # Read the request body off the Plug.Conn and reduce it to the canonical terms.
  defp conn_request_digest(conn) do
    {:ok, body, _conn} = Plug.Conn.read_body(conn)
    decoded = Jason.decode!(body)
    digest(decoded)
  end

  # The stable subset of a request that identifies it across runs. The Anthropic
  # body carries a volatile billing-header system block (cch + rand) we must drop
  # so the digest is reproducible; we key on model + messages + tools + the
  # NON-billing system blocks.
  defp canonical_terms(req) do
    %{
      "model" => req["model"] || req[:model],
      "messages" => req["messages"] || req[:messages] || [],
      "tools" => req["tools"] || req[:tools] || [],
      "system" => req |> system_blocks() |> drop_billing()
    }
  end

  defp system_blocks(req) do
    case req["system"] || req[:system] do
      blocks when is_list(blocks) -> blocks
      text when is_binary(text) -> [%{"type" => "text", "text" => text}]
      _ -> []
    end
  end

  # Drop the two Claude-Code system blocks the adapter prepends (the billing
  # header with the volatile cch/rand, and the fixed identity line) so the digest
  # depends only on the CALLER's system prompt + messages.
  defp drop_billing(blocks) do
    Enum.reject(blocks, fn b ->
      text = b["text"] || ""
      String.starts_with?(text, "x-anthropic-billing-header:") or
        text == "You are a Claude agent, built on Anthropic's Claude Agent SDK."
    end)
  end
end