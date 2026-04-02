import { logger } from "@oh-my-pi/pi-utils";
import type { GoalResult } from "../executor/types";
import type { HookTarget, ManifestHookConfig } from "../manifest/types";
import type { HookContext, HookExecutor } from "./types";

export class HookDispatcher {
	#executors: Map<string, HookExecutor>;

	constructor(executors: Map<string, HookExecutor>) {
		this.#executors = executors;
	}

	async dispatch(goalName: string, result: GoalResult, hooks: ManifestHookConfig | undefined): Promise<void> {
		if (!hooks) {
			return;
		}

		const context: HookContext = { goalName, timestamp: new Date() };

		if (result.status === "success" && hooks.onSuccess) {
			await this.#fireHooks(hooks.onSuccess, result, context);
		}
		if (result.status === "failure" && hooks.onFailure) {
			await this.#fireHooks(hooks.onFailure, result, context);
		}
		if (hooks.onComplete) {
			await this.#fireHooks(hooks.onComplete, result, context);
		}
	}

	async #fireHooks(targets: HookTarget[], result: GoalResult, context: HookContext): Promise<void> {
		for (const target of targets) {
			const executor = this.#executors.get(target.type);
			if (!executor) {
				logger.warn("No executor for hook type", { type: target.type });
				continue;
			}
			try {
				await executor.execute(target, result, context);
			} catch (error) {
				logger.error("Hook execution failed", { type: target.type, error: String(error) });
			}
		}
	}
}
