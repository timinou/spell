import type { SandboxPolicy } from "./types";

/**
 * Checks whether a bash command is permitted by the sandbox policy.
 * Returns null if allowed, or an error message string if blocked.
 *
 * Rules:
 * - If no policy or both bashAllow/bashDeny empty: allow all
 * - bashDeny takes precedence over bashAllow
 * - bashAllow patterns use glob matching (e.g. 'bun test*')
 * - bashDeny patterns use glob matching
 */
export function enforceBashCommand(command: string, policy: SandboxPolicy | undefined): string | null {
	if (!policy) return null;
	const { bashAllow, bashDeny } = policy;
	if (bashAllow.length === 0 && bashDeny.length === 0) return null;

	for (const pattern of bashDeny) {
		if (matchGlob(command, pattern)) {
			return `Sandbox policy denies bash command matching '${pattern}'`;
		}
	}

	if (bashAllow.length > 0) {
		const allowed = bashAllow.some(pattern => matchGlob(command, pattern));
		if (!allowed) {
			return `Sandbox policy blocks bash command. Allowed patterns: ${bashAllow.join(", ")}`;
		}
	}

	return null;
}

function matchGlob(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "u").test(value);
}
