/**
 * Canvas orchestrator lifecycle manager.
 *
 * Subscribes to CANVAS_ORCHESTRATOR_CHANNEL. On each event, creates (or reuses)
 * a lightweight agent session bound to the requesting canvas window. When the
 * window closes, the orchestrator is aborted.
 */

import type { QmlBridge } from "@oh-my-pi/pi-qml";
import type { RemoteQmlBridge } from "@oh-my-pi/pi-qml-remote";
import { logger } from "@oh-my-pi/pi-utils";
import { Value } from "@sinclair/typebox/value";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { CustomTool } from "../extensibility/custom-tools/types";
import canvasOrchestratorMd from "../prompts/agents/canvas-orchestrator.md" with { type: "text" };
import { type ExecutorOptions, runSubprocess } from "../task/executor";
import type { AgentDefinition, SingleResult } from "../task/types";
import {
	CANVAS_EVENTS_CHANNEL,
	CANVAS_ORCHESTRATOR_CHANNEL,
	type CanvasOrchestratorPayload,
	type CanvasWindowEventsPayload,
} from "../tools/canvas";
import { escalateSchema } from "../tools/escalate";
import type { EventBus } from "../utils/event-bus";

interface OrchestratorEntry {
	windowId: string;
	scope: string;
	ac: AbortController;
	/** Resolves when the subprocess finishes. */
	promise: Promise<SingleResult>;
}

export interface CanvasOrchestratorManagerOptions {
	eventBus: EventBus;
	cwd: string;
	getBridge?: () => QmlBridge | RemoteQmlBridge | undefined;
	/** Base executor options inherited by orchestrator sessions. */
	executorDefaults?: Partial<ExecutorOptions>;
}

/**
 * Manages scoped orchestrator agent sessions bound to canvas windows.
 *
 * Each window can have at most one active orchestrator. Subsequent requests
 * to the same window are queued until the current orchestrator completes.
 */
export class CanvasOrchestratorManager {
	readonly #options: CanvasOrchestratorManagerOptions;
	readonly #active = new Map<string, OrchestratorEntry>();
	#unsubOrchestrator?: () => void;
	#unsubClose?: () => void;
	#bridge?: QmlBridge | RemoteQmlBridge;

	constructor(options: CanvasOrchestratorManagerOptions) {
		this.#options = options;
	}

	setBridge(bridge: QmlBridge | RemoteQmlBridge | undefined): void {
		this.#bridge = bridge;
	}

