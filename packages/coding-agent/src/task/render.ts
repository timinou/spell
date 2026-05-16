/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatCost, formatNumber } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatBadge,
	formatDuration,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
	truncateToWidth,
} from "../tools/render-utils";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/review";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine } from "../tui";
import { formatRetryStatus } from "./retry-state";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, SubagentOutcome, TaskParams, TaskToolDetails } from "./types";

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function isSuccessfulOutcome(outcome: SubagentOutcome): boolean {
	return outcome === "completed" || outcome === "completed-empty";
}

function isFailureOutcome(outcome: SubagentOutcome): boolean {
	return !["pending", "running", "completed", "completed-empty", "aborted", "cancelled"].includes(outcome);
}

function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
		case "completed-empty":
			return formatStatusIcon("success", theme);
		case "aborted":
		case "cancelled":
			return formatStatusIcon("aborted", theme);
		default:
			return formatStatusIcon("error", theme);
	}
}

function stringifyStructuredResult(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function formatFindingSummary(findings: ReportFindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function normalizeReportFindings(value: unknown): ReportFindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: ReportFindingDetails[] = [];
	for (const item of value) {
		const finding = parseReportFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

function _formatJsonScalar(value: unknown, _theme: Theme): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const trimmed = truncateToWidth(value, 70);
		return `"${trimmed}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function formatTaskId(id: string): string {
	const segments = id.split(".");
	if (segments.length < 2) return id;

	const parsed = segments.map(segment => segment.match(/^(\d+)-(.+)$/));
	if (parsed.some(match => !match)) return id;

	const indices = parsed.map(match => match![1]).join(".");
	const labels = parsed.map(match => match![2]).join(">");
	return `${indices} ${labels}`;
}

const MISSING_SUBMIT_RESULT_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling submit_result tool";

function _extractMissingSubmitResultWarning(output: string): {
	warning?: string;
	rest: string;
} {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_SUBMIT_RESULT_WARNING_PREFIX)) {
		return { rest: output };
	}
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

function _buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

export function renderCall(args: TaskParams, _options: RenderResultOptions, theme: Theme): Component {
	const lines: string[] = [];
	lines.push(renderStatusLine({ icon: "pending", title: "Task", description: args.agent }, theme));

	const contextTemplate = args.context ?? "";
	const context = contextTemplate.trim();
	const hasContext = context.length > 0;
	const branch = theme.fg("dim", theme.tree.branch);
	const last = theme.fg("dim", theme.tree.last);
	const vertical = theme.fg("dim", theme.tree.vertical);
	const isExplicitIsolated = "isolated" in args && args.isolated === true;
	const isolationAutoReason = (args as { isolationAutoCoercedReason?: string }).isolationAutoCoercedReason;
	const showIsolated = isExplicitIsolated || isolationAutoReason !== undefined;
	const isolatedLabel = isExplicitIsolated
		? "true"
		: isolationAutoReason
			? `[isolated:auto – ${isolationAutoReason}]`
			: "[isolated]";
	const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 0;
	const taskSummary = `${taskCount} agents`;

	if (hasContext) {
		lines.push(` ${branch} ${theme.fg("dim", "Context")}`);
		for (const line of context.split("\n")) {
			const content = line ? theme.fg("muted", replaceTabs(line)) : "";
			lines.push(` ${vertical}  ${content}`);
		}
		const taskPrefix = showIsolated ? branch : last;
		lines.push(` ${taskPrefix} ${theme.fg("dim", "Tasks")}: ${theme.fg("muted", taskSummary)}`);
		if (showIsolated) {
			lines.push(` ${last} ${theme.fg("dim", "Isolated")}: ${theme.fg("muted", isolatedLabel)}`);
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	lines.push(`${theme.fg("dim", "Tasks")}: ${theme.fg("muted", taskSummary)}`);
	if (showIsolated) {
		lines.push(`${theme.fg("dim", "Isolated")}: ${theme.fg("muted", isolatedLabel)}`);
	}

	return new Text(lines.join("\n"), 0, 0);
}

function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = task.trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, maxExpanded)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}
	if (taskLines.length > maxExpanded) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line"))}`);
	}

	return lines;
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(
	progress: AgentProgress,
	isLast: boolean,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor = isSuccessfulOutcome(progress.status)
		? "success"
		: isFailureOutcome(progress.status)
			? "error"
			: progress.status === "aborted" || progress.status === "cancelled"
				? "warning"
				: "accent";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const description = progress.description?.trim();
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;

	// Only show badge for non-running states (spinner already indicates running)
	if (progress.status !== "running" && progress.status !== "pending" && progress.status !== "completed") {
		statusLine += ` ${formatBadge(progress.status, iconColor, theme)}`;
	}

	if (progress.status === "running") {
		if (!description) {
			const taskPreview = truncateToWidth(progress.assignment ?? progress.task, 40);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		if (progress.toolCount > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", `${progress.toolCount} tools`)}`;
		}
		if (progress.tokens > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(progress.tokens)} tokens`)}`;
		}
		if (progress.usage && progress.usage.cost > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", formatCost(progress.usage.cost))}`;
		}
	} else if (isSuccessfulOutcome(progress.status)) {
		if (progress.toolCount > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", `${progress.toolCount} tools`)}`;
		}
		if (progress.tokens > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(progress.tokens)} tokens`)}`;
		}
		if (progress.usage && progress.usage.cost > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", formatCost(progress.usage.cost))}`;
		}
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme));

	// Current tool (if running), retry state, or most recent completed tool

	if (progress.status === "running") {
		if (progress.retry) {
			lines.push(
				`${continuePrefix}${theme.tree.hook} ${theme.fg(
					"warning",
					truncateToWidth(replaceTabs(formatRetryStatus(progress.retry)), 70),
				)}`,
			);
		} else if (progress.currentTool) {
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", progress.currentTool)}`;
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			if (progress.currentToolStartMs) {
				const elapsed = Date.now() - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			// Show most recent completed tool when idle between tools
			const recent = progress.recentTools[0];
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("dim", recent.tool)}`;
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		// For completed tasks, check for review verdict from submit_result tool
		if (isSuccessfulOutcome(progress.status)) {
			const completeData = progress.extractedToolData.submit_result as Array<{ data: unknown }> | undefined;
			const reportFindingData = normalizeReportFindings(progress.extractedToolData.report_finding);
			const reviewData = completeData
				?.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData && reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				const findings = reportFindingData;
				lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
				return lines; // Review result handles its own rendering
			}
		}

		for (const [toolName, dataArray] of Object.entries(progress.extractedToolData)) {
			// Handle report_finding with tree formatting
			if (toolName === "report_finding") {
				const findings = normalizeReportFindings(dataArray);
				if (findings.length === 0) continue;
				lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);
				lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
				continue;
			}

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item"),
						)}`,
					);
				}
			}
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const output = progress.recentOutput.join("\n");
		lines.push(...renderOutputSection(output, continuePrefix, true, theme, 2, 6));
	}

	return lines;
}

