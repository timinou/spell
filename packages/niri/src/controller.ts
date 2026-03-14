import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { withLargerFont } from "./font-scaling";
import { NiriEventStream } from "./ipc";
import { queryNiriFocusedWindowId } from "./niri-query";
import { OverviewComponent } from "./overview-component";
import type { AgentStatus, TodoItemSnapshot, TodoPhaseSnapshot } from "./types";

export type { TodoItemSnapshot, TodoPhaseSnapshot };

// ─── Minimal context ──────────────────────────────────────────────────────────

/** Minimal snapshot of a todo task visible to the overview. */
export interface TodoItemView {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

/** Minimal snapshot of a todo phase visible to the overview. */
export interface TodoPhaseView {
	name: string;
	tasks: TodoItemView[];
}

/**
 * Minimal interface that the interactive mode must satisfy to drive the
 * Niri overview controller. Using a narrow interface keeps the niri package
 * free of a hard dependency on @oh-my-pi/pi-coding-agent.
 */
export interface NiriOverviewContext {
	/** TUI instance — used to show/hide the overlay. */
	ui: {
		showOverlay(component: OverviewComponent, options?: object): OverlayHandle;
		requestRender(): void;
	};
	/** Current agent session — used to read streaming/error state. */
	session: {
		isStreaming: boolean;
		/** Messages in the current conversation */
		messages: unknown[];
		state: { error?: string };
	};
	/** True when user input is awaited (main-loop callback). */
	onInputCallback?: unknown;
	/**
	 * True when the agent is mid-stream but paused waiting for user interaction
	 * via a hook UI (ask selector, hook input, etc.). Distinct from onInputCallback:
	 * this can be true while isStreaming is still true.
	 */
	isAwaitingHookInput?: boolean;
	/** True when plan approval is pending. */
	isPendingApproval?: boolean;
	/** Current working directory (for project name). */
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	/** Current todo phases. */
	todoPhases: TodoPhaseView[];
	/** Subscribe to session events; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
}

// ─── Controller ──────────────────────────────────────────────────────────────

const FONT_SCALE_FACTOR = 1.6;
const OVERLAY_OPTIONS = {
	width: "100%" as const,
	maxHeight: "100%" as const,
	anchor: "top-center" as const,
	margin: 0,
};

/**
 * Manages the Niri overview overlay lifecycle:
 * - Connects to the Niri IPC socket and listens for OverviewOpenedOrClosed events.
 * - Shows the overlay component when the overview opens.
 * - Hides the overlay when the overview closes.
 * - Attempts OSC 50 font scaling on open (best-effort).
 * - Updates the overlay snapshot whenever session state changes.
 */
export class NiriOverviewController {
	#context: NiriOverviewContext;
	#stream: NiriEventStream;
	#component: OverviewComponent;
	#overlayHandle: OverlayHandle | null = null;
	#restoreFont: (() => void) | null = null;
	#unsubscribeSession: (() => void) | null = null;
	#destroyed = false;
	#niriWindowId: number | null = null;
	#lastWrittenStatus: AgentStatus | null = null;
	readonly #statusDir = path.join(os.homedir(), ".spell", "status");
	constructor(socketPath: string, context: NiriOverviewContext) {
		this.#context = context;
		this.#component = new OverviewComponent(this.#buildSnapshot());
		this.#stream = new NiriEventStream(socketPath, event => this.#handleNiriEvent(event));

		// Keep overlay content fresh when the agent state changes
		this.#unsubscribeSession = context.subscribe(() => {
			this.#writeStatusIfChanged();
			if (this.#overlayHandle) {
				this.#component.update(this.#buildSnapshot());
				this.#context.ui.requestRender();
			}
		});
		// Discover niri window ID asynchronously so the constructor stays synchronous.
		// Fire-and-forget: failures are silent (niri may not be running in tests).
		void this.#initWindowId();
	}
	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#stream.destroy();
		this.#unsubscribeSession?.();
		this.#overlayHandle?.hide();
		this.#overlayHandle = null;
		this.#restoreFont?.();
		this.#restoreFont = null;
		if (this.#niriWindowId !== null) {
			const filePath = path.join(this.#statusDir, `${this.#niriWindowId}.json`);
			fs.rm(filePath, { force: true }).catch(() => {});
			this.#niriWindowId = null;
		}
	}

