defmodule SpellAgent.Hist.Id do
  @moduledoc """
  Content-addressed identity for history nodes (PLAN-001).

  A node id is a hash of its rendered form source plus its parent id. Two branches
  — or two whole sessions — that ran the same program at the same point in the DAG
  collapse to one id. This is what makes multi-session "union" a set-merge and what
  makes a re-run dedup against a prior identical run (the memo table in
  `[:hist, :index, :hash]`).

  Uses `:crypto.hash(:sha256, ...)` (the `:crypto` app is already an extra
  application) truncated to 16 hex chars — ample for a single project's forest, and
  short enough to read in a log.
  """

  @doc """
  Content id for a node from its rendered `form_src` and `parent_id` (nil at a root).
  """
  @spec node_id(form_src :: String.t() | nil, parent_id :: String.t() | nil) :: String.t()
  def node_id(form_src, parent_id) do
    # Tag parent presence so a root (nil parent) can NEVER collide with a node
    # whose parent id is the empty string (BUG-001 B4). The 0x00 byte cannot
    # appear in a hex content id, so the two domains are disjoint.
    parent_tag = if is_nil(parent_id), do: <<0>>, else: [<<1>>, parent_id]
    payload = [parent_tag, "\n", form_src || ""]
    :crypto.hash(:sha256, payload) |> Base.encode16(case: :lower) |> binary_part(0, 16)
  end

  @doc "Random opaque id (marks, sessions, crystals) — not content-addressed."
  @spec rand(prefix :: String.t()) :: String.t()
  def rand(prefix) do
    suffix = :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)
    prefix <> "-" <> suffix
  end
end
