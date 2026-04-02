import type { BridgeCommand, BridgeEvent } from "./protocol";
/** Resolves the path to the compiled bridge binary. */
export declare function bridgeBinaryPath(): string;
/** Returns true if the bridge binary exists and is executable. */
export declare function isBridgeAvailable(binary?: string): boolean;
export type EventListener = (event: BridgeEvent) => void;
export interface QmlProcessOptions {
    /** Extra environment variables merged with process.env for the bridge process. */
    env?: Record<string, string>;
    /** Optional bridge binary override (primarily for tests). */
    binaryPath?: string;
}
/**
 * Manages a single long-lived bridge subprocess.
 * Supports two modes:
 * - stdio: spawns child process, communicates via stdin/stdout (used by QML tool)
 * - socket: connects to a daemon via unix domain socket (used by desktop mode)
 */
export declare class QmlProcess {
    #private;
    constructor(options?: QmlProcessOptions);
    /** Returns the unix socket path for daemon mode. */
    static socketPath(): string;
    /** Spawn or connect to the bridge. */
    ensure(): Promise<"existing" | "new">;
    /** Spawn the bridge as a child process with stdio pipes (legacy mode). */
    spawnStdio(): Promise<void>;
    /** Consume the state event buffered during socket connect. Returns null if none buffered. */
    takeReconnectState(): BridgeEvent | null;
    /** Send a command to the bridge. Caller must have called ensure() first. */
    send(command: BridgeCommand): void;
    addListener(fn: EventListener): () => void;
    /** Wait for a specific event type and window id (resolves on first match). */
    waitFor(predicate: (event: BridgeEvent) => boolean, timeoutMs?: number): Promise<BridgeEvent>;
    /** Gracefully shut down the bridge process (stdio mode) or disconnect (daemon mode). */
    dispose(): Promise<void>;
    /** Send quit command to daemon and disconnect. */
    kill(): Promise<void>;
    /** True if connected via unix domain socket (daemon mode). */
    get isDaemon(): boolean;
    get isRunning(): boolean;
}
//# sourceMappingURL=qml-process.d.ts.map