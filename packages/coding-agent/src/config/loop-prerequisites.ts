import type { Settings } from "./settings";

export interface LoopPrerequisiteResult {
	ok: boolean;
	missing: string[];
	message?: string;
}

export function validateLoopPrerequisites(settings: Pick<Settings, "getModelRole">): LoopPrerequisiteResult {
	const missing: string[] = [];
	if (!settings.getModelRole("review")?.trim()) {
		missing.push("modelRoles.review");
	}
	if (missing.length === 0) {
		return { ok: true, missing };
	}
	return {
		ok: false,
		missing,
		message: `Loop workflows require the following settings before start: ${missing.join(", ")}`,
	};
}
