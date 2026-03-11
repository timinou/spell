import type { Component } from "@oh-my-pi/pi-tui";
import { applyBackgroundToLine, padding, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentStatus, OverviewSnapshot, TodoItemSnapshot, TodoPhaseSnapshot } from "./types";

// ─── Color tables ────────────────────────────────────────────────────────────

// ANSI truecolor escape for background and foreground. These are deliberately
// independent of the coding-agent Theme singleton so the niri package stays
// free of that dependency. Colors were chosen to match the intent: we use
// Catppuccin-inspired tones that work in both dark/light contexts.
const STATUS_COLORS: Record<AgentStatus, { bg: string; resetBg: string; fg: string; resetFg: string; label: string }> =
	{
		idle: {
			bg: "\x1b[48;2;166;227;161m", // green-ish bg
			resetBg: "\x1b[49m",
			fg: "\x1b[38;2;30;30;30m",
			resetFg: "\x1b[39m",
			label: "Idle",
		},
		running: {
			bg: "\x1b[48;2;137;180;250m", // blue bg
			resetBg: "\x1b[49m",
			fg: "\x1b[38;2;10;10;10m",
			resetFg: "\x1b[39m",
			label: "Running",
		},
		needs_input: {
			bg: "\x1b[48;2;249;226;175m", // yellow bg
			resetBg: "\x1b[49m",
			fg: "\x1b[38;2;20;20;20m",
			resetFg: "\x1b[39m",
			label: "Needs Input",
		},
		error: {
			bg: "\x1b[48;2;243;139;168m", // red bg
			resetBg: "\x1b[49m",
			fg: "\x1b[38;2;10;10;10m",
			resetFg: "\x1b[39m",
			label: "Error",
		},
	};

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET_BOLD = "\x1b[22m";

// ─── Todo rendering helpers ───────────────────────────────────────────────────

const TODO_ICONS: Record<TodoItemSnapshot["status"], string> = {
	pending: "○",
	in_progress: "→",
	completed: "✓",
	abandoned: "✗",
};

function renderTodoItem(item: TodoItemSnapshot, indent: string): string {
	const icon = TODO_ICONS[item.status];
	const dim = item.status === "completed" || item.status === "abandoned" ? DIM : "";
	const reset = dim ? RESET_BOLD : "";
	return `${indent}${dim}${icon} ${item.content}${reset}`;
}

function renderPhase(phase: TodoPhaseSnapshot): string[] {
	// Determine phase icon from task statuses
	const hasActive = phase.tasks.some(t => t.status === "in_progress");
	const allDone =
		phase.tasks.length > 0 && phase.tasks.every(t => t.status === "completed" || t.status === "abandoned");
	const icon = allDone ? "✓" : hasActive ? "→" : "○";
	const dim = allDone ? DIM : "";
	const reset = dim ? RESET_BOLD : "";
	const lines: string[] = [`${dim}${icon} ${BOLD}${phase.name}${RESET_BOLD}${reset}`];
	for (const task of phase.tasks) {
		lines.push(renderTodoItem(task, "  "));
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
				for (const line of renderPhase(phase)) todoLines.push(line);
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
