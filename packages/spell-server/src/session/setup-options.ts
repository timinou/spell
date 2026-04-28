import type { FilterConfig, ManifestSetup } from "../manifest/types";
import type { BaseSpawnOptions } from "./types";

/**
 * Translate a `setup` declaration into a `BaseSpawnOptions` payload that
 * `SessionManager.getOrCreate` can hand to a `SessionLifecycle`. Centralizing
 * this so goal execution and web-template execution share one canonical path.
 *
 * Caller is responsible for resolving `cwd`, writing the sandbox policy file
 * (when applicable) and providing the resulting `sandboxPolicyPath`.
 */
export interface SetupSpawnInput {
	cwd: string;
	sandboxPolicyPath?: string;
	appendSystemPrompt?: string;
	env?: Record<string, string>;
}

export function setupToBaseSpawnOptions(setup: ManifestSetup, input: SetupSpawnInput): BaseSpawnOptions {
	return {
		cwd: input.cwd,
		tools: resolveAllowedValues(setup.tools),
		appendSystemPrompt: input.appendSystemPrompt,
		sandboxPolicyPath: input.sandboxPolicyPath,
		...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
	};
}

export function resolveAllowedValues(filter?: FilterConfig): string[] {
	if (!filter?.allow) return [];
	const deny = new Set(filter.deny ?? []);
	return filter.allow.filter(tool => !deny.has(tool));
}
