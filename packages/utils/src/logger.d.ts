/**
 * Centralized logger for spell.
 *
 * Logs to ~/.spell/logs/spell.YYYY-MM-DD.log with size-based rotation.
 * Safe for concurrent access from multiple spell instances.
 *
 * @example
 * ```typescript
 * import { logger } from "@oh-my-pi/pi-utils";
 *
 * logger.error("MCP request failed", { url, method });
 * logger.warn("Theme file invalid, using fallback", { path });
 * logger.debug("LSP fallback triggered", { reason });
 * ```
 */
export interface Logger {
    error(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    debug(message: string, context?: Record<string, unknown>): void;
    time<T>(op: string, fn: () => T): T;
    timeAsync<T>(op: string, fn: () => PromiseLike<T>): Promise<T>;
}
/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export declare function error(message: string, context?: Record<string, unknown>): void;
/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export declare function warn(message: string, context?: Record<string, unknown>): void;
/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export declare function debug(message: string, context?: Record<string, unknown>): void;
/**
 * Print all collected long operation timings to stderr.
 * To be called at the end of a startup or timing window.
 */
export declare function printTimings(): void;
/**
 * Begin recording long operation timings.
 * Typically called at the beginning of startup.
 */
export declare function startTiming(): void;
/**
 * End timing window and print all timings.
 * Disables further buffering until next startTiming().
 */
export declare function endTiming(): void;
/**
 * Time a synchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export declare function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
/**
 * Time an asynchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export declare function timeAsync<R, A extends unknown[]>(op: string, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
//# sourceMappingURL=logger.d.ts.map