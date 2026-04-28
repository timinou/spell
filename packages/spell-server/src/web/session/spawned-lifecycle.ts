import type { RpcSpawnOptions } from "../../rpc";
import type { BaseSpawnOptions, SessionLifecycle } from "../../session/types";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface WebSpawnedLifecycleOptions {
	idleTimeoutMs?: number;
}

/**
 * Lifecycle for a server-spawned web RPC session. Unlike `AutonomyLifecycle`,
 * this does NOT inject the `autonomy_state` tool because web sessions render a
 * clean tool surface and do not need state-store env injection.
 */
export class WebSpawnedLifecycle implements SessionLifecycle<string> {
	#idleTimeoutMs: number;

	constructor(options: WebSpawnedLifecycleOptions = {}) {
		this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	buildSpawnOptions(_key: string, base: BaseSpawnOptions): RpcSpawnOptions {
		return {
			cwd: base.cwd,
			tools: [...base.tools],
			appendSystemPrompt: base.appendSystemPrompt,
			sessionDir: base.sessionDir,
			sandboxPolicyPath: base.sandboxPolicyPath,
			...(base.env && Object.keys(base.env).length > 0 ? { env: base.env } : {}),
		};
	}

	getIdleTimeout(_key: string): number | null {
		return this.#idleTimeoutMs;
	}
}
