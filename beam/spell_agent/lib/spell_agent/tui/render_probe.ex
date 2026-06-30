defmodule SpellAgent.Tui.RenderProbe do
  @moduledoc """
  Headless re-render probe for agent-authored layout nodes (BUG-012 fix C).

  Gives the agent eyes: it can ask "what would this node look like?" and get
  back the ASCII buffer that `ExRatatui` would draw. The probe RE-RENDERS the
  node standalone on a throwaway headless terminal — it does NOT read the live
  frame, because in production the App draws to a real TTY and the agent runs in
  a separate PTC sandbox process, so the live screen is genuinely unreadable
  cross-process.

  Faithful for pure `view/*` widget/split trees: those are exactly the data
  shapes `Surface.render/2` turns into placements. A `"pane"` node, by contrast,
  needs live App state that this module does not have; it renders as empty, and
  the tool reports that clearly rather than crashing.

  The probe is total: a throwing widget or a malformed node yields an error
  tuple (or an `%{"err" => ...}` map at the tool surface), and the throwaway
  terminal is always restored.
  """

  alias ExRatatui.Layout.Rect
  alias SpellAgent.Tui.{LayoutRegistry, Surface, Tree}

  @default_width 80
  @default_height 24

  @typedoc "Result of a successful headless render."
  @type render_result :: %{
          required(:buffer) => String.t(),
          required(:width) => non_neg_integer(),
          required(:height) => non_neg_integer()
        }

  @doc """
  Render a layout `node` to a headless test terminal and return its ASCII buffer.

  Options:
    * `:width` — terminal width (default #{@default_width})
    * `:height` — terminal height (default #{@default_height})
    * `:data_env` — data environment for resolving `tmpl::` holes (default `%{}`)

  Returns `{:ok, %{buffer: ascii, width: w, height: h}}` or `{:error, reason}`.
  A pane-only or otherwise unrenderable node returns `{:error, :empty_render}`.
  Any raise or throw during hole resolution, layout, or draw is caught.
  """
  @spec render(term(), keyword()) :: {:ok, render_result()} | {:error, term()}
  def render(node, opts \\ []) do
    width = (parse_dimension(Keyword.get(opts, :width, @default_width)) || @default_width)
    height = (parse_dimension(Keyword.get(opts, :height, @default_height)) || @default_height)
    data_env = Keyword.get(opts, :data_env, %{})
    rect = %Rect{x: 0, y: 0, width: width, height: height}

    try do
      resolved = Surface.resolve_holes(node, data_env)
      placements = Surface.render(resolved, rect)

      case placements do
        [] ->
          {:error, :empty_render}

        _ ->
          terminal = ExRatatui.init_test_terminal(width, height)

          try do
            :ok = ExRatatui.draw(terminal, placements)
            content = ExRatatui.get_buffer_content(terminal)
            {:ok, %{buffer: content, width: width, height: height}}
          after
            ExRatatui.Native.restore_terminal(terminal)
          end
      end
    rescue
      e -> {:error, {:render_failed, Exception.message(e)}}
    catch
      kind, value -> {:error, {:render_failed, Exception.format_banner(kind, value)}}
    end
  end

  @doc """
  The `layout/render` tool entry (qualified name => `(args -> value)`).

  Args (string or atom keys):
    * `:slot` — read the live node from `LayoutRegistry.show(slot)`
    * `:source` or `:node` — render this node map directly
    * `:width`/`:height` — optional positive integers

  Returns a string-keyed map: `%{"buffer" => ascii, "width" => w, "height" => h}`
  on success, or `%{"err" => "..."}` on any failure.
  """
  @spec tools() :: %{optional(String.t()) => (map() -> term())}
  def tools do
    %{
      "layout/render" => fn args ->
        slot = strget(args, "slot")
        node = strget(args, "source") || strget(args, "node")
        width = parse_dimension(strget(args, "width"))
        height = parse_dimension(strget(args, "height"))

        cond do
          is_binary(slot) ->
            case LayoutRegistry.show(slot) do
              {:ok, slot_node} -> render_to_tool(slot_node, width, height)
              {:error, :unknown_slot} -> %{"err" => "unknown slot #{slot}"}
            end

          is_map(node) ->
            render_to_tool(node, width, height)

          true ->
            %{"err" => "layout/render requires a :slot or :source"}
        end
      end
    }
  end

  # ---- internals ----

  defp render_to_tool(node, width, height) do
    opts = [width: width, height: height]

    case render(node, opts) do
      {:ok, %{buffer: buffer, width: w, height: h}} ->
        %{"buffer" => buffer, "width" => w, "height" => h}

      {:error, :empty_render} ->
        %{
          "err" =>
            "layout/render produced no renderable widgets; " <>
              "pane nodes need the live app and cannot be previewed standalone"
        }
      {:error, reason} ->
        %{"err" => "layout/render failed: #{format_reason(reason)}"}
    end
  end

  defp format_reason({:render_failed, message}), do: message

  defp parse_dimension(nil), do: nil
  defp parse_dimension(n) when is_integer(n) and n > 0, do: n
  defp parse_dimension(s) when is_binary(s) do
    case Integer.parse(String.trim(s)) do
      {n, ""} when n > 0 -> n
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp parse_dimension(_), do: nil

  defp strget(m, key), do: Tree.get(m, key)
end
