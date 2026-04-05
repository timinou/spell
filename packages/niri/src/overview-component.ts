import { STATUS_COLOR_PALETTE } from "@oh-my-pi/pi-desktop-common";
import type { Component } from "@oh-my-pi/pi-tui";
import { applyBackgroundToLine, padding, sliceByColumn, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentStatus, OverviewSnapshot, TodoItemSnapshot, TodoPhaseSnapshot } from "./types";

// ─── Color tables ────────────────────────────────────────────────────────────

// Convert STATUS_COLOR_PALETTE hex entries to ANSI truecolor escape codes.
// Keeps this package free of any theme singleton while staying in sync with
// the canonical palette defined in desktop-common.
function hexToAnsiRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `${r};${g};${b}`;
}

export const STATUS_COLORS: Record<
	AgentStatus,
	{ bg: string; resetBg: string; fg: string; resetFg: string; label: string }
> = Object.fromEntries(
	Object.entries(STATUS_COLOR_PALETTE).map(([key, entry]) => [
		key,
		{
			bg: `\x1b[48;2;${hexToAnsiRgb(entry.bg)}m`,
			resetBg: "\x1b[49m",
			fg: `\x1b[38;2;${hexToAnsiRgb(entry.fg)}m`,
			resetFg: "\x1b[39m",
			label: entry.label,
		},
	]),
) as Record<AgentStatus, { bg: string; resetBg: string; fg: string; resetFg: string; label: string }>;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET_BOLD = "\x1b[22m";
const YELLOW_FG = "\x1b[38;2;249;226;175m";
const RESET_FG = "\x1b[39m";

// ─── Todo rendering helpers ───────────────────────────────────────────────────

const TODO_ICONS: Record<TodoItemSnapshot["status"], string> = {
	pending: "○",
	in_progress: "→",
	completed: "✓",
	abandoned: "✗",
	failed: "!",
	gate_failed: "!",
};

function renderTodoItem(item: TodoItemSnapshot, indent: string, maxWidth?: number): string[] {
	const isDone = item.status === "completed" || item.status === "abandoned";
	const icon = item.blocked ? "\u2298" : TODO_ICONS[item.status];
	const dim = isDone ? DIM : "";
	const reset = dim ? RESET_BOLD : "";

	let suffix = "";

	if (item.blocked && item.blockerLabels && item.blockerLabels.length > 0) {
		const first = item.blockerLabels[0];
		const overflow = item.blockerLabels.length > 1 ? ` +${item.blockerLabels.length - 1}` : "";
		suffix += ` ${DIM}\u2190 ${first}${overflow}${RESET_BOLD}`;
	}

	const badges: string[] = [];
	if (item.gateBadges) {
		for (const badge of item.gateBadges) badges.push(`[${badge}]`);
	}
	if (item.orgItemId) badges.push("[org]");
	if (badges.length > 0) {
		suffix += ` ${DIM}${badges.join(" ")}${RESET_BOLD}`;
	}

	const iconStr = item.blocked ? `${YELLOW_FG}${icon}${RESET_FG}` : icon;
	let line = `${indent}${dim}${iconStr} ${item.content}${suffix}${reset}`;
	if (maxWidth !== undefined && visibleWidth(line) > maxWidth) {
		line = sliceByColumn(line, 0, maxWidth);
	}

	const lines: string[] = [line];
	for (const phase of item.childPhases ?? []) {
		lines.push(...renderPhase(phase, maxWidth, `${indent}  `));
	}
	return lines;
}

