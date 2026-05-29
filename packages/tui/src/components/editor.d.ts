import type { AutocompleteProvider } from "../autocomplete";
import type { SymbolTheme } from "../symbols";
import { type Component, type DirtyParent, type Focusable } from "../tui";
import { type SelectListTheme } from "./select-list";
export interface EditorTheme {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
    symbols: SymbolTheme;
    editorPaddingX?: number;
    /** Style function for inline hint/ghost text (dim text after cursor) */
    hintStyle?: (text: string) => string;
}
export interface EditorTopBorder {
    /** The status content (already styled) */
    content: string;
    /** Visible width of the content */
    width: number;
}
interface HistoryEntry {
    prompt: string;
}
interface HistoryStorage {
    add(prompt: string, cwd?: string): void;
    getRecent(limit: number): HistoryEntry[];
}
export declare class Editor implements Component, Focusable {
    #private;
    /** Focusable interface - set by TUI when focus changes */
    focused: boolean;
    /** When set, replaces the normal cursor glyph at end-of-text with this ANSI-styled string. */
    cursorOverride: string | undefined;
    /** Display width of the cursorOverride glyph (needed because override may contain ANSI escapes). */
    cursorOverrideWidth: number | undefined;
    borderColor: (str: string) => string;
    onAutocompleteUpdate?: () => void;
    onSubmit?: (text: string) => void;
    onAltEnter?: (text: string) => void;
    onChange?: (text: string) => void;
    onAutocompleteCancel?: () => void;
    disableSubmit: boolean;
    setParent(p: DirtyParent | undefined): void;
    /**
     * Propagate a dirty-cache signal up the parent chain.
     *
     * Public surface so subclasses (e.g. `CustomEditor`) can mark dirty
     * from their `handleInput` wrapper without reaching into the private
     * `#parent` field. Without this method, BUG-391's `try/finally` wrapper
     * threw `TypeError: this.markDirty is not a function` on every keystroke;
     * the throw bubbled through the `process.stdin` 'data' listener and was
     * re-emitted as a stdin `'error'` event, which the TUI's pty-loss
     * detector (BUG-387) treated as terminal destruction and gracefully shut
     * the session down on the user's very first input.
     */
    markDirty(): void;
    constructor(theme: EditorTheme);
    setAutocompleteProvider(provider: AutocompleteProvider): void;
    /**
     * Set custom content for the top border (e.g., status line).
     * Pass undefined to use the default plain border.
     */
    setTopBorder(content: EditorTopBorder | undefined): void;
    /**
     * Update the editor border color and propagate dirty so the parent
     * Container's cache (FEAT-762) is invalidated. Prefer this over direct
     * `editor.borderColor = ...` assignment (which is silent).
     */
    setBorderColor(fn: (str: string) => string): void;
    /**
     * Get the available width for top border content given a total terminal width.
     * Accounts for the border characters and horizontal padding.
     */
    getTopBorderAvailableWidth(terminalWidth: number): number;
    /**
     * Use the real terminal cursor instead of rendering a cursor glyph.
     */
    setUseTerminalCursor(useTerminalCursor: boolean): void;
    getUseTerminalCursor(): boolean;
    setMaxHeight(maxHeight: number | undefined): void;
    setPaddingX(paddingX: number): void;
    getAutocompleteMaxVisible(): number;
    setAutocompleteMaxVisible(maxVisible: number): void;
    setHistoryStorage(storage: HistoryStorage): void;
    /**
     * Add a prompt to history for up/down arrow navigation.
     * Called after successful submission.
     */
    addToHistory(text: string): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(data: string): void;
    getText(): string;
    /**
     * Get text with paste markers expanded to their actual content.
     * Use this when you need the full content (e.g., for external editor).
     */
    getExpandedText(): string;
    getLines(): string[];
    getCursor(): {
        line: number;
        col: number;
    };
    moveToLineStart(): void;
    moveToLineEnd(): void;
    moveToMessageStart(): void;
    moveToMessageEnd(): void;
    /**
     * Undo the last meaningful edit while ignoring transient text that is still present at the cursor.
     * Used for command-like autocomplete actions whose typed trigger should not count as the edit being undone.
     */
    undoPastTransientText(transientText: string): void;
    setText(text: string): void;
    /** Insert text at the current cursor position */
    insertText(text: string): void;
    isShowingAutocomplete(): boolean;
}
export {};
//# sourceMappingURL=editor.d.ts.map