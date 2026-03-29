import { matchesKey, parseKey } from "./keys";
/**
 * Default editor keybindings.
 */
export const DEFAULT_EDITOR_KEYBINDINGS = {
    // Cursor movement
    cursorUp: "up",
    cursorDown: "down",
    cursorLeft: ["left", "ctrl+b"],
    cursorRight: ["right", "ctrl+f"],
    cursorWordLeft: ["alt+left", "ctrl+left", "alt+b"],
    cursorWordRight: ["alt+right", "ctrl+right", "alt+f"],
    cursorLineStart: ["home", "ctrl+a"],
    cursorLineEnd: ["end", "ctrl+e"],
    jumpForward: "ctrl+]",
    jumpBackward: "ctrl+alt+]",
    // Deletion
    deleteCharBackward: "backspace",
    deleteCharForward: ["delete", "ctrl+d"],
    deleteWordBackward: ["ctrl+w", "alt+backspace", "ctrl+backspace"],
    deleteWordForward: ["alt+delete", "alt+d"],
    deleteToLineStart: "ctrl+u",
    deleteToLineEnd: "ctrl+k",
    // Text input
    newLine: "shift+enter",
    submit: "enter",
    tab: "tab",
    // Selection/autocomplete
    selectUp: "up",
    selectDown: "down",
    selectPageUp: "pageUp",
    selectPageDown: "pageDown",
    selectConfirm: "enter",
    selectCancel: ["escape", "ctrl+c"],
    // Clipboard
    copy: "ctrl+c",
    // Kill ring / undo
    undo: "ctrl+-",
    yank: "ctrl+y",
    yankPop: "alt+y",
};
const SHIFTED_SYMBOL_KEYS = new Set([
    "!",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "_",
    "+",
    "{",
    "}",
    "|",
    ":",
    "<",
    ">",
    "?",
    "~",
]);
const normalizeKeyId = (key) => key.toLowerCase();
/**
 * Manages keybindings for the editor.
 */
export class EditorKeybindingsManager {
    #actionToKeys;
    constructor(config = {}) {
        this.#actionToKeys = new Map();
        this.#buildMaps(config);
    }
    #buildMaps(config) {
        this.#actionToKeys.clear();
        // Start with defaults
        for (const [action, keys] of Object.entries(DEFAULT_EDITOR_KEYBINDINGS)) {
            const keyArray = Array.isArray(keys) ? keys : [keys];
            this.#actionToKeys.set(action, keyArray.map(key => normalizeKeyId(key)));
        }
        // Override with user config
        for (const [action, keys] of Object.entries(config)) {
            if (keys === undefined)
                continue;
            const keyArray = Array.isArray(keys) ? keys : [keys];
            this.#actionToKeys.set(action, keyArray.map(key => normalizeKeyId(key)));
        }
    }
    /**
     * Check if input matches a specific action.
     */
    matches(data, action) {
        const keys = this.#actionToKeys.get(action);
        if (!keys)
            return false;
        for (const key of keys) {
            if (matchesKey(data, key))
                return true;
        }
        const parsed = parseKey(data);
        if (!parsed || !parsed.startsWith("shift+"))
            return false;
        const keyName = parsed.slice("shift+".length);
        if (!SHIFTED_SYMBOL_KEYS.has(keyName))
            return false;
        return keys.includes(keyName);
    }
    /**
     * Get keys bound to an action.
     */
    getKeys(action) {
        return this.#actionToKeys.get(action) ?? [];
    }
    /**
     * Update configuration.
     */
    setConfig(config) {
        this.#buildMaps(config);
    }
}
// Global instance
let globalEditorKeybindings = null;
export function getEditorKeybindings() {
    if (!globalEditorKeybindings) {
        globalEditorKeybindings = new EditorKeybindingsManager();
    }
    return globalEditorKeybindings;
}
export function setEditorKeybindings(manager) {
    globalEditorKeybindings = manager;
}
//# sourceMappingURL=keybindings.js.map