export interface DaemonConfig {
    /** Human-readable name for logging and postmortem registration (e.g. "emacs-main"). */
    name: string;
    /** Command + args to spawn the daemon. Must use foreground mode (no fork). */
    command: string[];
    /** Absolute path to the Unix socket the daemon will create to signal readiness. */
    socketPath: string;
    /** How to gracefully stop the daemon. If omitted, only proc.kill() is used. */
    stopCommand?: string[];
    /** Health check interval in ms (default: 5000). Set 0 to disable. */
    healthIntervalMs?: number;
    /** Maximum time to wait for the socket to appear (default: 30000). */
    startupTimeoutMs?: number;
    /** Spawn environment variables. Merged with process.env. */
    env?: Record<string, string>;
    /** Working directory for the spawned process. */
    cwd?: string;
    /** Pipe stderr and forward lines to logger (default: true). */
    logStderr?: boolean;
    /** Callback fired if socket disappears after daemon was healthy (crash detection). */
    onCrash?: () => void;
}
export interface ManagedDaemon {
    /** Absolute path to the Unix socket. */
    readonly socketPath: string;
    /** PID of the daemon process (valid because foreground mode, no fork). */
    readonly pid: number;
    /** True when the daemon process is alive and socket exists. */
    isAlive(): boolean;
    /** Graceful stop: stopCommand → SIGTERM → SIGKILL. Removes socket. Deregisters postmortem. */
    stop(): Promise<void>;
}
/**
 * Probe whether a Unix socket has a live listener (connect + disconnect).
 * Returns true if a connection was accepted, false otherwise.
 */
export declare function probeSocket(socketPath: string, timeoutMs?: number): Promise<boolean>;
/**
 * Poll until a socket file appears on disk, or throw when the deadline passes.
 *
 * @param socketPath - Absolute path to the socket file.
 * @param timeoutMs - Maximum time to wait in milliseconds.
 * @param pollIntervalMs - Interval between checks (default: 500ms).
 */
export declare function waitForSocket(socketPath: string, timeoutMs: number, pollIntervalMs?: number): Promise<void>;
/**
 * Spawn a daemon, wait for socket readiness, register with postmortem, start health checks.
 *
 * The daemon MUST run in foreground mode so `proc.pid` tracks the live process.
 * `--fg-daemon` for Emacs, or equivalent for other daemons.
 */
export declare function startDaemon(config: DaemonConfig): Promise<ManagedDaemon>;
//# sourceMappingURL=managed-daemon.d.ts.map