function renderFindings(
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const displayCount = expanded ? findings.length : Math.min(findings.length, 3);
	for (const finding of findings.slice(0, displayCount)) {
		const location = `${path.basename(finding.file_path)}:${finding.line_start}`;
		lines.push(
			`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", finding.priority)} ${theme.bold(finding.title)}`,
		);
		lines.push(
			`${continuePrefix}  ${theme.fg("dim", truncateToWidth(`${location} — ${replaceTabs(finding.body)}`, 100))}`,
		);
	}
	if (findings.length > displayCount) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - displayCount, "finding"))}`);
	}
	return lines;
}

function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdict = `${summary.overall_correctness} · confidence ${summary.confidence}`;
	return [
		`${continuePrefix}${theme.tree.hook} ${theme.fg(verdictColor, verdict)}`,
		`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(summary.explanation), 100))}`,
		...renderFindings(findings, continuePrefix, expanded, theme),
	];
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 2,
	maxExpanded = 6,
): string[] {
	if (!output.trim()) return [];
	const outputLines = output.split("\n").filter(Boolean);
	const limit = expanded ? maxExpanded : maxCollapsed;
	const lines = outputLines
		.slice(0, limit)
		.map(line => `${continuePrefix}${theme.fg("dim", truncateToWidth(replaceTabs(line), 100))}`);
	if (outputLines.length > limit) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(outputLines.length - limit, "line"))}`);
	}
	return lines;
}

