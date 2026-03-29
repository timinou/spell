/**
 * File discovery API powered by globset + ignore crate.
 */
import * as path from "node:path";
import { native } from "../native";
export { FileType } from "./types";
/**
 * Find files matching a glob pattern.
 * Respects .gitignore by default.
 */
export async function glob(options, onMatch) {
    const searchPath = path.resolve(options.path);
    const pattern = options.pattern || "*";
    // napi-rs ThreadsafeFunction passes (error, value) - skip callback on error
    const cb = onMatch ? (err, m) => !err && onMatch(m) : undefined;
    return native.glob({
        ...options,
        path: searchPath,
        pattern,
        hidden: options.hidden ?? false,
        gitignore: options.gitignore ?? true,
        recursive: options.recursive ?? true,
    }, cb);
}
/**
 * Invalidate the filesystem scan cache.
 *
 * When called with a path, removes entries for roots containing that path.
 * When called without a path, clears the entire cache.
 */
export function invalidateFsScanCache(path) {
    native.invalidateFsScanCache(path);
}
//# sourceMappingURL=index.js.map