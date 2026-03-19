/**
 * Fluid canvas mode: Decomposes a prompt into a DAG of agent tasks,
 * executes them reactively via a queue-based scheduler, and streams
 * live output to QML panels.
 */
import * as path from "node:path";
import { QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import { renderPromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import { FluidEventRouter, FluidOrchestrator } from "../orchestrators/fluid";
import { fluidPlanSchema } from "../orchestrators/fluid/plan-schema";
import type { AgentRuntime, FluidAgentNode, FluidEvent, FluidPlan } from "../orchestrators/fluid/types";
import { FLUID_EVENT_CHANNEL } from "../orchestrators/fluid/types";
import fluidPlannerPrompt from "../prompts/agents/fluid-planner.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition, SingleResult } from "../task/types";
import { type EventBus, Priority } from "../utils/event-bus";

export interface FluidModeOptions {
	initialMessage?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
}

interface ExecutionSnapshot {
	plan: FluidPlan;
	results: Map<string, AgentRuntime>;
}

export async function runFluidMode(session: AgentSession, options: FluidModeOptions = {}): Promise<void> {
	const eventBus = options.eventBus;
	if (!eventBus) {
		throw new Error("Fluid mode requires an EventBus");
	}

	const bridge = new QmlBridge();
	const shellPath = path.resolve(import.meta.dir, "qml/FluidShell.qml");
	const cwd = Settings.instance.getCwd();

	await bridge.launch("fluid-shell", shellPath, {
		title: "Spell - Fluid Canvas",
		width: 1360,
		height: 900,
	});

	// Route fluid events to the QML bridge
	const eventRouter = new FluidEventRouter(eventBus);
	const bridgeUnsub = eventBus.subscribe("bridge:outbound", (raw: unknown) => {
		bridge.sendMessage("fluid-shell", raw as Record<string, unknown>).catch(err => {
			logger.error("Failed to send fluid event to QML", { error: String(err) });
		});
	});

	const settings = Settings.instance;
	const concurrency = settings.get("fluid.concurrency") as number;
	const fastPlan = settings.get("fluid.fastPlan") as boolean;
	const debug = settings.get("fluid.debug") as boolean;
	const debugUnsub = debug
		? eventBus.subscribe(FLUID_EVENT_CHANNEL, (raw: unknown) => {
				writeFluidDebug(raw as FluidEvent);
			})
		: undefined;

	try {
		await processFluidEvents(session, eventBus, bridge, cwd, concurrency, fastPlan, options.initialMessage);
	} finally {
		debugUnsub?.();
		eventRouter.dispose();
		bridgeUnsub();
		await bridge.dispose();
	}
}

/**
 * Run the planning agent to decompose a user prompt into a FluidPlan,
 * then execute the plan via the FluidOrchestrator.
 */
async function executePlan(
	session: AgentSession,
	eventBus: EventBus,
	prompt: string,
	cwd: string,
	concurrency: number,
	fastPlan: boolean,
	signal?: AbortSignal,
): Promise<ExecutionSnapshot | undefined> {
	let draining = false;
	let planningDrainTimer: NodeJS.Timeout | undefined;
	const drainEventBusOnce = async (): Promise<number> => {
		if (draining) {
			return 0;
		}
		draining = true;
		try {
			return await eventBus.drain();
		} finally {
			draining = false;
		}
	};
	const flushEventBus = async (): Promise<void> => {
		while (draining) {
			await Bun.sleep(5);
		}
		while ((await drainEventBusOnce()) > 0) {
			// eventBus.drain() is capped; keep flushing until the queue is empty.
		}
	};
	const stopPlanningDrainTimer = async (): Promise<void> => {
		if (planningDrainTimer) {
			clearInterval(planningDrainTimer);
			planningDrainTimer = undefined;
		}
		await flushEventBus();
	};
	planningDrainTimer = setInterval(() => {
		void drainEventBusOnce();
	}, 100);

	try {
		eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
		if (signal?.aborted) {
			emitExecutionCancelled(eventBus, signal);
			return undefined;
		}

		const plan = await runPlanningAgent(session, eventBus, prompt, cwd, fastPlan, signal);
		if (!plan) {
			if (signal?.aborted) {
				emitExecutionCancelled(eventBus, signal);
			}
			return undefined;
		}

		await stopPlanningDrainTimer();
		const results = await executeFluidPlan(session, eventBus, plan, cwd, concurrency, signal);
		if (!results) {
			return undefined;
		}
		return { plan, results };
	} finally {
		await stopPlanningDrainTimer();
	}
}

async function executeFluidPlan(
	session: AgentSession,
	eventBus: EventBus,
	plan: FluidPlan,
	cwd: string,
	concurrency: number,
	signal?: AbortSignal,
	presetCompletedResults?: Map<string, SingleResult>,
): Promise<Map<string, AgentRuntime> | undefined> {
	const orchestrator = new FluidOrchestrator({
		eventBus,
		cwd,
		concurrency,
		runAgent: (node, upstream, runSignal) => runFluidAgent(session, eventBus, node, upstream, cwd, runSignal),
	});

	try {
		const results = await orchestrator.execute(plan, signal, presetCompletedResults);
		await eventBus.drain();
		return results;
	} catch (err) {
		if (signal?.aborted) {
			emitExecutionCancelled(eventBus, signal);
			return undefined;
		}
		logger.error("Fluid plan execution failed", { error: String(err) });
		emitPlanError(eventBus, err);
		return undefined;
	}
}

/**
 * Run the planning agent to produce a FluidPlan from a user prompt.
 */
async function runPlanningAgent(
	_session: AgentSession,
	eventBus: EventBus,
	prompt: string,
	cwd: string,
	fastPlan: boolean,
	signal?: AbortSignal,
): Promise<FluidPlan | undefined> {
	const systemPrompt = renderPromptTemplate(fluidPlannerPrompt, { cwd });

	const agent: AgentDefinition = {
		name: "fluid-planner",
		description: "Decomposes user intent into a DAG of agent tasks",
		systemPrompt,
		source: "bundled",
		tools: fastPlan ? [] : ["read", "grep", "find", "lsp"],
	};

	let lastIntent = "";
	try {
		const result = await runSubprocess({
			cwd,
			agent,
			task: prompt,
			assignment: prompt,
			index: 0,
			id: `fluid-planner-${Date.now()}`,
			outputSchema: fluidPlanSchema,
			eventBus,
			settings: Settings.instance,
			signal,
			onProgress: progress => {
				if (!progress.lastIntent || progress.lastIntent === lastIntent) {
					return;
				}
				lastIntent = progress.lastIntent;
				eventBus.enqueue(
					FLUID_EVENT_CHANNEL,
					{ type: "planner_stream", text: progress.lastIntent },
					Priority.P2,
					"stream:planner",
				);
			},
		});

		if (result.aborted || signal?.aborted) {
			return undefined;
		}
		if (result.exitCode !== 0 || !result.output) {
			logger.error("Planning agent failed", { exitCode: result.exitCode, error: result.error });
			eventBus.enqueue(
				FLUID_EVENT_CHANNEL,
				{ type: "plan_error", error: result.error ?? "Planning agent failed" },
				Priority.P1,
			);
			return undefined;
		}

		// Parse the plan from the agent's structured output
		const parsed = JSON.parse(result.output) as FluidPlan;
		return parsed;
	} catch (err) {
		if (signal?.aborted) {
			return undefined;
		}
		logger.error("Planning agent error", { error: String(err) });
		eventBus.enqueue(
			FLUID_EVENT_CHANNEL,
			{ type: "plan_error", error: err instanceof Error ? err.message : String(err) },
			Priority.P1,
		);
		return undefined;
	}
}

/**
 * Execute a single agent node as a subprocess.
 */
async function runFluidAgent(
	_session: AgentSession,
	eventBus: EventBus,
	node: FluidAgentNode,
	upstreamResults: Map<string, SingleResult>,
	cwd: string,
	signal?: AbortSignal,
): Promise<SingleResult> {
	// Build context from upstream results
	const contextParts: string[] = [];
	for (const [depId, depResult] of upstreamResults) {
		contextParts.push(`## Output from "${depId}"\n\n${depResult.output}`);
	}

	const upstreamContext =
		contextParts.length > 0 ? `\n\n# Upstream Results\n\n${contextParts.join("\n\n---\n\n")}` : "";

	const assignment = `${node.task}${upstreamContext}`;

	const agent: AgentDefinition = {
		name: `fluid-agent-${node.id}`,
		description: `Fluid canvas agent: ${node.id}`,
		systemPrompt:
			"You are an agent executing a specific task as part of a larger plan. " +
			"Complete your assigned task thoroughly. Your output will be passed to downstream agents if any depend on you.",
		source: "bundled",
	};

	return runSubprocess({
		cwd,
		agent,
		task: node.task,
		assignment,
		index: 0,
		id: `fluid-${node.id}-${Date.now()}`,
		eventBus,
		settings: Settings.instance,
		signal,
		onProgress: progress => {
			if (progress.lastIntent) {
				eventBus.enqueue(
					FLUID_EVENT_CHANNEL,
					{ type: "agent_stream", agentId: node.id, text: progress.lastIntent },
					Priority.P2,
					`stream:${node.id}`,
				);
			}
		},
	});
}

/**
 * Event loop: wait for QML user actions and dispatch them.
 * Exits when the shell window closes.
 */
async function processFluidEvents(
	session: AgentSession,
	eventBus: EventBus,
	bridge: QmlBridge,
	cwd: string,
	concurrency: number,
	fastPlan: boolean,
	initialPrompt?: string,
): Promise<void> {
	let activeController: AbortController | null = null;
	let activeExecution: Promise<void> | null = null;
	let lastPlan: FluidPlan | undefined;
	let lastRuntimes: Map<string, AgentRuntime> | undefined;

	const startExecution = (prompt: string): void => {
		if (activeExecution) {
			return;
		}
		const controller = new AbortController();
		activeController = controller;
		activeExecution = executePlan(session, eventBus, prompt, cwd, concurrency, fastPlan, controller.signal)
			.then(snapshot => {
				if (!snapshot) {
					return;
				}
				lastPlan = snapshot.plan;
				lastRuntimes = snapshot.results;
			})
			.catch(err => {
				logger.error("Fluid execution failed", { error: String(err) });
				emitPlanError(eventBus, err);
			})
			.finally(() => {
				if (activeController === controller) {
					activeController = null;
				}
				activeExecution = null;
			});
	};

	const startRetry = (requestedAgentIds?: string[]): void => {
		if (activeExecution) {
			return;
		}
		if (!lastPlan || !lastRuntimes) {
			emitPlanError(eventBus, "No prior fluid execution to retry");
			return;
		}

		const retryRoots = resolveRetryRoots(lastRuntimes, requestedAgentIds);
		if (retryRoots.length === 0) {
			emitPlanError(eventBus, "No failed agents available to retry");
			return;
		}

		const retrySet = collectRetrySubtree(lastPlan, new Set(retryRoots));
		const presetCompletedResults = collectPresetCompletedResults(lastPlan, lastRuntimes, retrySet);
		const controller = new AbortController();
		activeController = controller;
		activeExecution = executeFluidPlan(
			session,
			eventBus,
			lastPlan,
			cwd,
			concurrency,
			controller.signal,
			presetCompletedResults,
		)
			.then(results => {
				if (!results) {
					return;
				}
				lastRuntimes = results;
			})
			.catch(err => {
				logger.error("Fluid retry failed", { error: String(err) });
				emitPlanError(eventBus, err);
			})
			.finally(() => {
				if (activeController === controller) {
					activeController = null;
				}
				activeExecution = null;
			});
	};

	const cancelExecution = (reason = "Execution cancelled"): void => {
		if (!activeController || activeController.signal.aborted) {
			return;
		}
		activeController.abort(reason);
	};

	if (initialPrompt) {
		startExecution(initialPrompt);
	}

	while (true) {
		const events = await bridge.waitForEvent("fluid-shell", 250);
		for (const event of events) {
			if (!event.payload) continue;
			const { type } = event.payload as { type?: string };

			switch (type) {
				case "prompt": {
					const text = (event.payload as { text: string }).text;
					startExecution(text);
					break;
				}
				case "cancel_execution": {
					const reason = (event.payload as { reason?: string }).reason;
					cancelExecution(reason ?? "Cancelled from fluid canvas");
					break;
				}
				case "retry_failed": {
					const payload = event.payload as { agentIds?: unknown };
					const agentIds =
						Array.isArray(payload.agentIds) && payload.agentIds.length > 0
							? payload.agentIds.map(id => String(id))
							: undefined;
					startRetry(agentIds);
					break;
				}
			}
		}

		// Check if shell was closed
		const shell = bridge.getWindow("fluid-shell");
		if (!shell || shell.state === "closed") {
			cancelExecution("Fluid shell closed");
			if (activeExecution) {
				try {
					await activeExecution;
				} catch {
					// execution errors are already surfaced through fluid events
				}
			}
			break;
		}
	}
}

function resolveRetryRoots(runtimes: Map<string, AgentRuntime>, requestedAgentIds?: string[]): string[] {
	if (requestedAgentIds && requestedAgentIds.length > 0) {
		return requestedAgentIds.filter(agentId => runtimes.get(agentId)?.state === "failed");
	}
	const roots: string[] = [];
	for (const [agentId, runtime] of runtimes.entries()) {
		if (runtime.state === "failed") {
			roots.push(agentId);
		}
	}
	return roots;
}

function collectRetrySubtree(plan: FluidPlan, rootIds: Set<string>): Set<string> {
	const retrySet = new Set<string>(rootIds);
	const childrenByDependency = new Map<string, string[]>();
	for (const node of plan.agents) {
		for (const dep of node.dependsOn) {
			const children = childrenByDependency.get(dep) ?? [];
			children.push(node.id);
			childrenByDependency.set(dep, children);
		}
	}

	const queue = [...rootIds];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		for (const childId of childrenByDependency.get(current) ?? []) {
			if (retrySet.has(childId)) {
				continue;
			}
			retrySet.add(childId);
			queue.push(childId);
		}
	}
	return retrySet;
}

function collectPresetCompletedResults(
	plan: FluidPlan,
	runtimes: Map<string, AgentRuntime>,
	retrySet: Set<string>,
): Map<string, SingleResult> {
	const preset = new Map<string, SingleResult>();
	for (const node of plan.agents) {
		if (retrySet.has(node.id)) {
			continue;
		}
		const runtime = runtimes.get(node.id);
		if (runtime?.state === "completed" && runtime.result) {
			preset.set(node.id, runtime.result);
		}
	}
	return preset;
}

function emitPlanError(eventBus: EventBus, err: unknown): void {
	eventBus.enqueue(
		FLUID_EVENT_CHANNEL,
		{ type: "plan_error", error: err instanceof Error ? err.message : String(err) },
		Priority.P1,
	);
}

function emitExecutionCancelled(eventBus: EventBus, signal?: AbortSignal): void {
	eventBus.enqueue(
		FLUID_EVENT_CHANNEL,
		{ type: "execution_cancelled", reason: resolveAbortReason(signal) },
		Priority.P1,
	);
}

function resolveAbortReason(signal?: AbortSignal): string {
	if (!signal?.aborted) {
		return "Execution cancelled";
	}
	const reason = signal.reason;
	if (typeof reason === "string" && reason.length > 0) {
		return reason;
	}
	if (reason instanceof Error && reason.message.length > 0) {
		return reason.message;
	}
	return "Execution cancelled";
}

function writeFluidDebug(event: FluidEvent): void {
	switch (event.type) {
		case "plan_start":
			process.stderr.write("[fluid] plan start\n");
			return;
		case "plan_complete":
			process.stderr.write(`[fluid] plan complete (${event.plan.agents.length} agents)\n`);
			return;
		case "plan_error":
			process.stderr.write(`[fluid] plan error: ${event.error}\n`);
			return;
		case "planner_stream":
			process.stderr.write(`[fluid] planner: ${event.text}\n`);
			return;
		case "agent_state_change":
			process.stderr.write(
				`[fluid] agent ${event.agentId}: ${event.state}${event.error ? ` (${event.error})` : ""}\n`,
			);
			return;
		case "execution_cancelled":
			process.stderr.write(`[fluid] execution cancelled: ${event.reason}\n`);
			return;
		case "execution_complete":
			process.stderr.write(`[fluid] execution complete (${event.results.size} results)\n`);
			return;
		default:
			return;
	}
}
