export declare enum Reason {
    PRE_EXIT = "pre_exit",// Pre-exit phase (not used by default)
    EXIT = "exit",// Normal process exit
    SIGINT = "sigint",// Ctrl-C or SIGINT
    SIGTERM = "sigterm",// SIGTERM
    SIGHUP = "sighup",// SIGHUP
    UNCAUGHT_EXCEPTION = "uncaught_exception",// Fatal exception
    UNHANDLED_REJECTION = "unhandled_rejection",// Unhandled promise rejection
    MANUAL = "manual"
}
export interface CrashSessionContext {
    session: {
        id: string | null;
        file: string | null;
        cwd: string | null;
    } | null;
    model: {
        provider: string | null;
        id: string | null;
        key: string | null;
    } | null;
}
export declare function registerSessionContext(getter: () => CrashSessionContext | null | undefined): void;
/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export declare function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void;
/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export declare function cleanup(): Promise<void>;
/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export declare function quit(code?: number): Promise<void>;
//# sourceMappingURL=postmortem.d.ts.map