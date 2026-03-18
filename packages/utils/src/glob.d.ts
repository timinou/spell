export interface GlobPathsOptions {
    /** Base directory for glob patterns. Defaults to getProjectDir(). */
    cwd?: string;
    /** Glob exclusion patterns. */
    exclude?: string[];
    /** Abort signal to cancel the glob. */
    signal?: AbortSignal;
    /** Timeout in milliseconds for the glob operation. */
    timeoutMs?: number;
    /** Include dotfiles when true. */
    dot?: boolean;
    /** Only return files (skip directories). Default: true. */
    onlyFiles?: boolean;
    /** Respect .gitignore files when true. Walks up directory tree to find all applicable .gitignore files. */
    gitignore?: boolean;
}
/**
 * Load .gitignore patterns from a directory and its parents.
 * Walks up the directory tree to find all applicable .gitignore files.
 * Returns glob-compatible exclude patterns.
 */
export declare function loadGitignorePatterns(baseDir: string): Promise<string[]>;
/**
 * Resolve filesystem paths matching glob patterns with optional exclude filters.
 * Returns paths relative to the provided cwd (or getProjectDir()).
 * Errors and abort/timeouts are surfaced to the caller.
 */
export declare function globPaths(patterns: string | string[], options?: GlobPathsOptions): Promise<string[]>;
//# sourceMappingURL=glob.d.ts.map