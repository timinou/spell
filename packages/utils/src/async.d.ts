/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Cleans up all listeners on settlement.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T>;
//# sourceMappingURL=async.d.ts.map