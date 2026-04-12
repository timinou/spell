/**
 * Message types for the native Typst editor shell.
 *
 * EditorMessage: sent FROM the QML editor panel TO the backend workflow.
 * PreviewMessage: sent FROM the backend workflow TO the QML panel.
 */

export type EditorMessage =
  | { type: 'content_changed'; text: string; path: string }
  | { type: 'cursor_moved'; line: number; column: number }
  | { type: 'goto_line'; line: number }
  | { type: 'set_content'; text: string; path: string }
  | { type: 'compile_result'; svg: string; errors: Array<{ message: string; line?: number }> }
  | { type: 'click_preview_element'; sourceLine: number }
  | { type: 'template_selected'; templateId: string; templatePath: string }
  | { type: 'file_selected'; filePath: string }
  | { type: 'component_pick'; componentType: string }
  | { type: 'editor_state_changed'; source: string; selectedAnchor?: string; capability: string }
  | { type: 'asset_replace_requested'; anchor: string; path: string }
  | { type: 'variable_update_requested'; name: string; value: string; anchor?: string }
  | { type: 'agent_rewrite_requested'; anchor: string; text: string }
  | { type: 'agent_insert_requested'; afterAnchor: string; heading: string; body: string }
  | { type: 'content_snapshot'; text: string; path: string };

export type PreviewMessage =
  | { type: 'update_svg'; svg: string }
  | { type: 'highlight_line'; line: number }
  | { type: 'show_error'; errors: Array<{ message: string; line?: number }> }
  | { type: 'editor_document'; source: string; selectedAnchor?: string; busy?: boolean; blocks?: unknown[] }
  | { type: 'template_catalog'; templates: Array<{ id: string; name: string; path: string; description: string }> }
  | { type: 'asset_catalog'; assets: Array<{ label: string; path: string }> }
  | { type: 'agent_activity'; busy: boolean };