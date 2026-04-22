import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Container,
	matchesKey,
	padding,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatCost, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
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

export interface SubagentViewerOptions {
	eventBus: EventBus;
	ui: TUI;
	cwd: string;
	onClose: () => void;
	onRequestRender: () => void;
}

export class SubagentViewerComponent implements Component {
	#eventBus: EventBus;
	#ui: TUI;
	#cwd: string;
	#onClose: () => void;
	#onRequestRender: () => void;

	#agents: AgentProgress[] = [];
	#selectedIndex = 0;
	#chatContainer: Container;
	#eventHandler: SubagentViewerEventHandler;
	#scrollOffset = 0;
	#autoFollow = true;
	#expanded = false;
	#unsubscribers: Array<() => void> = [];

	constructor(options: SubagentViewerOptions) {
		this.#eventBus = options.eventBus;
		this.#ui = options.ui;
		this.#cwd = options.cwd;
		this.#onClose = options.onClose;
		this.#onRequestRender = options.onRequestRender;

		this.#chatContainer = new Container();
		const ctx: SubagentViewerContext = {
			chatContainer: this.#chatContainer,
			ui: this.#ui,
			toolOutputExpanded: this.#expanded,
			cwd: this.#cwd,
		};
		this.#eventHandler = new SubagentViewerEventHandler(ctx);

		this.#subscribe();
	}

