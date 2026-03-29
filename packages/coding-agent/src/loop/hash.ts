export function normalizeFindingText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function hashContent(text: string): string {
	const normalized = normalizeFindingText(text);
	return Bun.hash(normalized).toString(16);
}

export function hashTaskContent(text: string | undefined): string {
	return Bun.hash((text ?? "").trim()).toString(16);
}
