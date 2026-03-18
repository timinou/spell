import type { Subprocess } from "bun";
export interface ShellConfig {
    shell: string;
    args: string[];
    env: Record<string, string>;
    prefix: string | undefined;
}
/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export declare function resolveBasicShell(): string | undefined;
/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export declare function getShellConfig(customShellPath?: string): ShellConfig;
/**
 * Function signature for native process tree killing.
 * Returns the number of processes killed.
 */
export type KillTreeFn = (pid: number, signal: number) => number;
/**
 * Global native kill tree function, injected by pi-natives when loaded.
 * Falls back to platform-specific behavior if not set.
 */
export declare let nativeKillTree: KillTreeFn | undefined;
/**
 * Set the native kill tree function. Called by pi-natives on load.
 */
export declare function setNativeKillTree(fn: KillTreeFn): void;
/**
 * Options for terminating a process and all its descendants.
 */
export interface TerminateOptions {
    /** The process to terminate */
    target: Subprocess | number;
    /** Whether to terminate the process tree (all descendants) */
    group?: boolean;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Abort signal */
    signal?: AbortSignal;
}
/**
 * Check if a process is running.
 */
export declare function isPidRunning(pid: number | Subprocess): boolean;
export declare function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean>;
/**
 * Terminate a process and all its descendants.
 */
export declare function terminate(options: TerminateOptions): Promise<boolean>;
//# sourceMappingURL=procmgr.d.ts.map