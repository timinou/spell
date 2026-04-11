/**
 * Format a token count for human display.
 * - < 1000: exact number (e.g. "132")
 * - 1000-999999: K suffix with one decimal if needed (e.g. "45K", "1.3K")
 * - >= 1000000: M suffix with one decimal (e.g. "1.3M", "13.7M")
 *
 * Negative values are treated as 0.
 */
export function formatTokenCount(n: number): string {
	const v = Math.max(0, n);
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) {
		const k = v / 1000;
		const rounded = Math.round(k * 10) / 10;
		return `${rounded}K`;
	}
	const m = v / 1_000_000;
	const rounded = Math.round(m * 10) / 10;
	return `${rounded}M`;
}

export interface ExitTokenInfo {
	input: number;
	output: number;
	thinking: number;
	cacheRead: number;
	cost: number;
	memoryTokens?: number;
}

/**
 * Format a one-line exit summary of session token usage.
 * Only includes non-zero categories.
 * Example: "Session: 45K in | 12K out | 8K think | 120K cache | $0.42"
 */
export function formatExitTokenSummary(info: ExitTokenInfo): string {
	const parts: string[] = [];

	if (info.memoryTokens && info.memoryTokens > 0) {
		parts.push(`mem: ${formatTokenCount(info.memoryTokens)}`);
	}
	if (info.input > 0) parts.push(`${formatTokenCount(info.input)} in`);
	if (info.output > 0) parts.push(`${formatTokenCount(info.output)} out`);
	if (info.thinking > 0) parts.push(`${formatTokenCount(info.thinking)} think`);
	if (info.cacheRead > 0) parts.push(`${formatTokenCount(info.cacheRead)} cache`);
	if (info.cost > 0) parts.push(`$${info.cost.toFixed(2)}`);

	if (parts.length === 0) return "Session: no tokens recorded";
	return `Session: ${parts.join(" | ")}`;
}

export interface SubtaskExitInfo {
	totalLaunched: number;
	totalTokens: number;
	totalCost: number;
	avgTokensPerSubtask: number;
	cacheHitRate: number;
}

export function formatSubtaskExitSummary(info: SubtaskExitInfo): string | null {
	if (info.totalLaunched === 0) return null;

	const parts: string[] = [`${info.totalLaunched} launched`];
	if (info.totalTokens > 0) parts.push(`${formatTokenCount(info.totalTokens)} tokens`);
	if (info.totalCost > 0) parts.push(`$${info.totalCost.toFixed(2)}`);
	if (info.avgTokensPerSubtask > 0) parts.push(`${formatTokenCount(info.avgTokensPerSubtask)} avg/task`);
	if (info.cacheHitRate > 0) parts.push(`${Math.round(info.cacheHitRate * 100)}% cache`);
	return `Subtasks: ${parts.join(" | ")}`;
}
