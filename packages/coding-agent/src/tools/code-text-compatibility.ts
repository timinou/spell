export type CodeTextCompatibilityTool = "edit" | "write";

export function formatCodeTextCompatibilityNotice(tool: CodeTextCompatibilityTool): string {
	return `Compatibility TODO: code-supported text ${tool} used the managed-buffer compatibility path. Keep this visible for later bugfixing; prefer code edit when possible.`;
}