	// ── Private ───────────────────────────────────────────────────────────────

	/** One-shot async init: discovers the niri window ID and writes the first status file. */
	async #initWindowId(): Promise<void> {
		try {
			await fs.mkdir(this.#statusDir, { recursive: true });
		} catch {
			// ignore — may already exist
		}
		const id = await queryNiriFocusedWindowId();
		if (id !== null && !this.#destroyed) {
			this.#niriWindowId = id;
			this.#writeStatusIfChanged();
		}
	}

	/** Write status file if status changed since last write. No-op if no window ID. */
	#writeStatusIfChanged(): void {
		if (this.#destroyed || this.#niriWindowId === null) return;
		const status = this.#deriveStatus();
		if (status === this.#lastWrittenStatus) return;
		this.#lastWrittenStatus = status;
		const payload = JSON.stringify({
			status,
			windowId: this.#niriWindowId,
			pid: process.pid,
			updatedAt: Date.now(),
		});
		const filePath = path.join(this.#statusDir, `${this.#niriWindowId}.json`);
		Bun.write(filePath, payload).catch(() => {});
	}

	#handleNiriEvent(event: object): void {
		if ("OverviewOpenedOrClosed" in event) {
			const { is_open } = (event as { OverviewOpenedOrClosed: { is_open: boolean } }).OverviewOpenedOrClosed;
			if (is_open) {
				this.#showOverview();
			} else {
				this.#hideOverview();
			}
		}
	}

	#showOverview(): void {
		if (this.#overlayHandle) return; // Already shown

		logger.debug("NiriOverviewController: overview opened");
		this.#component.update(this.#buildSnapshot());
		this.#overlayHandle = this.#context.ui.showOverlay(this.#component, OVERLAY_OPTIONS);

		// Best-effort font scaling — fire and forget
		withLargerFont(FONT_SCALE_FACTOR)
			.then(restore => {
				this.#restoreFont = restore;
			})
			.catch(err => {
				logger.debug("NiriOverviewController: font scaling failed", { err: String(err) });
			});
	}

	#hideOverview(): void {
		if (!this.#overlayHandle) return;

		logger.debug("NiriOverviewController: overview closed");
		this.#overlayHandle.hide();
		this.#overlayHandle = null;

		this.#restoreFont?.();
		this.#restoreFont = null;
	}

	#buildSnapshot() {
		const ctx = this.#context;
		const cwd = ctx.sessionManager.getCwd();
		const projectName = path.basename(cwd);
		const sessionTitle = ctx.sessionManager.getSessionName() ?? "";
		const messageCount = ctx.session.messages.length;
		const agentStatus = this.#deriveStatus();
		const todoPhases: TodoPhaseSnapshot[] = ctx.todoPhases.map(p => ({
			name: p.name,
			tasks: p.tasks.map(t => ({ content: t.content, status: t.status })),
		}));

		return { projectName, sessionTitle, messageCount, todoPhases, agentStatus };
	}

	#deriveStatus(): AgentStatus {
		const ctx = this.#context;
		if (ctx.session.state.error) return "error";
		// Plan approval takes highest priority after errors: the agent is stopped
		// and waiting for the user to approve/reject the plan.
		if (ctx.isPendingApproval) return "pending_approval";
		// Hook input pauses LLM mid-run for a user question (ask tool, etc.).
		if (ctx.isAwaitingHookInput) return "needs_input";
		// Streaming beats onInputCallback: the session is actively running.
		if (ctx.session.isStreaming) return "running";
		if (ctx.onInputCallback !== undefined) {
			// If every todo is resolved the agent is done, not waiting for new work.
			const allDone =
				ctx.todoPhases.length > 0 &&
				ctx.todoPhases.every(p => p.tasks.every(t => t.status === "completed" || t.status === "abandoned"));
			if (allDone) return "completed";
			return "needs_input";
		}
		return "idle";
	}
}
