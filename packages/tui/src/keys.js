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
import { matchesKey as matchesKeyNative, parseKey as parseKeyNative, parseKittySequence as parseKittySequenceNative, } from "@oh-my-pi/pi-natives";
// =============================================================================
// Global Kitty Protocol State
// =============================================================================
let kittyProtocolActive = false;
/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active) {
    kittyProtocolActive = active;
}
/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive() {
    return kittyProtocolActive;
}
// Regex for Kitty protocol event type detection
// Matches CSI sequences with :2 (repeat) or :3 (release) event type
// Format: \x1b[...;modifier:event_type<terminator> where terminator is u, ~, or A-F/H
const KITTY_RELEASE_PATTERN = /^\x1b\[[\d:;]*:3[u~ABCDHF]$/;
const KITTY_REPEAT_PATTERN = /^\x1b\[[\d:;]*:2[u~ABCDHF]$/;
const KITTY_CSI_U_PATTERN = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?(?:;([\d:]*))?u$/;
const KITTY_MOD_SHIFT = 1;
const KITTY_MOD_ALT = 2;
const KITTY_MOD_CTRL = 4;
const KITTY_MOD_NUM_LOCK = 128;
const KITTY_KEYPAD_OPERATOR_TEXT = {
    57410: "/",
    57411: "*",
    57412: "-",
    57413: "+",
    57415: "=",
};
const KITTY_NUMPAD_TEXT = {
    57399: "0",
    57400: "1",
    57401: "2",
    57402: "3",
    57403: "4",
    57404: "5",
    57405: "6",
    57406: "7",
    57407: "8",
    57408: "9",
    57409: ".",
};
/**
 * Check if the input is a key release event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRelease(data) {
    // Only detect release events when Kitty protocol is active
    if (!kittyProtocolActive) {
        return false;
    }
    // Don't treat bracketed paste content as key release
    if (data.includes("\x1b[200~")) {
        return false;
    }
    // Match the full CSI sequence pattern for release events
    return KITTY_RELEASE_PATTERN.test(data);
}
/**
 * Check if the input is a key repeat event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRepeat(data) {
    // Only detect repeat events when Kitty protocol is active
    if (!kittyProtocolActive) {
        return false;
    }
    // Don't treat bracketed paste content as key repeat
    if (data.includes("\x1b[200~")) {
        return false;
    }
    // Match the full CSI sequence pattern for repeat events
    return KITTY_REPEAT_PATTERN.test(data);
}
export function parseKittySequence(data) {
    const result = parseKittySequenceNative(data);
    if (!result)
        return null;
    return {
        codepoint: result.codepoint,
        shiftedKey: result.shiftedKey ?? undefined,
        baseLayoutKey: result.baseLayoutKey ?? undefined,
        modifier: result.modifier,
        eventType: result.eventType,
    };
}
function hasControlChars(data) {
    return [...data].some(ch => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
}
function decodeKittyPrintable(data) {
    const match = data.match(KITTY_CSI_U_PATTERN);
    if (!match)
        return undefined;
    const codepoint = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(codepoint))
        return undefined;
    if (match[5] === "3")
        return undefined;
    const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
    const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
    const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
    const effectiveMod = modifier & ~(64 + 128);
    const supportedModifierMask = KITTY_MOD_SHIFT | KITTY_MOD_ALT | KITTY_MOD_CTRL;
    if (effectiveMod & ~supportedModifierMask)
        return undefined;
    if (effectiveMod & (KITTY_MOD_ALT | KITTY_MOD_CTRL))
        return undefined;
    const textField = match[6];
    if (textField && textField.length > 0) {
        const codepoints = textField
            .split(":")
            .filter(Boolean)
            .map(value => Number.parseInt(value, 10))
            .filter(value => Number.isFinite(value) && value >= 32);
        if (codepoints.length > 0) {
            try {
                return String.fromCodePoint(...codepoints);
            }
            catch {
                return undefined;
            }
        }
    }
    const keypadOperatorText = KITTY_KEYPAD_OPERATOR_TEXT[codepoint];
    if (keypadOperatorText)
        return keypadOperatorText;
    if (effectiveMod === 0 && modifier & KITTY_MOD_NUM_LOCK) {
        const numpadText = KITTY_NUMPAD_TEXT[codepoint];
        if (numpadText)
            return numpadText;
    }
    let effectiveCodepoint = codepoint;
    if (effectiveMod & KITTY_MOD_SHIFT && typeof shiftedKey === "number") {
        effectiveCodepoint = shiftedKey;
    }
    if (effectiveCodepoint >= 0xe000 && effectiveCodepoint <= 0xf8ff) {
        return undefined;
    }
    if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32)
        return undefined;
    try {
        return String.fromCodePoint(effectiveCodepoint);
    }
    catch {
        return undefined;
    }
}
/**
 * Extract printable text from raw terminal input.
 *
 * Handles Kitty CSI-u text-producing keys so text-entry components can treat
 * keypad digits, keypad operators, and shifted symbols the same as direct character input.
 */
export function extractPrintableText(data) {
    const kittyText = decodeKittyPrintable(data);
    if (kittyText)
        return kittyText;
    if (data.length === 0 || hasControlChars(data))
        return undefined;
    return data;
}
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
export function matchesKey(data, keyId) {
    return matchesKeyNative(data, keyId, kittyProtocolActive);
}
/**
 * Parse terminal input and return a normalized key identifier.
 *
 * Returns key names like "escape", "ctrl+c", "shift+tab", "alt+enter".
 * Returns undefined if the input is not a recognized key sequence.
 *
 * @param data - Raw input data from terminal
 */
export function parseKey(data) {
    return parseKeyNative(data, kittyProtocolActive) ?? undefined;
}
//# sourceMappingURL=keys.js.map