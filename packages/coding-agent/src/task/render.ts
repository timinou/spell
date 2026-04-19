/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
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
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
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

function formatJsonScalar(value: unknown, _theme: Theme): string {
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

function extractMissingSubmitResultWarning(output: string): { warning?: string; rest: string } {
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

function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
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
	const isolatedLabel = isExplicitIsolated ? "true" : isolationAutoReason ? `[isolated:auto – ${isolationAutoReason}]` : "[isolated]";
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
