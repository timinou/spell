/**
 * Message types for the editor-preview bridge.
 *
 * EditorMessage: sent FROM the QML editor panel TO the backend agent.
 * PreviewMessage: sent FROM the backend TO the QML panel.
 */

export type EditorMessage =
  // User typed; backend should debounce and compile.
  | { type: 'content_changed'; text: string; path: string }
  // Cursor moved in editor; backend may want to highlight corresponding preview element.
  | { type: 'cursor_moved'; line: number; column: number }
  // Request the editor to scroll to a specific line (inbound to editor).
  | { type: 'goto_line'; line: number }
  // Backend pushes authoritative content (e.g. agent write, template insertion).
  | { type: 'set_content'; text: string; path: string }
  // Compile finished; carry both the rendered SVG and any diagnostics.
  | { type: 'compile_result'; svg: string; errors: Array<{ message: string; line?: number }> }
  // User clicked a preview element; backend resolves source position.
  | { type: 'click_preview_element'; sourceLine: number }
  // User selected a template from the template drawer.
  | { type: 'template_selected'; templateId: string; templatePath: string }
  // User selected a file from the file tree.
  | { type: 'file_selected'; filePath: string }
  // Full content snapshot; used for saves and sync handshakes.
  | { type: 'content_snapshot'; text: string; path: string };

export type PreviewMessage =
  // Push fresh SVG into the preview pane.
  | { type: 'update_svg'; svg: string }
  // Highlight the line in the editor that corresponds to a preview click.
  | { type: 'highlight_line'; line: number }
  // Surface compiler diagnostics in the editor gutter / error panel.
  | { type: 'show_error'; errors: Array<{ message: string; line?: number }> };
