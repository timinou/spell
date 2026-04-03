import { Cron } from "croner";
import type { ActionRegistry } from "../actions/registry";
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

export function validateManifest(manifest: AutonomyManifest, registry?: ActionRegistry): ValidationResult {
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

		if (!goal.prompt && !goal.action) {
			errors.push({ path: `goals.${goalName}`, message: "Goal must define either prompt or action" });
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

		if (goal.action && registry) {
			for (const message of registry.validateAction(goal.action)) {
				errors.push({ path: `goals.${goalName}.action`, message });
			}
			for (const [slotName, slot] of Object.entries(goal.action.promptSlots)) {
				if (slot.kind === "inline" && typeof slot.content !== "string") {
					errors.push({
						path: `goals.${goalName}.action.promptSlots.${slotName}`,
						message: "Inline prompt slots must carry content",
					});
				}
				if (slot.kind === "file" && typeof slot.path !== "string") {
					errors.push({
						path: `goals.${goalName}.action.promptSlots.${slotName}`,
						message: "File prompt slots must carry a file path",
					});
				}
			}
		}
	}

	return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
