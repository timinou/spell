import type { AgentEvent } from "@spell/pi-agent-core";
import {
	type Component,
	Container,
	matchesKey,
	padding,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@spell/pi-tui";
import { formatCost, formatDuration, formatNumber } from "@spell/pi-utils";
import {
	ASYNC_JOB_PROGRESS_CHANNEL,
	type AsyncJobManager,
	type AsyncJobSnapshot,
	type AsyncJobUpdate,
} from "../../../async";
import type { SubagentTracker } from "../../../task/subagent-tracker";
import type { AgentProgress } from "../../../task/types";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../../task/types";
import type { EventBus } from "../../../utils/event-bus";
import { theme } from "../../theme/theme";
import { SubagentViewerEventHandler } from "./event-handler";
import type { SubagentViewerContext } from "./types";

/** Payload shape emitted on TASK_SUBAGENT_EVENT_CHANNEL */
interface SubagentEventPayload {
	index: number;
	agent: string;
	agentSource: string;
	task: string;
	assignment?: string;
	event: AgentEvent;
}

/** Payload shape emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: string;
	task: string;
	assignment?: string;
	progress: AgentProgress;
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentProgress["status"]> = new Set([
	"completed",
	"completed-empty",
	"failed",
	"crashed",
	"timeout",
	"aborted",
	"cancelled",
	"policy-rejected",
	"depth-capped",
	"submit-result-missing",
	"schema-invalid",
	"gate_failed",
	"abandoned",
]);

export type JobRow =
	| { kind: "subagent"; key: string; agent: AgentProgress }
	| { kind: "async"; key: string; job: AsyncJobSnapshot };

export interface SubagentViewerOptions {
	eventBus: EventBus;
	ui: TUI;
	cwd: string;
	onClose: () => void;
	onRequestRender: () => void;
	/** Source of truth for active subagents — used to hydrate on mount. */
	subagentTracker?: SubagentTracker;
	/** Source of truth + cancel handle for async bash/task jobs. */
	asyncJobManager?: AsyncJobManager;
}

export class SubagentViewerComponent implements Component {
	#eventBus: EventBus;
	#ui: TUI;
	#cwd: string;
	#onClose: () => void;
	#onRequestRender: () => void;
	#asyncJobManager: AsyncJobManager | undefined;

	#subagentTracker: SubagentTracker | undefined;
	#agents = new Map<string, AgentProgress>();
	#asyncJobs = new Map<string, AsyncJobSnapshot>();
	#selectedKey: string | undefined;
	#lastSubagentEventKey: string | undefined;
	#chatContainer: Container;
	#eventHandler: SubagentViewerEventHandler;
	#scrollOffset = 0;
	#autoFollow = true;
	#expanded = false;
	#unsubscribers: Array<() => void> = [];
	#flushTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: SubagentViewerOptions) {
		this.#eventBus = options.eventBus;
		this.#ui = options.ui;
		this.#cwd = options.cwd;
		this.#onClose = options.onClose;
		this.#onRequestRender = options.onRequestRender;
		this.#asyncJobManager = options.asyncJobManager;
		this.#subagentTracker = options.subagentTracker;

		this.#chatContainer = new Container();
		const ctx: SubagentViewerContext = {
			chatContainer: this.#chatContainer,
			ui: this.#ui,
			toolOutputExpanded: this.#expanded,
			cwd: this.#cwd,
		};
		this.#eventHandler = new SubagentViewerEventHandler(ctx);

