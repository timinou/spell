import * as path from "node:path";
import type { SandboxPolicy } from "./types";

/**
 * Checks whether a write to the given path is permitted by the sandbox policy.
 * Returns null if allowed, or an error message string if blocked.
 *
 * When no policy is provided, all writes are allowed (backward compat).
 */
export function enforcePathWrite(targetPath: string, cwd: string, policy: SandboxPolicy | undefined): string | null {
	if (!policy) return null;
	const prefix = policy.writeErrorPrefix ?? "";
	if (policy.pathsWrite.length === 0) {
		return `${prefix}Sandbox policy blocks all file writes`;
	}

	const resolved = path.resolve(cwd, targetPath);
	for (const allowed of policy.pathsWrite) {
		const allowedResolved = path.resolve(cwd, allowed);
		const allowedPrefix = allowedResolved.endsWith(path.sep) ? allowedResolved : `${allowedResolved}${path.sep}`;
		if (resolved === allowedResolved || resolved.startsWith(allowedPrefix)) {
			return null;
		}
	}

	return `${prefix}Sandbox policy blocks writes to '${targetPath}'. Allowed paths: ${policy.pathsWrite.join(", ")}`;
}
