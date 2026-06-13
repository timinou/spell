defmodule PiKernelNif do
  @moduledoc """
  Rustler NIF skin over `pi_kernel::resolve_target` (PLAN-334 / P3.3b).

  The BEAM-side analogue of the pi-natives NAPI skin: `resolve_target/2` calls
  the SAME host-agnostic kernel entry the NAPI read branch calls, so a read
  result is byte-identical across runtimes (gate 1). The kernel resolves fully
  in Rust and hands back a JSON string, which `resolve/2` decodes.

  Panic-safety (gate 2): the NIF wraps the kernel call in `catch_unwind`, so a
  panic surfaces as `{:error, reason}` and the BEAM node survives — it never
  aborts the VM the way an unguarded NIF panic would.
  """

  use Rustler, otp_app: :pi_kernel_nif, crate: "pi_kernel_nif"

  @doc """
  Resolve a read `target` rooted at `root`. Returns the raw JSON string
  `{"nodes": [...], "diagnostics": [...]}` on success or `{:error, reason}`.

  Replaced at load time by the NIF; this body only runs if the NIF failed to load.
  """
  @spec resolve_target(String.t(), String.t()) :: {:ok, String.t()} | {:error, String.t()}
  def resolve_target(_target, _root), do: :erlang.nif_error(:nif_not_loaded)

  # NB: rustler encodes Rust `Result<String, String>` as `{:ok, s} | {:error, s}`.

  @doc "Liveness probe; returns `:ok`. Used to confirm the node survives a caught panic."
  @spec ping() :: :ok
  def ping, do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Gate 3 (P3.8): open + HOLD a broker connection for `owner` at `socket` (spawning
  the broker from `broker_bin` if absent; pass "" to use the broker's own
  resolution), claim an edit-intent on `file`/`code_path`, and monitor the CALLING
  process. Returns `{:ok, {resource, granted}}` (rustler wraps the Rust
  `Ok((resource, granted))`). The connection is held inside the resource; when the
  caller process dies, the NIF's :DOWN monitor closes it and the broker reclaims
  this owner's intents (so a second owner can then acquire).

  NB: `socket`/`broker_bin` are explicit args, not env — `System.put_env` does not
  reliably reach the NIF's `std::env`.
  """
  @spec claim_intent(String.t(), String.t(), String.t(), String.t(), String.t()) ::
          {:ok, {reference(), boolean()}} | {:error, String.t()}
  def claim_intent(_socket, _broker_bin, _owner, _file, _code_path),
    do: :erlang.nif_error(:nif_not_loaded)

  @doc "Explicitly release a held broker connection (idempotent with the :DOWN path)."
  @spec release_intent(reference()) :: :ok
  def release_intent(_resource), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Resolve and decode in one step: `{:ok, %{"nodes" => [...], "diagnostics" => [...]}}`
  or `{:error, reason}`.
  """
  @spec resolve(String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def resolve(target, root) do
    # rustler maps Rust `Result<String, String>` to `{:ok, json} | {:error, reason}`.
    case resolve_target(target, root) do
      {:ok, json} when is_binary(json) -> Jason.decode(json)
      {:error, _} = err -> err
      other -> {:error, {:unexpected, other}}
    end
  end
end