	/** Start listening for orchestrator requests and window close events. */
	start(): void {
		const { eventBus } = this.#options;

		this.#unsubOrchestrator = eventBus.subscribe(CANVAS_ORCHESTRATOR_CHANNEL, async (raw: unknown) => {
			const payload = raw as CanvasOrchestratorPayload;
			await this.#handleRequest(payload);
		});

		// Listen for window close events to abort bound orchestrators.
		this.#unsubClose = eventBus.subscribe(CANVAS_EVENTS_CHANNEL, (raw: unknown) => {
			const payload = raw as CanvasWindowEventsPayload;
			if (payload.closed) {
				this.#abortOrchestrator(payload.windowId);
			}
		});
	}

	/** Stop all orchestrators and unsubscribe. */
	dispose(): void {
		this.#unsubOrchestrator?.();
		this.#unsubClose?.();
		for (const [, entry] of this.#active) {
			entry.ac.abort();
		}
		this.#active.clear();
	}

	/** Returns the list of active orchestrators with their scope. */
	getActive(): Array<{ windowId: string; scope: string }> {
		return [...this.#active.entries()].map(([windowId, entry]) => ({
			windowId,
			scope: entry.scope,
		}));
	}

	async #handleRequest(payload: CanvasOrchestratorPayload): Promise<void> {
		const { windowId, scope, tools, context } = payload;

		// If an orchestrator already exists for this window, abort it first.
		this.#abortOrchestrator(windowId);

		const ac = new AbortController();
		const systemPrompt = renderPromptTemplate(canvasOrchestratorMd, { scope });

		const agent: AgentDefinition = {
			name: "canvas-orchestrator",
			description: `Scoped orchestrator for window ${windowId}`,
			systemPrompt,
			source: "bundled",
			tools: tools ?? ["read", "grep", "find", "lsp", "escalate"],
		};

		const assignment = `Scope: ${scope}${context ? `\n\nContext: ${JSON.stringify(context)}` : ""}`;

		const managerOptions = this.#options;
		const escalateTool: CustomTool = {
			name: "escalate",
			label: "Escalate",
			description: "Escalate the current task to a full agent when it exceeds orchestrator scope.",
			parameters: escalateSchema,
			execute: async (_toolCallId, params, _onUpdate, _ctx, _signal) => {
				const { reason, assignment: escalationAssignment } = Value.Decode(escalateSchema, params);
				const escalationScope = escalationAssignment ?? scope;

				const escalationAgent: AgentDefinition = {
					name: "escalation-agent",
					description: `Full agent escalated from orchestrator: ${reason}`,
					systemPrompt: renderPromptTemplate(canvasOrchestratorMd, { scope: escalationScope }),
					source: "bundled",
				};

				try {
					const result = await runSubprocess({
						...managerOptions.executorDefaults,
						cwd: managerOptions.cwd,
						agent: escalationAgent,
						task: escalationScope,
						assignment: escalationScope,
						index: 0,
						id: `escalation-${windowId}-${Date.now()}`,
						signal: ac.signal,
						eventBus: managerOptions.eventBus,
					});
					return {
						content: [{ type: "text", text: `Escalation completed.\n\n${result.output || "No output."}` }],
					};
				} catch (err) {
					if (ac.signal.aborted) {
						return { content: [{ type: "text", text: "Escalation cancelled — window was closed." }] };
					}
					return {
						content: [
							{
								type: "text",
								text: `Escalation failed: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
					};
				}
			},
		};

		const executorOptions: ExecutorOptions = {
			...managerOptions.executorDefaults,
			cwd: managerOptions.cwd,
			agent,
			task: scope,
			assignment,
			index: 0,
			id: `canvas-orch-${windowId}-${Date.now()}`,
			signal: ac.signal,
			eventBus: managerOptions.eventBus,
			customTools: [escalateTool],
		};

		const promise = runSubprocess(executorOptions);

		const entry: OrchestratorEntry = { windowId, scope, ac, promise };
		this.#active.set(windowId, entry);

		try {
			const result = await promise;
			this.#active.delete(windowId);

			// Send result back to canvas window.
			const bridge = this.#bridge;
			if (bridge) {
				const resultText = result.output || "Orchestrator completed with no output.";

				bridge.sendMessage(windowId, {
					action: "append",
					content: [
						{
							id: `orch-result-${Date.now()}`,
							type: "markdown",
							data: { text: `### Orchestrator Result\n\n${resultText}` },
						},
					],
				});
			}
		} catch (err) {
			this.#active.delete(windowId);
			if (ac.signal.aborted) {
				logger.debug("Canvas orchestrator aborted", { windowId, scope });
			} else {
				logger.error("Canvas orchestrator failed", { windowId, scope, error: String(err) });

				// Send error back to canvas.
				const bridge = this.#bridge;
				if (bridge) {
					bridge.sendMessage(windowId, {
						action: "append",
						content: [
							{
								id: `orch-error-${Date.now()}`,
								type: "status",
								data: {
									state: "error",
									label: "Orchestrator failed",
									detail: err instanceof Error ? err.message : String(err),
								},
							},
						],
					});
				}
			}
		}
	}

	#abortOrchestrator(windowId: string): void {
		const existing = this.#active.get(windowId);
		if (existing) {
			existing.ac.abort();
			this.#active.delete(windowId);
		}
	}
}
