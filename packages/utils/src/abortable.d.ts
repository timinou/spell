export declare class AbortError extends Error {
    constructor(signal: AbortSignal);
}
/**
 * Sleep for a given number of milliseconds, respecting abort signal.
 */
export declare function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Creates an abortable stream from a given stream and signal.
 *
 * @param stream - The stream to make abortable
 * @param signal - The signal to abort the stream
 * @returns The abortable stream
 */
export declare function createAbortableStream<T>(stream: ReadableStream<T>, signal?: AbortSignal): ReadableStream<T>;
/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with a standard error.
 *
 * @param signal - Optional AbortSignal to cancel the operation
 * @param pr - Function returning a promise to run
 * @returns Promise resolving as `pr` would, or rejecting on abort
 */
export declare function untilAborted<T>(signal: AbortSignal | undefined | null, pr: () => Promise<T>): Promise<T>;
/**
 * Memoizes a function with no arguments, calling it once and caching the result.
 *
 * @param fn - Function to be called once
 * @returns A function that returns the cached result of `fn`
 */
export declare function once<T>(fn: () => T): () => T;
//# sourceMappingURL=abortable.d.ts.map