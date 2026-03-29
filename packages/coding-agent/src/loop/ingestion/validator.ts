import type { ParsedSpecFile } from "./parser";

export interface SpecValidationIssue {
	path: string;
	severity: "error" | "warning";
	message: string;
}

export function validateParsedSpecs(parsed: ParsedSpecFile[]): SpecValidationIssue[] {
	const issues: SpecValidationIssue[] = [];
	const seen = new Map<string, string>();
	const knownIds = new Set(parsed.flatMap(file => file.customIds));
	for (const file of parsed) {
		if (file.customIds.length === 0) {
			issues.push({ path: file.path, severity: "error", message: "Missing CUSTOM_ID" });
		}
		for (const customId of file.customIds) {
			const existing = seen.get(customId);
			if (existing) {
				issues.push({ path: file.path, severity: "error", message: `Duplicate CUSTOM_ID: ${customId}` });
				issues.push({ path: existing, severity: "error", message: `Duplicate CUSTOM_ID: ${customId}` });
			}
			seen.set(customId, file.path);
		}
		for (const link of file.links) {
			if (!knownIds.has(link)) {
				issues.push({ path: file.path, severity: "error", message: `Broken [[id:]] link: ${link}` });
			}
		}
	}
	return issues;
}
