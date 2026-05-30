/**
 * Keyboard input handling for terminal applications.
 *
 * Supports both legacy terminal sequences and Kitty keyboard protocol.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * Reference: https://github.com/sst/opentui/blob/7da92b4088aebfe27b9f691c04163a48821e49fd/packages/core/src/lib/parse.keypress.ts
 *
 * Symbol keys are also supported, however some ctrl+symbol combos
 * overlap with ASCII codes, e.g. ctrl+[ = ESC.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-ctrl-mapping-of-ascii-keys
 * Those can still be * used for ctrl+shift combos
 *
 * API:
 * - matchesKey(data, keyId) - Check if input matches a key identifier
 * - parseKey(data) - Parse input and return the key identifier
 * - Key - Helper object for creating typed key identifiers
 * - setKittyProtocolActive(active) - Set global Kitty protocol state
 * - isKittyProtocolActive() - Query global Kitty protocol state
 */
import { type KeyEventType } from "@spell/pi-natives";
/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export declare function setKittyProtocolActive(active: boolean): void;
/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export declare function isKittyProtocolActive(): boolean;
type Letter = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type SymbolKey = "`" | "-" | "=" | "[" | "]" | "\\" | ";" | "'" | "," | "." | "/" | "!" | "@" | "#" | "$" | "%" | "^" | "&" | "*" | "(" | ")" | "_" | "+" | "|" | "~" | "{" | "}" | ":" | "<" | ">" | "?";
type SpecialKey = "escape" | "esc" | "enter" | "return" | "tab" | "space" | "backspace" | "delete" | "insert" | "clear" | "home" | "end" | "pageUp" | "pageDown" | "up" | "down" | "left" | "right" | "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";
type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | `ctrl+${BaseKey}` | `shift+${BaseKey}` | `alt+${BaseKey}` | `ctrl+shift+${BaseKey}` | `shift+ctrl+${BaseKey}` | `ctrl+alt+${BaseKey}` | `alt+ctrl+${BaseKey}` | `shift+alt+${BaseKey}` | `alt+shift+${BaseKey}` | `ctrl+shift+alt+${BaseKey}` | `ctrl+alt+shift+${BaseKey}` | `shift+ctrl+alt+${BaseKey}` | `shift+alt+ctrl+${BaseKey}` | `alt+ctrl+shift+${BaseKey}` | `alt+shift+ctrl+${BaseKey}`;
interface ParsedKittySequence {
    codepoint: number;
    shiftedKey?: number;
    baseLayoutKey?: number;
    modifier: number;
    eventType?: KeyEventType;
}
/**
 * Check if the input is a key release event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export declare function isKeyRelease(data: string): boolean;
/**
 * Check if the input is a key repeat event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export declare function isKeyRepeat(data: string): boolean;
export declare function parseKittySequence(data: string): ParsedKittySequence | null;
/**
 * Extract printable text from raw terminal input.
 *
 * Handles Kitty CSI-u text-producing keys so text-entry components can treat
 * keypad digits, keypad operators, and shifted symbols the same as direct character input.
 */
export declare function extractPrintableText(data: string): string | undefined;
/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
export declare function matchesKey(data: string, keyId: KeyId): boolean;
/**
 * Parse terminal input and return a normalized key identifier.
 *
 * Returns key names like "escape", "ctrl+c", "shift+tab", "alt+enter".
 * Returns undefined if the input is not a recognized key sequence.
 *
 * @param data - Raw input data from terminal
 */
export declare function parseKey(data: string): string | undefined;
export {};
//# sourceMappingURL=keys.d.ts.map