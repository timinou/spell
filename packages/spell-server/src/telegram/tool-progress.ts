function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function lastNonEmptyLine(text: string): string {
	const lines = text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	return lines.at(-1) ?? "";
}

function extractToolContentText(value: unknown): string {
	if (!Array.isArray(value)) {
		return "";
	}

	return value
		.filter(isRecord)
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text?.trim() ?? "")
		.filter(Boolean)
		.join("\n\n");
}

export function summarizeToolPartialResult(partialResult: unknown): string {
	if (!isRecord(partialResult)) {
		return "";
	}

	const contentText = extractToolContentText(partialResult.content);
	if (contentText) {
		return lastNonEmptyLine(contentText) || contentText.trim();
	}

	const details = isRecord(partialResult.details) ? partialResult.details : undefined;
	const asyncDetails = details && isRecord(details.async) ? details.async : undefined;
	if (typeof asyncDetails?.state === "string" && asyncDetails.state.trim()) {
		return `status: ${asyncDetails.state.trim()}`;
	}

	return "";
}
