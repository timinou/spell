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
export function isFsError(err) {
    return err instanceof Error && "code" in err && typeof err.code === "string";
}
export function isEnoent(err) {
    return isFsError(err) && err.code === "ENOENT";
}
export function isEacces(err) {
    return isFsError(err) && err.code === "EACCES";
}
export function isEisdir(err) {
    return isFsError(err) && err.code === "EISDIR";
}
export function isEnotdir(err) {
    return isFsError(err) && err.code === "ENOTDIR";
}
export function isEexist(err) {
    return isFsError(err) && err.code === "EEXIST";
}
export function isEnotempty(err) {
    return isFsError(err) && err.code === "ENOTEMPTY";
}
export function hasFsCode(err, code) {
    return isFsError(err) && err.code === code;
}
//# sourceMappingURL=fs-error.js.map