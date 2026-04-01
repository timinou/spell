import * as path from "node:path";
import type { AgentStatusContext, SnapshotContext, TodoPhaseView } from "@oh-my-pi/pi-desktop-common";
import { buildOverviewSnapshot, deriveAgentStatus, StatusFileWriter } from "@oh-my-pi/pi-desktop-common";
import type { ImageProtocol, OverlayHandle } from "@oh-my-pi/pi-tui";
import { clearImagePlacements, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { withLargerFont } from "./font-scaling";
import { NiriEventStream } from "./ipc";
import { queryNiriFocusedWindowId } from "./niri-query";
import { OverviewComponent, STATUS_COLORS } from "./overview-component";
import type { AgentStatus, TodoItemSnapshot, TodoPhaseSnapshot } from "./types";

export type { TodoItemSnapshot, TodoPhaseSnapshot };

// ─── Minimal context ──────────────────────────────────────────────────────────

/**
 * Minimal interface that the interactive mode must satisfy to drive the
 * Niri overview controller. Using a narrow interface keeps the niri package
 * free of a hard dependency on @oh-my-pi/pi-coding-agent.
 */
export interface NiriOverviewContext {
	/** TUI instance — used to show/hide the overlay. */
	ui: {
		showOverlay(component: OverviewComponent, options?: object): OverlayHandle;
		invalidate(): void;
		requestRender(force?: boolean): void;
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
	/** True when the user has acknowledged the needs_input state and wants to be left alone. */
	isUserPaused?: boolean;
	/** Current working directory (for project name). */
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	/** Current todo phases. */
	todoPhases: TodoPhaseView[];
	/** Counts of auto-cleared completed tasks per phase ID. */
	getClearedCompletedCounts?(): ReadonlyMap<string, { name: string; count: number }>;
	/** Subscribe to session events; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Called when the niri overview opens/closes, or when the status color changes while open. */
	onOverviewChanged?: (isOpen: boolean, bg?: string, resetBg?: string) => void;
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
	#savedImageProtocol: ImageProtocol | null = null;
	#destroyed = false;
	#writer = new StatusFileWriter();

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
				// Notify about bg color changes (status may have changed)
				const colors = STATUS_COLORS[this.#deriveStatus()];
				this.#context.onOverviewChanged?.(true, colors.bg, colors.resetBg);
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
		this.#hideOverview();
		void this.#writer.cleanup();
	}

	// ── Private ───────────────────────────────────────────────────────────────

	/** One-shot async init: discovers the niri window ID and writes the first status file. */
	async #initWindowId(): Promise<void> {
		await this.#writer.ensureDir();
		const id = await queryNiriFocusedWindowId();
		if (id !== null && !this.#destroyed) {
			this.#writer.setWindowId(id);
			this.#writeStatusIfChanged();
		}
	}

	/** Write status file if status changed since last write. No-op if no window ID. */
	#writeStatusIfChanged(): void {
		if (this.#destroyed) return;
		const status = this.#deriveStatus();
		const cwd = this.#context.sessionManager.getCwd();
		const projectName = path.basename(cwd);
		const sessionTitle = this.#context.sessionManager.getSessionName() ?? "";
		this.#writer.writeIfChanged(status, projectName, sessionTitle);
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
		this.#suppressImagesForOverview();
		this.#overlayHandle = this.#context.ui.showOverlay(this.#component, OVERLAY_OPTIONS);

		// Best-effort font scaling — fire and forget
		withLargerFont(FONT_SCALE_FACTOR)
			.then(restore => {
				this.#restoreFont = restore;
			})
			.catch(err => {
				logger.debug("NiriOverviewController: font scaling failed", { err: String(err) });
			});
		const colors = STATUS_COLORS[this.#deriveStatus()];
		this.#context.onOverviewChanged?.(true, colors.bg, colors.resetBg);
	}

	#hideOverview(): void {
		if (!this.#overlayHandle) return;

		logger.debug("NiriOverviewController: overview closed");
		this.#overlayHandle.hide();
		this.#overlayHandle = null;

		this.#restoreFont?.();
		this.#restoreFont = null;
		this.#restoreImagesAfterOverview();
		this.#context.onOverviewChanged?.(false);
	}

	#suppressImagesForOverview(): void {
		this.#savedImageProtocol = TERMINAL.imageProtocol;
		if (!this.#savedImageProtocol) return;

		clearImagePlacements();
		setTerminalImageProtocol(null);
		this.#context.ui.invalidate();
		this.#context.ui.requestRender(true);
	}

	#restoreImagesAfterOverview(): void {
		const imageProtocol = this.#savedImageProtocol;
		this.#savedImageProtocol = null;
		if (!imageProtocol) return;

		setTerminalImageProtocol(imageProtocol);
		this.#context.ui.invalidate();
		this.#context.ui.requestRender(true);
	}

	#buildSnapshot() {
		const ctx = this.#context;
		const cwd = ctx.sessionManager.getCwd();
		return buildOverviewSnapshot({
			projectName: path.basename(cwd),
			sessionTitle: ctx.sessionManager.getSessionName() ?? "",
			messageCount: ctx.session.messages.length,
			agentStatus: this.#deriveStatus(),
			todoPhases: ctx.todoPhases,
			clearedCompletedCounts: ctx.getClearedCompletedCounts?.(),
		} satisfies SnapshotContext);
	}

	#deriveStatus(): AgentStatus {
		const ctx = this.#context;
		return deriveAgentStatus({
			error: ctx.session.state.error,
			isPendingApproval: ctx.isPendingApproval,
			isAwaitingHookInput: ctx.isAwaitingHookInput,
			isUserPaused: ctx.isUserPaused,
			isStreaming: ctx.session.isStreaming,
			hasInputCallback: ctx.onInputCallback !== undefined,
			todoPhases: ctx.todoPhases,
		} satisfies AgentStatusContext);
	}
}
