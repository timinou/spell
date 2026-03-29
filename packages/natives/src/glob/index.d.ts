/**
 * File discovery API powered by globset + ignore crate.
 */
import type { GlobMatch, GlobOptions, GlobResult } from "./types";
export type { GlobMatch, GlobOptions, GlobResult } from "./types";
export { FileType } from "./types";
/**
 * Find files matching a glob pattern.
 * Respects .gitignore by default.
 */
export declare function glob(options: GlobOptions, onMatch?: (match: GlobMatch) => void): Promise<GlobResult>;
/**
 * Invalidate the filesystem scan cache.
 *
 * When called with a path, removes entries for roots containing that path.
 * When called without a path, clears the entire cache.
 */
export declare function invalidateFsScanCache(path?: string): void;
//# sourceMappingURL=index.d.ts.map