import { logger } from "@oh-my-pi/pi-utils";
import type { GoalResult } from "../executor/types";
import type { OrgHook } from "../manifest/types";
import type { HookContext, HookExecutor } from "./types";

export class OrgHookExecutor implements HookExecutor {
	async execute(target: OrgHook, result: GoalResult, context: HookContext): Promise<void> {
		try {
			if (result.status === "failure") {
				logger.debug("Org hook would create BUG item", {
					goalName: context.goalName,
					category: target.category,
					error: result.error,
				});
				return;
			}

			logger.debug("Org hook received goal completion", {
				goalName: context.goalName,
				category: target.category,
				summary: result.summary,
			});
		} catch (error) {
			logger.warn("Org hook execution failed", {
				goalName: context.goalName,
				category: target.category,
				error: String(error),
			});
		}
	}
}
