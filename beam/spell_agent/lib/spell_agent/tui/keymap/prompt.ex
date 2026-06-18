defmodule SpellAgent.Tui.Keymap.Prompt do
  @moduledoc """
  The prompt-pane NORMAL-mode context (PLAN-346 W5).

  When the prompt is focused in NORMAL mode, `enter` enters INSERT mode (start
  typing a mission) rather than submitting an empty buffer. This is the modal
  entry point: launch lands here (prompt focus, NORMAL), you press `enter` to
  type, then `enter` again (handled in INSERT mode by the App) submits.

  A context, not a render pane: `keymap/0` + `react/3` + `context_name/0` only.
  """

  use SpellAgent.Tui.Pane

  alias SpellAgent.Tui.Ui

  @spec context_name() :: :prompt
  def context_name, do: :prompt

  keymap([
    {"enter", :"mode/insert"}
  ])

  @impl true
  def view(_), do: []

  # mode/insert is App-intercepted (it flips the modal layer, which a pure
  # Ui->Ui reaction expresses but the App also wants to focus the prompt);
  # identity here so a stray dispatch can't corrupt the gaze.
  @impl true
  def react(:"mode/insert", %Ui{} = ui, _forest), do: Ui.mode(ui, :insert)
  def react(_intent, %Ui{} = ui, _forest), do: ui
end
