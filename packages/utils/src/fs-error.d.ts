/**
 * Type-safe filesystem error handling utilities.
 *
 * Use these to check error codes without string matching on messages:
 *
 * @example
 * ```ts
 * import { isEnoent, isFsError } from "@oh-my-pi/pi-utils";
 *
 * try {
 *     return await Bun.file(path).text();
 * } catch (err) {
 *     if (isEnoent(err)) return null;
 *     throw err;
 * }
 * ```
 */
export interface FsError extends Error {
    code: string;
    errno?: number;
    syscall?: string;
    path?: string;
}
export declare function isFsError(err: unknown): err is FsError;
export declare function isEnoent(err: unknown): err is FsError;
export declare function isEacces(err: unknown): err is FsError;
export declare function isEisdir(err: unknown): err is FsError;
export declare function isEnotdir(err: unknown): err is FsError;
export declare function isEexist(err: unknown): err is FsError;
export declare function isEnotempty(err: unknown): err is FsError;
export declare function hasFsCode(err: unknown, code: string): err is FsError;
//# sourceMappingURL=fs-error.d.ts.map