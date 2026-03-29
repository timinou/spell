/**
 * Native shell execution via brush-core.
 */
import type { ShellExecuteOptions, ShellExecuteResult } from "./types";
export type { ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions, ShellRunResult } from "./types";
export declare const Shell: import("./types").ShellConstructor;
export type Shell = import("./types").Shell;
/**
 * Execute a shell command using brush-core.
 *
 * @param options - Execution options including command, cwd, env, timeout
 * @param onChunk - Optional callback for streaming output chunks
 * @returns Promise resolving to execution result with exit code and status
 */
export declare function executeShell(options: ShellExecuteOptions, onChunk?: (chunk: string) => void): Promise<ShellExecuteResult>;
//# sourceMappingURL=index.d.ts.map