function renderAgentResult(result: SingleResult, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;
	const status = result.outcome;
	const icon = getStatusIcon(status, theme);
	const color = isSuccessfulOutcome(status)
		? "success"
		: isFailureOutcome(status)
			? "error"
			: status === "aborted" || status === "cancelled"
				? "warning"
				: "accent";
	const description = result.description?.trim();
	const titlePart = description
		? `${theme.bold(formatTaskId(result.id))}: ${description}`
		: theme.bold(formatTaskId(result.id));
	let statusLine = `${prefix} ${theme.fg(color, icon)} ${theme.fg("accent", titlePart)}`;
	if (status !== "pending" && status !== "running" && status !== "completed") {
		statusLine += ` ${formatBadge(status, color, theme)}`;
	}
	if (result.tokens > 0) statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(result.tokens)} tokens`)}`;
	if (result.durationMs > 0) statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;
	if (result.usage?.cost?.total && result.usage.cost.total > 0) {
		statusLine += `${theme.sep.dot}${theme.fg("dim", formatCost(result.usage.cost.total))}`;
	}
	lines.push(statusLine);
	lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme));
	if (result.spawnAudit && (!result.spawnAudit.granted || result.spawnAudit.reason === "depth-capped")) {
		lines.push(
			`${continuePrefix}${theme.fg("warning", `spawn ${result.spawnAudit.requestedAgent} → ${result.spawnAudit.reason ?? "denied"}`)}`,
		);
	}
	if (result.error) {
		lines.push(`${continuePrefix}${theme.fg("error", truncateToWidth(replaceTabs(result.error), 100))}`);
	}
	const structuredText = stringifyStructuredResult(result.structuredResult);
	if (structuredText && structuredText.length < 5000) {
		lines.push(...renderOutputSection(structuredText, continuePrefix, expanded, theme));
	} else if (result.resultUri) {
		lines.push(`${continuePrefix}${theme.fg("dim", result.resultUri)}`);
	}
	if (result.textPreview?.trim()) {
		lines.push(...renderOutputSection(result.textPreview, continuePrefix, expanded, theme));
	}
	if (result.children && result.children.length > 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Children (${result.children.length})`)}`);
		result.children.forEach((child, index) => {
			const childLines = renderAgentResult(child, index === result.children!.length - 1, expanded, theme);
			for (const line of childLines) {
				lines.push(`${continuePrefix}${line}`);
			}
		});
	}
	return lines;
}

