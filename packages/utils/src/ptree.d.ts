/**
 * Process tree management utilities for Bun subprocesses.
 *
 * - Track managed child processes for cleanup on shutdown (postmortem).
 * - Drain stdout/stderr to avoid subprocess pipe deadlocks.
 * - Cross-platform tree kill for process groups (Windows taskkill, Unix -pid).
 * - Convenience helpers: captureText / execText, AbortSignal, timeouts.
 */
import type { Spawn, Subprocess } from "bun";
type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;
/** A Bun subprocess with stdout/stderr always piped (stdin may vary). */
type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;
/**
 * Base for all exceptions representing child process nonzero exit, killed, or
 * cancellation.
 */
export declare abstract class Exception extends Error {
    readonly exitCode: number;
    readonly stderr: string;
    constructor(message: string, exitCode: number, stderr: string);
    abstract readonly aborted: boolean;
}
/** Exception for nonzero exit codes (not cancellation). */
export declare class NonZeroExitError extends Exception {
    static readonly MAX_TRACE: number;
    constructor(exitCode: number, stderr: string);
    get aborted(): boolean;
}
/** Exception for explicit process abortion (via signal). */
export declare class AbortError extends Exception {
    readonly reason: unknown;
    constructor(reason: unknown, stderr: string);
    get aborted(): boolean;
}
/** Exception for process timeout. */
export declare class TimeoutError extends AbortError {
    constructor(timeout: number, stderr: string);
}
/** Options for waiting for process exit and capturing output. */
export interface WaitOptions {
    allowNonZero?: boolean;
    allowAbort?: boolean;
    stderr?: "full" | "buffer";
}
/** Result from wait and exec. */
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    ok: boolean;
    exitError?: Exception;
}
/**
 * ChildProcess wraps a managed subprocess, capturing stderr tail, providing
 * cross-platform kill/detach logic plus AbortSignal integration.
 *
 * Stdout is exposed directly from the underlying Bun subprocess; consumers
 * must read it (via text(), wait(), etc.) to prevent pipe deadlock.
 * Stderr is eagerly drained into an internal buffer.
 */
export declare class ChildProcess<In extends InMask = InMask> {
    #private;
    readonly proc: PipedSubprocess<In>;
    readonly exposeStderr: boolean;
    constructor(proc: PipedSubprocess<In>, exposeStderr: boolean);
    get pid(): number;
    get exited(): Promise<number>;
    get exitCode(): number | null;
    get exitReason(): Exception | undefined;
    get killed(): boolean;
    get stdin(): Bun.SpawnOptions.WritableToIO<In>;
    /** Raw stdout stream. Must be consumed to prevent pipe deadlock. */
    get stdout(): ReadableStream<Uint8Array<ArrayBuffer>>;
    /** Optional stderr stream (only when requested in spawn options). */
    get stderr(): ReadableStream<Uint8Array<ArrayBufferLike>> | undefined;
    get exitedCleanly(): Promise<number>;
    /** Returns the truncated stderr tail (last 32KB). */
    peekStderr(): string;
    nothrow(): this;
    kill(reason?: Exception): void;
    text(): Promise<string>;
    blob(): Promise<Blob>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    bytes(): Promise<Uint8Array>;
    wait(opts?: WaitOptions): Promise<ExecResult>;
    attachSignal(signal: AbortSignal): void;
    attachTimeout(ms: number): void;
    [Symbol.dispose](): void;
}
/** Options for child spawn. Always pipes stdout/stderr. */
type ChildSpawnOptions<In extends InMask = InMask> = Omit<Spawn.SpawnOptions<In, "pipe", "pipe">, "stdout" | "stderr" | "detached"> & {
    signal?: AbortSignal;
    detached?: boolean;
    stderr?: "full" | null;
};
/** Spawn a child process with piped stdout/stderr. */
export declare function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In>;
/** Options for exec. */
export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
    input?: string | Buffer | Uint8Array;
}
/** Spawn, wait, and return captured output. */
export declare function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
type SignalValue = AbortSignal | number | null | undefined;
/** Combine AbortSignals and timeout values into a single signal. */
export declare function combineSignals(...signals: SignalValue[]): AbortSignal | undefined;
export {};
//# sourceMappingURL=ptree.d.ts.map