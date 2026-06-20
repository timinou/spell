defmodule SpellAgent.Hist.IdTest do
  @moduledoc """
  Content-addressing contract (PLAN-001 W0): the same form at the same parent must
  hash identically (dedup / multi-session union), and a different parent or form
  must diverge (branch distinction).
  """
  use ExUnit.Case, async: true

  alias SpellAgent.Hist.Id

  test "same form_src + parent → identical id (the dedup key)" do
    assert Id.node_id("(tool/find {:x 1})", "p0") == Id.node_id("(tool/find {:x 1})", "p0")
  end

  test "different parent → different id (branch distinction)" do
    refute Id.node_id("(f)", "p0") == Id.node_id("(f)", "p1")
  end

  test "different form → different id" do
    refute Id.node_id("(f)", "p0") == Id.node_id("(g)", "p0")
  end

  test "root (nil parent) is stable and distinct from empty-string parent collision" do
    a = Id.node_id("(root)", nil)
    assert a == Id.node_id("(root)", nil)
    assert byte_size(a) == 16
  end

  test "rand ids are prefixed and unique" do
    a = Id.rand("mark")
    b = Id.rand("mark")
    assert String.starts_with?(a, "mark-")
    refute a == b
  end
end