function formatEfficiencyLine(
	results: SingleResult[],
	totalDurationMs: number,
	usage: TaskToolDetails["usage"],
	theme: Theme,
	expanded: boolean,
): string | undefined {
	if (!expanded || results.length === 0 || totalDurationMs <= 0) return undefined;
	const totalTokens = results.reduce((sum, result) => sum + result.tokens, 0);
	if (totalTokens === 0 && !(usage?.cost?.total && usage.cost.total > 0)) return undefined;
	const parts = [`${theme.fg("dim", "Efficiency:")} ${theme.fg("dim", `${formatNumber(totalTokens)} tokens`)}`];
	if (usage?.cost?.total && usage.cost.total > 0) parts.push(theme.fg("dim", formatCost(usage.cost.total)));
	parts.push(theme.fg("dim", formatDuration(totalDurationMs)));
	return parts.join(theme.sep.dot);
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: TaskToolDetails;
	},
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncateToWidth(text, 100)), 0, 0);
	}

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, isPartial, spinnerFrame } = options;
			const hasher = new Hasher()
				.bool(expanded)
				.bool(isPartial)
				.u32(spinnerFrame ?? 0)
				.u32(width);
			// Mix in a progress content signature so heartbeat-driven updates and
			// in-place progress mutations actually invalidate the cached lines.
			// Without this, the spinner frame is the only time-varying input the
			// renderer sees, and tool/duration changes are silently dropped until
			// the next #updateDisplay() rebuilds the closure.
			hasher.u32(details.progress?.length ?? 0);
			if (details.progress) {
				for (const p of details.progress) {
					hasher
						.str(p.status)
						.u32(p.toolCount)
						.u32(p.tokens)
						.u32(p.durationMs)
						.u32(p.recentTools.length)
						.optional(p.currentTool ?? null)
						.optional(p.lastIntent ?? null)
						.optional(p.retry ? `r${p.retry.attempt}/${p.retry.maxAttempts}` : null);
				}
			}
			hasher.u32(details.results?.length ?? 0);
			const key = hasher.digest();
			if (cached?.key === key) return cached.lines;

			const lines: string[] = [];

			const shouldRenderProgress =
				Boolean(details.progress && details.progress.length > 0) && (isPartial || details.results.length === 0);
			if (shouldRenderProgress && details.progress) {
				details.progress.forEach((progress, i) => {
					const isLast = i === details.progress!.length - 1;
					lines.push(...renderAgentProgress(progress, isLast, expanded, theme, spinnerFrame));
				});
			} else if (details.results && details.results.length > 0) {
				details.results.forEach((res, i) => {
					const isLast = i === details.results.length - 1;
					lines.push(...renderAgentResult(res, isLast, expanded, theme));
				});

				const abortedCount = details.results.filter(r => r.aborted).length;
				const mergeFailedCount = details.results.filter(r => !r.aborted && r.exitCode === 0 && r.error).length;
				const successCount = details.results.filter(r => !r.aborted && r.exitCode === 0 && !r.error).length;
				const failCount = details.results.length - successCount - mergeFailedCount - abortedCount;
				let summary = `${theme.fg("dim", "Total:")} `;
				if (abortedCount > 0) {
					summary += theme.fg("error", `${abortedCount} aborted`);
					if (successCount > 0 || mergeFailedCount > 0 || failCount > 0) summary += theme.sep.dot;
				}
				if (successCount > 0) {
					summary += theme.fg("success", `${successCount} succeeded`);
					if (mergeFailedCount > 0 || failCount > 0) summary += theme.sep.dot;
				}
				if (mergeFailedCount > 0) {
					summary += theme.fg("warning", `${mergeFailedCount} merge failed`);
					if (failCount > 0) summary += theme.sep.dot;
				}
				if (failCount > 0) {
					summary += theme.fg("error", `${failCount} failed`);
				}
				summary += `${theme.sep.dot}${theme.fg("dim", formatDuration(details.totalDurationMs))}`;
				if (details.usage?.cost?.total && details.usage.cost.total > 0) {
					summary += `${theme.sep.dot}${theme.fg("dim", formatCost(details.usage.cost.total))}`;
				}
				lines.push(summary);
				const efficiencyLine = formatEfficiencyLine(
					details.results,
					details.totalDurationMs,
					details.usage,
					theme,
					expanded,
				);
				if (efficiencyLine) {
					lines.push(efficiencyLine);
				}
			}

			if (lines.length === 0) {
				const text = fallbackText.trim() ? fallbackText : "No results";
				const result = [theme.fg("dim", truncateToWidth(text, width))];
				cached = { key, lines: result };
				return result;
			}

			if (fallbackText.trim()) {
				const summaryLines = fallbackText.split("\n");
				const markerIndex = summaryLines.findIndex(
					line => line.includes("<system-notification>") || line.startsWith("Applied patches:"),
				);
				if (markerIndex >= 0) {
					const extra = summaryLines.slice(markerIndex);
					for (const line of extra) {
						if (!line.trim()) continue;
						lines.push(theme.fg("dim", line));
					}
				}
			}

			const indented = lines.map(line =>
				line.length > 0 ? truncateToWidth(`   ${line}`, width, Ellipsis.Omit) : "",
			);
			cached = { key, lines: indented };
			return indented;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

export const taskToolRenderer = {
	renderCall,
	renderResult,
};
