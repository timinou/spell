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
import {
	type AgentDefinition,
	type AgentProgress,
	type SingleResult,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../task/types";
import {
	CANVAS_EVENTS_CHANNEL,
	CANVAS_TASK_CHANNEL,
	type CanvasTaskPayload,
	type CanvasWindowEventsPayload,
} from "../tools/canvas";
import type { EventBus } from "../utils/event-bus";

const DEFAULT_MODEL = "pi/sniper";
const DEFAULT_TOOLS = ["read", "grep", "find", "edit", "bash", "ast_grep"];
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

function stringifyTaskResult(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

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
	taskId: string;
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
	/** Task timeout in ms. Default: 120_000 (120s). */
	timeoutMs?: number;
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
	#unsubProgress?: () => void;
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

		this.#unsubProgress = eventBus.subscribe(TASK_SUBAGENT_PROGRESS_CHANNEL, (raw: unknown) => {
			const data = raw as { progress: AgentProgress };
			this.#forwardProgress(data.progress);
		});
	}

	/** Stop all tasks and unsubscribe. */
	dispose(): void {
		this.#unsubTask?.();
		this.#unsubClose?.();
		this.#unsubProgress?.();
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
		const { windowId, assignment, model, systemPrompt, tools, outputSchema, context, images, reply } = payload;
		const resolvedModel = model ?? DEFAULT_MODEL;

		// Abort any existing task for this window.
		this.#abortTask(windowId);

		logger.debug("Canvas task received", { windowId, assignment: assignment.slice(0, 80) });
		reply?.({
			action: "task_ack",
			ok: true,
			status: "processing",
			model: resolvedModel,
			message: `Task received: ${assignment.slice(0, 60)}`,
		});

		const ac = new AbortController();
		const taskTimeoutMs = this.#options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
		const timeoutSignal = AbortSignal.timeout(taskTimeoutMs);
		const combinedSignal = AbortSignal.any([ac.signal, timeoutSignal]);
		const startTime = Date.now();

		const agent: AgentDefinition = {
			name: "canvas-task",
			description: `Task subagent for window ${windowId}`,
			systemPrompt: systemPrompt ?? "",
			source: "bundled",
			tools: tools ?? DEFAULT_TOOLS,
			model: [resolvedModel],
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
			signal: combinedSignal,
			eventBus: this.#options.eventBus,
			outputSchema,
		};

		logger.debug("Canvas task started", { windowId, id: executorOptions.id, model: agent.model });
		const promise = this.#executor(executorOptions);
		const taskId = executorOptions.id;

		const entry: TaskEntry = { windowId, assignment, taskId, ac, promise };
		this.#active.set(windowId, entry);

		try {
			const result = await promise;
			this.#active.delete(windowId);

			// Don't send result if the task was aborted (window closed).
			if (ac.signal.aborted) return;

			const durationMs = Date.now() - startTime;
			logger.debug("Canvas task completed", {
				windowId,
				id: executorOptions.id,
				durationMs,
			});

			const bridge = this.#bridge;
			if (bridge) {
				const output =
					result.textPreview || stringifyTaskResult(result.structuredResult) || "Task completed with no output.";
				bridge.sendMessage(windowId, {
					action: "task_result",
					ok: true,
					output,
					model: resolvedModel,
					tokens: result.tokens,
					durationMs,
					usage: result.usage ?? null,
				});
			}
		} catch (err) {
			this.#active.delete(windowId);
			if (timeoutSignal.aborted && !ac.signal.aborted) {
				logger.warn("Canvas task timed out", {
					windowId,
					id: executorOptions.id,
					assignment: assignment.slice(0, 80),
					timeoutMs: taskTimeoutMs,
				});

				const bridge = this.#bridge;
				if (bridge) {
					bridge.sendMessage(windowId, {
						action: "task_result",
						ok: false,
						error: `Task timed out after ${taskTimeoutMs / 1000}s`,
						timedOut: true,
						model: resolvedModel,
						durationMs: Date.now() - startTime,
						retryable: true,
					});
				}
				return;
			}

			if (ac.signal.aborted) {
				logger.debug("Canvas task aborted", { windowId, assignment, id: executorOptions.id });
				return;
			}

			logger.error("Canvas task failed", { windowId, assignment, id: executorOptions.id, error: String(err) });

			const bridge = this.#bridge;
			if (bridge) {
				bridge.sendMessage(windowId, {
					action: "task_result",
					ok: false,
					error: err instanceof Error ? err.message : String(err),
					model: resolvedModel,
					durationMs: Date.now() - startTime,
					retryable: true,
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

	#findWindowByTaskId(taskId: string): string | undefined {
		for (const [windowId, entry] of this.#active) {
			if (entry.taskId === taskId) return windowId;
		}
		return undefined;
	}

	#forwardProgress(progress: AgentProgress): void {
		const windowId = this.#findWindowByTaskId(progress.id);
		if (!windowId) return;

		const bridge = this.#bridge;
		if (!bridge) return;

		bridge.sendMessage(windowId, {
			action: "task_progress",
			status: progress.status,
			currentTool: progress.currentTool ?? null,
			lastIntent: progress.lastIntent ?? null,
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		});
	}
}
