import type { Model } from "@spell/pi-ai";
import { validateLoopPrerequisites } from "../../config/loop-prerequisites";
import type { LoopRole } from "../contracts";

export interface LoopRoleResolver {
	getCurrentModel(): Model | undefined;
	getPlanModel(): Model | undefined;
	getReviewModel(): Model | undefined;
	getSettings(): { getModelRole(role: string): string | undefined };
}

export interface LoopSwitchResult {
	role: LoopRole;
	model?: Model;
}

export class LlmSwitcher {
	resolve(role: LoopRole, resolver: LoopRoleResolver): LoopSwitchResult {
		if (role === "review") {
			const prerequisites = validateLoopPrerequisites(resolver.getSettings());
			if (!prerequisites.ok) {
				throw new Error(prerequisites.message ?? "Review model missing");
			}
			return { role, model: resolver.getReviewModel() };
		}
		if (role === "plan") {
			return { role, model: resolver.getPlanModel() ?? resolver.getCurrentModel() };
		}
		return { role, model: resolver.getCurrentModel() };
	}
}