		// Hydrate from canonical sources before subscribing so the panel is never
		// blank when work is already in flight at open time.
		if (options.subagentTracker) {
			for (const agent of options.subagentTracker.getActiveAgents()) {
				this.#agents.set(this.#subagentKey(agent), agent);
			}
		}
		if (this.#asyncJobManager) {
			for (const job of this.#asyncJobManager.getAllJobs()) {
				this.#asyncJobs.set(job.id, {
					id: job.id,
					type: job.type,
					status: job.status,
					label: job.label,
					startTime: job.startTime,
					endTime: job.endTime,
					latestProgress: job.latestProgress ? { ...job.latestProgress } : undefined,
					resultPreview: job.resultText,
					errorPreview: job.errorText,
				});
			}
		}

		const rows = this.#buildRows();
		if (rows.length > 0) {
			this.#selectedKey = rows[0].key;
		}

		this.#subscribe();
		// Production publishes via enqueue(P2). Queued events only fire on
		// `eventBus.drain()`, which only runs at turn_end/agent_end. While the
		// viewer is open the user is watching mid-turn — we flush the queue
		// ourselves so subscribers (this viewer + SubagentTracker) see live
		// updates instead of silence until the next turn boundary.
		this.#flushTimer = setInterval(() => this.#flush(), 250);
		// unref so we don't keep the event loop alive past viewer lifetime in tests.
		const maybeUnref = (this.#flushTimer as unknown as { unref?: () => void }).unref;
		if (typeof maybeUnref === "function") maybeUnref.call(this.#flushTimer);
	}

	#flush(): void {
		// Drain pending bus events (P1–P3) so our own subscribers and the canonical
		// SubagentTracker fire even during mid-turn idle periods.
		void this.#eventBus.drain().catch(() => {});
		// Re-pull canonical sources in case events were missed or arrived before subscription.
		if (this.#subagentTracker) {
			for (const agent of this.#subagentTracker.getActiveAgents()) {
				this.#agents.set(this.#subagentKey(agent), agent);
			}
		}
		if (this.#asyncJobManager) {
			for (const job of this.#asyncJobManager.getAllJobs()) {
				const existing = this.#asyncJobs.get(job.id);
				if (existing && existing.status === job.status && existing.endTime === job.endTime) {
					continue;
				}
				this.#asyncJobs.set(job.id, {
					id: job.id,
					type: job.type,
					status: job.status,
					label: job.label,
					startTime: job.startTime,
					endTime: job.endTime,
					latestProgress: job.latestProgress ? { ...job.latestProgress } : undefined,
					resultPreview: job.resultText,
					errorPreview: job.errorText,
				});
			}
		}
		if (!this.#selectedKey) {
			const rows = this.#buildRows();
			if (rows.length > 0) this.#selectedKey = rows[0].key;
		}
		this.#onRequestRender();
	}

	#subagentKey(agent: AgentProgress): string {
		return `sub:${agent.agent}:${agent.index}`;
	}

	#asyncKey(jobId: string): string {
		return `async:${jobId}`;
	}

	#subscribe(): void {
		const unsubProgress = this.#eventBus.subscribe(TASK_SUBAGENT_PROGRESS_CHANNEL, (raw: unknown) => {
			const payload = raw as SubagentProgressPayload;
			this.#onProgressUpdate(payload);
		});
		this.#unsubscribers.push(unsubProgress);

		const unsubEvents = this.#eventBus.subscribe(TASK_SUBAGENT_EVENT_CHANNEL, (raw: unknown) => {
			const payload = raw as SubagentEventPayload;
			this.#onSubagentEvent(payload);
		});
		this.#unsubscribers.push(unsubEvents);

		const unsubAsync = this.#eventBus.subscribe(ASYNC_JOB_PROGRESS_CHANNEL, (raw: unknown) => {
			const payload = raw as AsyncJobUpdate;
			this.#onAsyncJobUpdate(payload);
		});
		this.#unsubscribers.push(unsubAsync);
	}

	#onProgressUpdate(payload: SubagentProgressPayload): void {
		const key = this.#subagentKey(payload.progress);
		if (TERMINAL_AGENT_STATUSES.has(payload.progress.status)) {
			// Retain a snapshot so the chat history doesn't vanish mid-read; mark terminal.
			this.#agents.set(key, payload.progress);
		} else {
			this.#agents.set(key, payload.progress);
		}
		if (!this.#selectedKey) {
			this.#selectedKey = key;
		}
		this.#onRequestRender();
	}

	#onSubagentEvent(payload: SubagentEventPayload): void {
		const selected = this.#selectedRow();
		if (!selected || selected.kind !== "subagent") return;
		if (selected.agent.index !== payload.index) return;

		this.#eventHandler.handleEvent(payload.event);
		this.#lastSubagentEventKey = selected.key;

		if (this.#autoFollow) {
			this.#scrollToBottom();
		}
	}

	#onAsyncJobUpdate(payload: AsyncJobUpdate): void {
		this.#asyncJobs.set(payload.job.id, payload.job);
		if (!this.#selectedKey) {
			this.#selectedKey = this.#asyncKey(payload.job.id);
		}
		this.#onRequestRender();
	}

	#buildRows(): JobRow[] {
		const rows: JobRow[] = [];
		for (const agent of this.#agents.values()) {
			rows.push({ kind: "subagent", key: this.#subagentKey(agent), agent });
		}
		for (const job of this.#asyncJobs.values()) {
			rows.push({ kind: "async", key: this.#asyncKey(job.id), job });
		}
		rows.sort((left, right) => {
			const leftRunning = this.#rowIsRunning(left) ? 1 : 0;
			const rightRunning = this.#rowIsRunning(right) ? 1 : 0;
			if (leftRunning !== rightRunning) return rightRunning - leftRunning;
			return this.#rowStart(right) - this.#rowStart(left);
		});
		return rows;
	}

	#rowIsRunning(row: JobRow): boolean {
		return row.kind === "subagent"
			? !TERMINAL_AGENT_STATUSES.has(row.agent.status)
			: row.job.status === "running" || row.job.status === "pending";
	}

	#rowStart(row: JobRow): number {
		return row.kind === "subagent" ? Date.now() - row.agent.durationMs : row.job.startTime;
	}

	#selectedRow(): JobRow | undefined {
		const rows = this.#buildRows();
		if (rows.length === 0) return undefined;
		if (!this.#selectedKey) return rows[0];
		return rows.find(row => row.key === this.#selectedKey) ?? rows[0];
	}

	#selectedIndex(): number {
		const rows = this.#buildRows();
		if (rows.length === 0) return 0;
		const idx = rows.findIndex(row => row.key === this.#selectedKey);
		return idx === -1 ? 0 : idx;
	}

	#selectByOffset(offset: number): void {
		const rows = this.#buildRows();
		if (rows.length === 0) return;
		const current = this.#selectedIndex();
		const nextIdx = ((current + offset) % rows.length + rows.length) % rows.length;
		const next = rows[nextIdx];
		if (next.key === this.#selectedKey) return;
		this.#selectedKey = next.key;
		this.#chatContainer.clear();
		this.#eventHandler.clear();
		this.#lastSubagentEventKey = undefined;
		this.#scrollOffset = 0;
		this.#autoFollow = true;
		this.#onRequestRender();
	}

	#scrollToBottom(): void {
		this.#scrollOffset = Number.MAX_SAFE_INTEGER;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#onClose();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "ctrl+tab")) {
			this.#selectByOffset(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#selectByOffset(-1);
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
			this.#autoFollow = false;
			this.#onRequestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.#scrollOffset++;
			this.#onRequestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			const pageSize = Math.max(1, this.#bodyHeight());
			this.#scrollOffset = Math.max(0, this.#scrollOffset - pageSize);
			this.#autoFollow = false;
			this.#onRequestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const pageSize = Math.max(1, this.#bodyHeight());
			this.#scrollOffset += pageSize;
			this.#onRequestRender();
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.#scrollOffset = 0;
			this.#autoFollow = false;
			this.#onRequestRender();
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.#scrollToBottom();
			this.#autoFollow = true;
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "ctrl+o")) {
			this.#expanded = !this.#expanded;
			this.#eventHandler.setExpanded(this.#expanded);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "c")) {
			this.#cancelSelectedAsync();
			return;
		}
	}

	#cancelSelectedAsync(): void {
		const row = this.#selectedRow();
		if (!row || row.kind !== "async") return;
		if (row.job.status !== "running" && row.job.status !== "pending") return;
		this.#asyncJobManager?.cancel(row.job.id);
		this.#onRequestRender();
	}

	invalidate(): void {
		this.#chatContainer.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = this.#bodyHeight();
		const rows = this.#buildRows();
		const selected = this.#selectedRow();

		const bodyLines = this.#renderSelectedBody(innerWidth, selected);
		const maxOffset = Math.max(0, bodyLines.length - bodyHeight);
		if (this.#scrollOffset > maxOffset) {
			this.#scrollOffset = maxOffset;
		}
		const visibleLines = bodyLines.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight);
		if (this.#scrollOffset >= maxOffset && maxOffset > 0) {
			this.#autoFollow = true;
		}

		const out: string[] = [];
		out.push(this.#renderHeader(innerWidth, rows, selected));
		out.push(this.#frameSeparator(innerWidth));

		if (rows.length === 0) {
			const placeholder = theme.fg(
				"muted",
				" No jobs or agents. Dispatch a task or run `bash { async: true }` to populate this view.",
			);
			out.push(this.#frameLine(placeholder, innerWidth));
			for (let i = 1; i < bodyHeight; i++) out.push(this.#frameLine("", innerWidth));
		} else {
			for (const line of visibleLines) out.push(this.#frameLine(line, innerWidth));
			for (let i = visibleLines.length; i < bodyHeight; i++) out.push(this.#frameLine("", innerWidth));
		}

		out.push(this.#frameSeparator(innerWidth));
		out.push(this.#renderFooter(innerWidth, selected));
		out.push(this.#frameBottom(innerWidth));

		return out;
	}

	#renderSelectedBody(innerWidth: number, selected: JobRow | undefined): string[] {
		if (!selected) return [];
		if (selected.kind === "subagent") {
			return this.#chatContainer.render(innerWidth);
		}
		return this.#renderAsyncJobBody(innerWidth, selected.job);
	}

	#renderAsyncJobBody(innerWidth: number, job: AsyncJobSnapshot): string[] {
		const lines: string[] = [];
		const label = theme.bold(job.label);
		lines.push(truncateToWidth(` ${label}`, innerWidth));
		const started = new Date(job.startTime).toISOString();
		const duration = formatDuration(Math.max(0, (job.endTime ?? Date.now()) - job.startTime));
		lines.push(
			truncateToWidth(
				theme.fg("dim", ` type: ${job.type}   started: ${started}   duration: ${duration}`),
				innerWidth,
			),
		);
		lines.push("");

		const latest = job.latestProgress;
		if (latest) {
			lines.push(theme.fg("accent", " Latest progress:"));
			for (const segment of this.#wrap(latest.text, innerWidth - 2)) {
				lines.push(`  ${segment}`);
			}
			if (latest.details && Object.keys(latest.details).length > 0) {
				const rendered = JSON.stringify(latest.details, null, 2);
				lines.push("");
				lines.push(theme.fg("dim", " details:"));
				for (const line of rendered.split("\n")) {
					lines.push(`  ${truncateToWidth(line, innerWidth - 2)}`);
				}
			}
			lines.push("");
		}

		if (job.resultPreview) {
			lines.push(theme.fg("success", " Result:"));
			for (const segment of this.#wrap(job.resultPreview, innerWidth - 2)) {
				lines.push(`  ${segment}`);
			}
			lines.push("");
		}
		if (job.errorPreview) {
			lines.push(theme.fg("error", " Error:"));
			for (const segment of this.#wrap(job.errorPreview, innerWidth - 2)) {
				lines.push(`  ${segment}`);
			}
			lines.push("");
		}

		if (job.status === "running" || job.status === "pending") {
			lines.push(theme.fg("dim", " Press `c` to cancel this job."));
		}

		return lines;
	}

	#wrap(text: string, width: number): string[] {
		if (width <= 1) return [text];
		const out: string[] = [];
		for (const rawLine of text.split("\n")) {
			if (rawLine.length === 0) {
				out.push("");
				continue;
			}
			let remaining = rawLine;
			while (visibleWidth(remaining) > width) {
				out.push(truncateToWidth(remaining, width));
				remaining = remaining.slice(width);
			}
			out.push(remaining);
		}
		return out;
	}

	dispose(): void {
		for (const unsub of this.#unsubscribers) unsub();
		this.#unsubscribers = [];
		if (this.#flushTimer) {
			clearInterval(this.#flushTimer);
			this.#flushTimer = undefined;
		}
	}

	// -- Rendering helpers --

	#bodyHeight(): number {
		return Math.max(3, this.#ui.terminal.rows - 5);
	}

	#renderHeader(innerWidth: number, rows: JobRow[], selected: JobRow | undefined): string {
		const titlePart = theme.bold(" Jobs & Agents");
		const subagentCount = rows.filter(row => row.kind === "subagent").length;
		const asyncCount = rows.filter(row => row.kind === "async").length;
		const counts = theme.fg("dim", ` ${subagentCount} agent${subagentCount === 1 ? "" : "s"}  ${asyncCount} job${asyncCount === 1 ? "" : "s"}`);

		let selectionPart = "";
		if (selected) {
			const idx = `${this.#selectedIndex() + 1}/${rows.length}`;
			const status = this.#statusLabel(selected);
			const id = selected.kind === "subagent" ? selected.agent.id : selected.job.id;
			const kindBadge = selected.kind === "subagent" ? "sub" : selected.job.type;
			selectionPart = ` ${theme.fg("dim", idx)} ${theme.fg("accent", `[${kindBadge}] ${id}`)} (${status})`;
		}

		const leftContent = `${titlePart}${counts}${selectionPart}`;
		const hints = theme.fg("dim", "Tab: next  c: cancel  Esc: close ");
		const leftWidth = visibleWidth(leftContent);
		const hintsWidth = visibleWidth(hints);
		const gapWidth = Math.max(1, innerWidth - leftWidth - hintsWidth);
		const headerContent = `${leftContent}${padding(gapWidth)}${hints}`;
		const truncated = truncateToWidth(headerContent, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.topLeft}${truncated}${padding(remaining)}${theme.boxSharp.topRight}`;
	}

	#statusLabel(row: JobRow): string {
		if (row.kind === "subagent") {
			const status = row.agent.status;
			const color =
				status === "running"
					? "success"
					: status === "completed" || status === "completed-empty"
						? "success"
						: status === "aborted" || status === "cancelled"
							? "warning"
							: status === "pending"
								? "muted"
								: "error";
			return theme.fg(color, status);
		}
		const status = row.job.status;
		const color =
			status === "running"
				? "success"
				: status === "completed" || status === "completed-empty"
					? "success"
					: status === "aborted" || status === "cancelled"
						? "warning"
						: status === "pending"
							? "muted"
							: "error";
		return theme.fg(color, status);
	}

	#renderFooter(innerWidth: number, selected: JobRow | undefined): string {
		let stats = "";
		if (selected?.kind === "subagent") {
			const agent = selected.agent;
			const tools = `${agent.toolCount} tools`;
			const tokens = `${formatNumber(agent.tokens)} tokens`;
			const duration = formatDuration(agent.durationMs);
			const cost = agent.usage?.cost ? `  ${formatCost(agent.usage.cost)}` : "";
			// PLAN-327: show open asks for this agent (awaiting orchestrator answer).
			const pendingAsks = this.#subagentTracker?.getPendingAsksForTask(agent.id) ?? [];
			const askPart = pendingAsks.length > 0 ? `  ⏸ ${pendingAsks.length} ask${pendingAsks.length === 1 ? "" : "s"}?` : "";
			stats = ` ${tools}  ${tokens}  ${duration}${cost}${askPart}`;
		} else if (selected?.kind === "async") {
			const job = selected.job;
			const duration = formatDuration(Math.max(0, (job.endTime ?? Date.now()) - job.startTime));
			stats = ` ${job.type} job  ${duration}`;
		}

		const scrollInfo = this.#autoFollow
			? theme.fg("success", "follow")
			: theme.fg("muted", `line ${this.#scrollOffset + 1}`);
		const expandInfo = this.#expanded ? theme.fg("accent", "expanded") : "";
		const rightParts = [scrollInfo, expandInfo].filter(Boolean).join("  ");
		const rightContent = ` ${rightParts} `;
		const statsWidth = visibleWidth(stats);
		const rightWidth = visibleWidth(rightContent);
		const gapWidth = Math.max(1, innerWidth - statsWidth - rightWidth);
		const footerContent = `${stats}${padding(gapWidth)}${rightContent}`;
		return this.#frameLine(footerContent, innerWidth);
	}

	#frameSeparator(innerWidth: number): string {
		return `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.teeLeft}`;
	}

	#frameBottom(innerWidth: number): string {
		return `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.bottomRight}`;
	}

	#frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.vertical}${truncated}${padding(remaining)}${theme.boxSharp.vertical}`;
	}
}
