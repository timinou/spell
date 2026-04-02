import { Cron } from "croner";
import type { AutonomyManifest, HookTarget } from "./types";

export type ValidationError = {
	path: string;
	message: string;
};

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationError[] };

function validateHookTarget(target: HookTarget, path: string, errors: ValidationError[]): void {
	if (target.type === "webhook") {
		try {
			new URL(target.url);
		} catch {
			errors.push({ path, message: "Webhook URL must be a valid URL" });
		}
	}
}

export function validateManifest(manifest: AutonomyManifest): ValidationResult {
	const errors: ValidationError[] = [];

	if (manifest.name.trim().length === 0) {
		errors.push({ path: "name", message: "Manifest name must be a non-empty string" });
	}
	if (manifest.version.trim().length === 0) {
		errors.push({ path: "version", message: "Manifest version must be a non-empty string" });
	}

	for (const [goalName, goal] of manifest.goals) {
		if (!manifest.setups.has(goal.setup)) {
			errors.push({ path: `goals.${goalName}.setup`, message: `Unknown setup "${goal.setup}"` });
		}

		if (goal.schedule.type === "cron") {
			try {
				new Cron(goal.schedule.expression);
			} catch (error) {
				errors.push({
					path: `goals.${goalName}.schedule.expression`,
					message: error instanceof Error ? error.message : "Invalid cron expression",
				});
			}
		}

		if (goal.hooks) {
			for (const [eventName, targets] of [
				["onSuccess", goal.hooks.onSuccess],
				["onFailure", goal.hooks.onFailure],
				["onComplete", goal.hooks.onComplete],
			] as const) {
				if (!targets) continue;
				targets.forEach((target, index) => {
					validateHookTarget(target, `goals.${goalName}.hooks.${eventName}.${index}`, errors);
				});
			}
		}
	}

	return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
