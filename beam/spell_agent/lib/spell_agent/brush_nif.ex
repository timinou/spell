defmodule SpellAgent.BrushNif do
  @moduledoc """
  Rustler NIF bindings for brush (a Rust bash) execution (PLAN-011 W0).

  The agent never passes a command STRING to the shell. It passes an argv
  VECTOR; the NIF builds a brush AST directly from that vector, single-quote
  escaping each element so brush applies no expansion and no re-tokenization
  (`SpellAgent.BrushNif` is inject-proof by construction — see the crate's
  `src/argv.rs`). This module is the thin Elixir surface; policy (validation,
  the structured result map, durability) lives in `SpellAgent.Sh`.

  The Rust crate is vendored at `beam/brush_nif-vendored` and built from source
  via rustler, mirroring how `ex_ratatui` is vendored and patched.
  """

  # The crate is vendored OUTSIDE the app dir (a sibling, like ex_ratatui), so we
  # point rustler at it explicitly rather than the default `native/<crate>`.
  use Rustler,
    otp_app: :spell_agent,
    crate: "brush_nif",
    path: "../brush_nif-vendored/native/brush_nif"

  @typedoc """
  The structured result of one command. String-keyed so it crosses the
  Lisp/Elixir boundary as plain data:

    * `"exit"` — integer exit code. `-1` = the NIF trapped a panic;
      `124` = the command hit its timeout; otherwise the process exit code.
    * `"out"` — captured stdout (UTF-8, lossy).
    * `"err"` — captured stderr, with any timeout/panic note appended.
  """
  @type result :: %{required(String.t()) => integer() | String.t()}

  @doc """
  Run an argv vector on brush and capture its output.

  `argv` MUST be a non-empty list of binaries (validated upstream in
  `SpellAgent.Sh`; the NIF re-checks defensively and returns `exit: 2` on an
  empty argv). `env` is a map of extra environment variables to export. `opts`
  accepts `"cwd"` (binary) and `"timeout_ms"` (integer, default 30_000).

  Never raises for a command-level failure — a non-zero exit, a timeout, and a
  trapped panic all come back as a `t:result/0` map.
  """
  @spec run([String.t()], %{optional(String.t()) => String.t()}, map()) :: result()
  def run(_argv, _env, _opts), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Run a multi-stage pipeline on brush (PLAN-011 W4).

  `stages` is a list of argv vectors; brush connects each stage's stdout to the
  next stage's stdin (`a | b | c`). Every stage is escaped independently, so the
  pipeline is inject-proof per stage exactly like `run/3`. The result map is the
  same shape as `run/3`; `exit` is the pipeline's overall exit (its last stage,
  per shell semantics).
  """
  @spec pipe([[String.t()]], %{optional(String.t()) => String.t()}, map()) :: result()
  def pipe(_stages, _env, _opts), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Parse a bash string into a PTC-native `form_tree` tree (PLAN-011 W5).

  Returns `{:ok, tree}` where `tree` is a string-keyed map of the same shape
  `SpellAgent.Hist.Lens.form_tree/1` produces for Lisp forms
  (`%{"node" => kind, "name"? => _, "value"? => _, "children"? => [_]}`).
  Valid-but-exotic bash degrades to `%{"node" => "raw", "value" => <source>}`
  leaves rather than erroring; `{:error, reason}` is only a genuine parse error.
  """
  @spec parse(String.t()) :: {:ok, map()} | {:error, String.t()}
  def parse(_src), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Render a `form_tree`-shaped tree back into a bash string (PLAN-011 W5).

  Words are re-escaped (single-quote rules) so a round-trip can never
  reintroduce shell injection. Returns `{:ok, bash}`.
  """
  @spec unparse(map()) :: {:ok, String.t()} | {:error, String.t()}
  def unparse(_tree), do: :erlang.nif_error(:nif_not_loaded)
end
