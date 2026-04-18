import { validateLoopPrerequisites } from "../../config/loop-prerequisites";
import type { Settings } from "../../config/settings";
import type { LoopReadinessResult } from "../types";
import { findMissingGuidelineDomains } from "./ancillary";
import type { ParsedSpecFile } from "./parser";
import { validateParsedSpecs } from "./validator";

export async function evaluateLoopReadiness(
	cwd: string,
	parsed: ParsedSpecFile[],
	settings: Pick<Settings, "getModelRole">,
	domains: string[],
	gateCount: number,
): Promise<LoopReadinessResult> {
	const issues = validateParsedSpecs(parsed);
	const missingGuidelineDomains = await findMissingGuidelineDomains(cwd, domains);
	const prerequisites = validateLoopPrerequisites(settings);
	const required = [
		{
			name: "spec-validation",
			ok: !issues.some(issue => issue.severity === "error"),
			message: issues.map(issue => issue.message).join("; ") || "Spec links valid",
		},
		{ name: "review-model", ok: prerequisites.ok, message: prerequisites.message ?? "Review model configured" },
		{
			name: "domain-guidelines",
			ok: missingGuidelineDomains.length === 0,
			message:
				missingGuidelineDomains.length === 0
					? "Guidelines present"
					: `Missing: ${missingGuidelineDomains.join(", ")}`,
		},
		{
			name: "gates-defined",
			ok: gateCount > 0,
			message: gateCount > 0 ? `${gateCount} gates defined` : "No gates defined",
		},
	];
	const advisory = [
		{
			name: "acceptance-criteria",
			ok: parsed.some(file => file.content.includes("Acceptance Criteria")),
			message: parsed.some(file => file.content.includes("Acceptance Criteria"))
				? "Acceptance criteria present"
				: "Acceptance criteria missing",
		},
		{
			name: "layer-annotations",
			ok: parsed.some(file => file.content.includes("LAYER")),
			message: parsed.some(file => file.content.includes("LAYER"))
				? "Layer annotations present"
				: "Layer annotations missing",
		},
		{
			name: "dependencies",
			ok: parsed.some(file => file.content.includes("DEPENDS") || file.links.length > 0),
			message: parsed.some(file => file.content.includes("DEPENDS") || file.links.length > 0)
				? "Dependencies declared"
				: "Dependencies not declared",
		},
	];
	return {
		ok: required.every(check => check.ok),
		required,
		advisory,
		missingGuidelineDomains,
	};
}
