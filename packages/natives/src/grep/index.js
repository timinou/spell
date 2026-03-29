/**
 * Native ripgrep wrapper using N-API.
 */
import { native } from "../native";
/**
 * Search files for a regex pattern with optional streaming callback.
 */
export async function grep(options, onMatch) {
    // napi-rs ThreadsafeFunction passes (error, value) - skip callback on error
    const cb = onMatch ? (err, m) => !err && onMatch(m) : undefined;
    return native.grep(options, cb);
}
/**
 * Search a single file's content for a pattern.
 * Lower-level API for when you already have file content.
 *
 * Accepts `Uint8Array`/`Buffer` for zero-copy when content is already UTF-8 encoded.
 */
export function searchContent(content, options) {
    return native.search(content, options);
}
/**
 * Quick check if content contains a pattern match.
 *
 * Accepts `Uint8Array`/`Buffer` for zero-copy when content/pattern are already UTF-8 encoded.
 */
export function hasMatch(content, pattern, options) {
    return native.hasMatch(content, pattern, options?.ignoreCase ?? false, options?.multiline ?? false);
}
/**
 * Fuzzy file path search for autocomplete.
 *
 * Searches for files and directories whose paths contain the query substring
 * (case-insensitive). Respects .gitignore by default.
 */
export async function fuzzyFind(options) {
    return native.fuzzyFind(options);
}
//# sourceMappingURL=index.js.map