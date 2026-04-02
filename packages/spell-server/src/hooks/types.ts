import type { GoalResult } from "../executor/types";
import type { HookTarget } from "../manifest/types";

export interface HookExecutor {
	execute(target: HookTarget, result: GoalResult, context: HookContext): Promise<void>;
}

export interface HookContext {
	goalName: string;
	timestamp: Date;
}

export type HookCategory = "onSuccess" | "onFailure" | "onComplete";