function renderPhase(phase: TodoPhaseSnapshot, maxWidth?: number, indent = ""): string[] {
	const totalTasks =
		phase.tasks.length +
		phase.doneCount -
		phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const isPhantom = phase.tasks.length === 0 && phase.doneCount > 0;

	const hasActive = phase.tasks.some(task => task.status === "in_progress");
	const allDone =
		isPhantom ||
		(phase.tasks.length > 0 && phase.tasks.every(task => task.status === "completed" || task.status === "abandoned"));
	const icon = allDone ? "\u2713" : hasActive ? "\u2192" : "\u25CB";
	const dim = allDone ? DIM : "";
	const reset = dim ? RESET_BOLD : "";

	let progress = "";
	if (isPhantom) {
		progress = ` (${phase.doneCount} completed)`;
	} else if (totalTasks > 0) {
		progress = ` (${phase.doneCount}/${totalTasks})`;
	}

	let header = `${indent}${dim}${icon} ${BOLD}${phase.name}${progress}${RESET_BOLD}${reset}`;
	if (maxWidth !== undefined && visibleWidth(header) > maxWidth) {
		header = sliceByColumn(header, 0, maxWidth);
	}
	const lines: string[] = [header];
	for (const task of phase.tasks) {
		lines.push(...renderTodoItem(task, `${indent}  `, maxWidth));
	}
	return lines;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Full-screen overview overlay component.
 * Renders project name, session title, message count, and todo list.
 * Background and accent colors reflect the current agent status.
 */
export class OverviewComponent implements Component {
	#snapshot: OverviewSnapshot;
	#cachedWidth = -1;
	#cachedRows = -1;
	#cachedLines: string[] = [];

	constructor(snapshot: OverviewSnapshot) {
		this.#snapshot = snapshot;
	}

	/** Replace the current data snapshot and signal that re-render is needed. */
	update(snapshot: OverviewSnapshot): void {
		this.#snapshot = snapshot;
		this.invalidate();
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedRows = -1;
		this.#cachedLines = [];
	}

	render(width: number): string[] {
		const rows = process.stdout.rows ?? 24;
		if (this.#cachedWidth === width && this.#cachedRows === rows && this.#cachedLines.length > 0) {
			return this.#cachedLines;
		}
		this.#cachedWidth = width;
		this.#cachedRows = rows;
		this.#cachedLines = this.#buildLines(width, rows);
		return this.#cachedLines;
	}

	#buildLines(width: number, rows: number): string[] {
		const snap = this.#snapshot;
		const colors = STATUS_COLORS[snap.agentStatus];
		const bgFn = (text: string) => `${colors.bg}${text}${colors.resetBg}`;

		// ── Helpers ─────────────────────────────────────────────────────────
		const emptyLine = applyBackgroundToLine(padding(width), width, bgFn);

		const centeredLine = (text: string): string => {
			const visLen = visibleWidth(text);
			const leftPad = Math.max(0, Math.floor((width - visLen) / 2));
			const rightPad = Math.max(0, width - leftPad - visLen);
			const raw = `${colors.fg}${padding(leftPad)}${text}${padding(rightPad)}${colors.resetFg}`;
			return applyBackgroundToLine(raw, width, bgFn);
		};

		const rawLine = (text: string): string =>
			applyBackgroundToLine(`${colors.fg}${text}${colors.resetFg}`, width, bgFn);

		// ── Layout tier based on available rows ─────────────────────────────
		//
		// Tier A (>=20): spacer=2, session title, message count, todos
		// Tier B (>=14): spacer=1, session title, message count, todos
		// Tier C (>= 9): spacer=0, session title, message count, todos (if they fit)
		// Tier D (>= 6): spacer=0, session title, message count, no todos
		// Tier E (<  6): spacer=0, no session title, no todos — just name + badge
		const spacer = rows >= 20 ? 2 : rows >= 14 ? 1 : 0;
		const showSessionTitle = rows >= 6 && !!snap.sessionTitle;
		const showMessageCount = rows >= 6;
		const showTodos = snap.todoPhases.length > 0 && rows >= 9;

		// ── Build content block ──────────────────────────────────────────────
		const content: string[] = [];

		for (let i = 0; i < spacer; i++) content.push(emptyLine);
		content.push(centeredLine(`${BOLD}${snap.projectName}${RESET_BOLD}`));
		if (spacer > 0) content.push(emptyLine);

		if (showSessionTitle) {
			content.push(centeredLine(snap.sessionTitle));
			if (spacer > 0) content.push(emptyLine);
		}

		content.push(centeredLine(`[ ${colors.label} ]`));

		if (showMessageCount) {
			content.push(emptyLine);
			content.push(centeredLine(`■ ${snap.messageCount} message${snap.messageCount === 1 ? "" : "s"}`));
		}

		if (showTodos) {
			// Build all todo lines first so we know their count before committing.
			const todoLines: string[] = [];
			for (const phase of snap.todoPhases) {
				for (const line of renderPhase(phase, width)) todoLines.push(line);
			}

			// Only include if the block fits in remaining space (leave >=1 row for bottom fill).
			const remainingAfterContent = rows - content.length - 1 /* gap */ - todoLines.length - 1 /* trailing empty */;
			if (remainingAfterContent >= 1) {
				const maxTodoWidth = todoLines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
				const todoLeftPad = Math.max(0, Math.floor((width - maxTodoWidth) / 2));
				content.push(emptyLine);
				for (const line of todoLines) content.push(rawLine(`${padding(todoLeftPad)}${line}`));
				content.push(emptyLine);
			}
		}

		for (let i = 0; i < spacer; i++) content.push(emptyLine);

		// ── Vertical centering ───────────────────────────────────────────────
		//
		// Place the content block in the vertical center of the terminal.
		// If content is taller than the terminal (pathological), emit it as-is.
		const topPad = Math.max(0, Math.floor((rows - content.length) / 2));
		const lines: string[] = [];
		for (let i = 0; i < topPad; i++) lines.push(emptyLine);
		for (const line of content) lines.push(line);
		// Fill the remainder so the background covers the full terminal height.
		while (lines.length < rows) lines.push(emptyLine);

		return lines;
	}
}
