import type { RpcSpawnOptions } from "@oh-my-pi/telegram-bridge";
import type { BaseSpawnOptions, SessionLifecycle } from "./types";

export class TelegramLifecycle implements SessionLifecycle<string> {
	#idleTimeoutMs: number;

	constructor(idleTimeoutMs: number = 300_000) {
		this.#idleTimeoutMs = idleTimeoutMs;
	}

	buildSpawnOptions(_chatId: string, base: BaseSpawnOptions): RpcSpawnOptions {
		return {
			cwd: base.cwd,
			tools: [...base.tools],
			appendSystemPrompt: base.appendSystemPrompt,
			sessionDir: base.sessionDir,
			sandboxPolicyPath: base.sandboxPolicyPath,
		};
	}

	getIdleTimeout(_chatId: string): number {
		return this.#idleTimeoutMs;
	}
}
