/**
 * Native shell execution via brush-core.
 */
import { native } from "../native";
export const { Shell } = native;
/**
 * Execute a shell command using brush-core.
 *
 * @param options - Execution options including command, cwd, env, timeout
 * @param onChunk - Optional callback for streaming output chunks
 * @returns Promise resolving to execution result with exit code and status
 */
export async function executeShell(options, onChunk) {
    const wrappedCallback = onChunk ? (err, chunk) => !err && onChunk(chunk) : undefined;
    return native.executeShell(options, wrappedCallback);
}
//# sourceMappingURL=index.js.map