	#subscribe(): void {
		// Subscribe to progress updates to discover agents and stats
		const unsubProgress = this.#eventBus.subscribe(TASK_SUBAGENT_PROGRESS_CHANNEL, (raw: unknown) => {
			const payload = raw as SubagentProgressPayload;
			this.#onProgressUpdate(payload);
		});
		this.#unsubscribers.push(unsubProgress);

		// Subscribe to raw agent events for rendering
		const unsubEvents = this.#eventBus.subscribe(TASK_SUBAGENT_EVENT_CHANNEL, (raw: unknown) => {
			const payload = raw as SubagentEventPayload;
			this.#onSubagentEvent(payload);
		});
		this.#unsubscribers.push(unsubEvents);
	}

	#onProgressUpdate(payload: SubagentProgressPayload): void {
		const existing = this.#agents.findIndex(a => a.index === payload.progress.index);
		if (existing >= 0) {
			this.#agents[existing] = payload.progress;
		} else {
			this.#agents.push(payload.progress);
			// Auto-select first agent
			if (this.#agents.length === 1) {
				this.#selectedIndex = 0;
			}
		}
		this.#onRequestRender();
	}

	#onSubagentEvent(payload: SubagentEventPayload): void {
		const selectedAgent = this.#agents[this.#selectedIndex];
		if (!selectedAgent || payload.index !== selectedAgent.index) return;

		this.#eventHandler.handleEvent(payload.event);

		// Auto-follow: scroll to bottom when new content arrives
		if (this.#autoFollow) {
			this.#scrollToBottom();
		}
	}

	#scrollToBottom(): void {
		// Will be clamped in render
		this.#scrollOffset = Number.MAX_SAFE_INTEGER;
	}

	#selectAgent(index: number): void {
		if (this.#agents.length === 0) return;
		this.#selectedIndex = ((index % this.#agents.length) + this.#agents.length) % this.#agents.length;

		// Clear and reset for new agent
		this.#chatContainer.clear();
		this.#eventHandler.clear();
		this.#scrollOffset = 0;
		this.#autoFollow = true;
		this.#onRequestRender();
	}

	handleInput(data: string): void {
		// Close
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#onClose();
			return;
		}

		// Agent switching
		if (matchesKey(data, "tab") || matchesKey(data, "ctrl+tab")) {
			this.#selectAgent(this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#selectAgent(this.#selectedIndex - 1);
			return;
		}

		// Scroll
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

		// Toggle tool output expansion
		if (matchesKey(data, "ctrl+o")) {
			this.#expanded = !this.#expanded;
			this.#eventHandler.setExpanded(this.#expanded);
			this.#onRequestRender();
			return;
		}
	}

	invalidate(): void {
		// Propagate to children
		this.#chatContainer.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = this.#bodyHeight();

		// Render all chat content
		const allLines = this.#chatContainer.render(innerWidth);

		// Clamp scroll offset
		const maxOffset = Math.max(0, allLines.length - bodyHeight);
		if (this.#scrollOffset > maxOffset) {
			this.#scrollOffset = maxOffset;
		}

		// Slice visible window
		const visibleLines = allLines.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight);

		// Check if at bottom for auto-follow tracking
		if (this.#scrollOffset >= maxOffset && maxOffset > 0) {
			this.#autoFollow = true;
		}

		// Build framed output
		const result: string[] = [];
		result.push(this.#renderHeader(innerWidth));
		result.push(this.#frameSeparator(innerWidth));

		if (visibleLines.length === 0 && this.#agents.length === 0) {
			// No agents placeholder
			const placeholder = theme.fg("muted", " No active agents. Dispatch tasks to see their activity here.");
			result.push(this.#frameLine(placeholder, innerWidth));
			for (let i = 1; i < bodyHeight; i++) {
				result.push(this.#frameLine("", innerWidth));
			}
		} else {
			for (const line of visibleLines) {
				result.push(this.#frameLine(line, innerWidth));
			}
			// Pad remaining rows
			for (let i = visibleLines.length; i < bodyHeight; i++) {
				result.push(this.#frameLine("", innerWidth));
			}
		}

		result.push(this.#frameSeparator(innerWidth));
		result.push(this.#renderFooter(innerWidth));
		result.push(this.#frameBottom(innerWidth));

		return result;
	}

	dispose(): void {
		for (const unsub of this.#unsubscribers) {
			unsub();
		}
		this.#unsubscribers = [];
	}

	// -- Rendering helpers --

	#bodyHeight(): number {
		// header(1) + separator(1) + separator(1) + footer(1) + bottom(1) = 5 chrome lines
		return Math.max(3, this.#ui.terminal.rows - 5);
	}

	#renderHeader(innerWidth: number): string {
		const selectedAgent = this.#agents[this.#selectedIndex];
		const titlePart = theme.bold(" Subagent Viewer");

		let agentPart = "";
		if (selectedAgent) {
			const idx = `${this.#selectedIndex + 1}/${this.#agents.length}`;
			const statusColor =
				selectedAgent.status === "running"
					? "success"
					: ["completed", "completed-empty"].includes(selectedAgent.status)
						? "success"
						: ["aborted", "cancelled"].includes(selectedAgent.status)
							? "warning"
							: selectedAgent.status === "pending"
								? "muted"
								: "error";
			const statusBadge = theme.fg(statusColor, selectedAgent.status);
			agentPart = ` ${theme.fg("dim", idx)} ${theme.fg("accent", selectedAgent.id)} (${statusBadge})`;
		}

		const hints = theme.fg("dim", "Tab: next  Esc: close ");
		const leftContent = `${titlePart}${agentPart}`;
		const leftWidth = visibleWidth(leftContent);
		const hintsWidth = visibleWidth(hints);
		const gapWidth = Math.max(1, innerWidth - leftWidth - hintsWidth);

		const headerContent = `${leftContent}${padding(gapWidth)}${hints}`;
		const truncated = truncateToWidth(headerContent, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.topLeft}${truncated}${padding(remaining)}${theme.boxSharp.topRight}`;
	}

	#renderFooter(innerWidth: number): string {
		const selectedAgent = this.#agents[this.#selectedIndex];
		let stats = "";
		if (selectedAgent) {
			const tools = `${selectedAgent.toolCount} tools`;
			const tokens = `${formatNumber(selectedAgent.tokens)} tokens`;
			const duration = formatDuration(selectedAgent.durationMs);
			const cost = selectedAgent.usage?.cost ? `  ${formatCost(selectedAgent.usage.cost)}` : "";
			stats = ` ${tools}  ${tokens}  ${duration}${cost}`;
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
