/**
 * Canvas task lifecycle manager.
 *
 * Subscribes to CANVAS_TASK_CHANNEL. On each event, spawns a subagent
 * subprocess with configurable model, system prompt, tools, and output schema.
 * When the window closes, the task is aborted.
 *
 * Unlike the orchestrator tier (read-only, scoped), the task tier has full
 * tool access and is intended for targeted edits dispatched from QML UIs
 * (e.g. the Phoenix inspector's "Quick Fix" button).
 */

import type { QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentDefinition, SingleResult } from "../task/types";
import {
	CANVAS_EVENTS_CHANNEL,
	CANVAS_TASK_CHANNEL,
	type CanvasTaskPayload,
	type CanvasWindowEventsPayload,
} from "../tools/canvas";
import type { EventBus } from "../utils/event-bus";

const DEFAULT_MODEL = "pi/smol";
const DEFAULT_TOOLS = ["read", "grep", "find", "edit", "lsp", "bash", "ast_grep", "ast_edit"];

/** Minimal executor contract — same shape as runSubprocess from task/executor. */
export type CanvasTaskExecutor = (options: {
	cwd: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	index: number;
	id: string;
	signal?: AbortSignal;
	eventBus?: EventBus;
	outputSchema?: unknown;
	[key: string]: unknown;
}) => Promise<SingleResult>;

interface TaskEntry {
	windowId: string;
	assignment: string;
	ac: AbortController;
	promise: Promise<SingleResult>;
}

export interface CanvasTaskManagerOptions {
	eventBus: EventBus;
	cwd: string;
	/** Injectable executor for testing. Defaults to runSubprocess at runtime. */
	executor?: CanvasTaskExecutor;
	/** Base executor options inherited by task sessions (settings, modelRegistry, etc.). */
	executorDefaults?: Record<string, unknown>;
}

/**
 * Manages task subagent sessions bound to canvas windows.
 *
 * Each window can have at most one active task. A new request to the same
 * window aborts the previous task.
 */
export class CanvasTaskManager {
	readonly #options: CanvasTaskManagerOptions;
	readonly #active = new Map<string, TaskEntry>();
	#executor: CanvasTaskExecutor;
	#unsubTask?: () => void;
	#unsubClose?: () => void;
	#bridge?: QmlBridge | RemoteQmlBridge;

	constructor(options: CanvasTaskManagerOptions) {
		this.#options = options;
		this.#executor = options.executor ?? CanvasTaskManager.#defaultExecutor();
	}

	static #defaultExecutor(): CanvasTaskExecutor {
		// Lazy-load to avoid circular imports in test
		let loaded: CanvasTaskExecutor | undefined;
		return async opts => {
			if (!loaded) {
				const { runSubprocess } = await import("../task/executor");
				loaded = runSubprocess as unknown as CanvasTaskExecutor;
			}
			return loaded(opts);
		};
	}

	setBridge(bridge: QmlBridge | RemoteQmlBridge | undefined): void {
		this.#bridge = bridge;
	}

	/** Start listening for task requests and window close events. */
	start(): void {
		const { eventBus } = this.#options;

		this.#unsubTask = eventBus.subscribe(CANVAS_TASK_CHANNEL, (raw: unknown) => {
			const payload = raw as CanvasTaskPayload;
			void this.#handleRequest(payload);
		});

		this.#unsubClose = eventBus.subscribe(CANVAS_EVENTS_CHANNEL, (raw: unknown) => {
			const payload = raw as CanvasWindowEventsPayload;
			if (payload.closed) {
				this.#abortTask(payload.windowId);
			}
		});
	}

	/** Stop all tasks and unsubscribe. */
	dispose(): void {
		this.#unsubTask?.();
		this.#unsubClose?.();
		for (const [, entry] of this.#active) {
			entry.ac.abort();
		}
		this.#active.clear();
	}

	/** Returns the list of active tasks. */
	getActive(): Array<{ windowId: string; assignment: string }> {
		return [...this.#active.entries()].map(([windowId, entry]) => ({
			windowId,
			assignment: entry.assignment,
		}));
	}

	async #handleRequest(payload: CanvasTaskPayload): Promise<void> {
		const { windowId, assignment, model, systemPrompt, tools, outputSchema, context, images } = payload;

		// Abort any existing task for this window.
		this.#abortTask(windowId);

		const ac = new AbortController();

		const agent: AgentDefinition = {
			name: "canvas-task",
			description: `Task subagent for window ${windowId}`,
			systemPrompt: systemPrompt ?? "",
			source: "bundled",
			tools: tools ?? DEFAULT_TOOLS,
			model: [model ?? DEFAULT_MODEL],
		};

		// Build assignment text with context and image references.
		let fullAssignment = assignment;
		if (context) {
			fullAssignment += `\n\nContext: ${JSON.stringify(context)}`;
		}
		if (images && images.length > 0) {
			fullAssignment += `\n\n${images.length} screenshot(s) attached.`;
		}

		const executorOptions = {
			...this.#options.executorDefaults,
			cwd: this.#options.cwd,
			agent,
			task: assignment,
			assignment: fullAssignment,
			index: 0,
			id: `canvas-task-${windowId}-${Date.now()}`,
			signal: ac.signal,
			eventBus: this.#options.eventBus,
			outputSchema,
		};

		const promise = this.#executor(executorOptions);

		const entry: TaskEntry = { windowId, assignment, ac, promise };
		this.#active.set(windowId, entry);

		try {
			const result = await promise;
			this.#active.delete(windowId);

			// Don't send result if the task was aborted (window closed).
			if (ac.signal.aborted) return;

			const bridge = this.#bridge;
			if (bridge) {
				const output = result.output || "Task completed with no output.";
				bridge.sendMessage(windowId, {
					action: "task_result",
					ok: true,
					output,
				});
			}
		} catch (err) {
			this.#active.delete(windowId);
			if (ac.signal.aborted) {
				logger.debug("Canvas task aborted", { windowId, assignment });
				return;
			}

			logger.error("Canvas task failed", { windowId, assignment, error: String(err) });

			const bridge = this.#bridge;
			if (bridge) {
				bridge.sendMessage(windowId, {
					action: "task_result",
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	#abortTask(windowId: string): void {
		const existing = this.#active.get(windowId);
		if (existing) {
			existing.ac.abort();
			this.#active.delete(windowId);
		}
	}
}
