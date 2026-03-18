/**
 * Shared tab indentation resolution utilities.
 *
 * Resolves tab width from a configurable default and optional per-file `.editorconfig` rules.
 * This module intentionally has no dependency on higher-level settings systems.
 */
/**
 * Sets the process-wide default tab width used when no file-specific override applies.
 *
 * @param width Desired tab width in spaces. Values are clamped to a safe range.
 */
export declare function setDefaultTabWidth(width: number): void;
/**
 * Gets the current process-wide default tab width.
 */
export declare function getDefaultTabWidth(): number;
/**
 * Returns indentation used to replace a tab character.
 *
 * If `file` is provided, `.editorconfig` rules are resolved for that file path and applied.
 * Otherwise, the configured default tab width is used.
 *
 * @param file Optional absolute or project-relative file path for editorconfig resolution
 * @returns A string containing N spaces representing one tab
 */
export declare function getIndentation(file?: string): string;
//# sourceMappingURL=indent.d.ts.map