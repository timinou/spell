/**
 * Fluid canvas mode: decomposes a prompt into a DAG of agent tasks,
 * materializes canonical wave-based todos, and streams live output to QML panels.
 */
import * as path from "node:path";
import { isDisplayAvailable, QmlBridge } from "@oh-my-pi/pi-qml";
import { logger } from "@oh-my-pi/pi-utils";
import { renderPromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import { FluidEventRouter, materializeFluidPlanToTodos, validatePlan } from "../orchestrators/fluid";
import { fluidPlanSchema } from "../orchestrators/fluid/plan-schema";
import type { AgentRuntime, FluidEvent, FluidPlan } from "../orchestrators/fluid/types";
import { FLUID_EVENT_CHANNEL } from "../orchestrators/fluid/types";
import fluidPlannerPrompt from "../prompts/agents/fluid-planner.md" with { type: "text" };
import fluidPlannerRetryPrompt from "../prompts/agents/fluid-planner-retry.md" with { type: "text" };
import executionPromptTemplate from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition } from "../task/types";
import { cloneTodoPhases, findTask, hasUnresolvedBlockers, type TodoPhase } from "../tools/todo-write";
import { type EventBus, Priority } from "../utils/event-bus";

export interface FluidModeOptions {
	initialMessage?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
}

interface FluidExecutionResult {
	runtimes: Map<string, AgentRuntime>;
	taskIdByAgentId: Map<string, string>;
}

interface ExecutionSnapshot {
	plan: FluidPlan;
	results: Map<string, AgentRuntime>;
	phases: TodoPhase[];
	taskIdByAgentId: Map<string, string>;
}

const PLAN_VALIDATION_RETRY_FALLBACK =
	"Refine the plan so tasks are concrete, dependencies are minimal, and coverage matches the user request.";

export async function runFluidMode(session: AgentSession, options: FluidModeOptions = {}): Promise<void> {
	const eventBus = options.eventBus;
	if (!eventBus) {
		throw new Error("Fluid mode requires an EventBus");
	}

	if (!isDisplayAvailable()) {
		throw new Error("Fluid mode requires a graphical display (DISPLAY or WAYLAND_DISPLAY must be set)");
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
	const fastPlan = settings.get("fluid.fastPlan") as boolean;
	const debug = settings.get("fluid.debug") as boolean;
	const debugUnsub = debug
		? eventBus.subscribe(FLUID_EVENT_CHANNEL, (raw: unknown) => {
				writeFluidDebug(raw as FluidEvent);
			})
		: undefined;

	try {
		await processFluidEvents(session, eventBus, bridge, cwd, fastPlan, options.initialMessage);
	} finally {
		debugUnsub?.();
		eventRouter.dispose();
		bridgeUnsub();
		await bridge.dispose();
	}
}

/**
 * Run the planning agent to produce a FluidPlan, then execute it through the
 * shared wave-based todo engine and unified execution prompt.
 */
async function executePlan(
	session: AgentSession,
	eventBus: EventBus,
	prompt: string,
	cwd: string,
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

		const initialPlan = await runPlanningAgent(session, eventBus, prompt, cwd, fastPlan, signal);
		if (!initialPlan) {
			if (signal?.aborted) {
				emitExecutionCancelled(eventBus, signal);
			}
			return undefined;
		}

		const plan = await validateAndRefinePlan(session, eventBus, prompt, initialPlan, cwd, fastPlan, signal);
		if (!plan) {
			if (signal?.aborted) {
				emitExecutionCancelled(eventBus, signal);
			}
			return undefined;
		}

		await stopPlanningDrainTimer();
		const execResult = await executeFluidPlan(session, eventBus, plan, signal);
		if (!execResult) {
			return undefined;
		}
		const finalPhases = cloneTodoPhases(session.getTodoPhases());
		return {
			plan,
			results: execResult.runtimes,
			phases: finalPhases,
			taskIdByAgentId: execResult.taskIdByAgentId,
		};
	} finally {
		await stopPlanningDrainTimer();
	}
}

async function validateAndRefinePlan(
	session: AgentSession,
	eventBus: EventBus,
	prompt: string,
	initialPlan: FluidPlan,
	cwd: string,
	fastPlan: boolean,
	signal?: AbortSignal,
): Promise<FluidPlan | undefined> {
	eventBus.enqueue(
		FLUID_EVENT_CHANNEL,
		{ type: "planner_stream", text: "Validating plan..." },
		Priority.P2,
		"stream:planner",
	);
	const firstValidation = validatePlan(initialPlan);
	if (signal?.aborted) {
		return undefined;
	}
	if (firstValidation.warnings.length > 0) {
		logger.warn("Fluid plan validation produced warnings", { warnings: firstValidation.warnings });
	}
	if (firstValidation.valid) {
		return initialPlan;
	}

	const firstCritique =
		firstValidation.errors.length > 0
			? `Structural validation failed: ${firstValidation.errors.join("; ")}`
			: PLAN_VALIDATION_RETRY_FALLBACK;

	eventBus.enqueue(
		FLUID_EVENT_CHANNEL,
		{ type: "planner_stream", text: "Refining plan based on validation feedback..." },
		Priority.P2,
		"stream:planner",
	);
	const revisedPlan = await runPlanningAgent(session, eventBus, prompt, cwd, fastPlan, signal, firstCritique);
	if (!revisedPlan || signal?.aborted) {
		return undefined;
	}

	eventBus.enqueue(
		FLUID_EVENT_CHANNEL,
		{ type: "planner_stream", text: "Validating revised plan..." },
		Priority.P2,
		"stream:planner",
	);
	const secondValidation = validatePlan(revisedPlan);
	if (signal?.aborted) {
		return undefined;
	}
	if (secondValidation.warnings.length > 0) {
		logger.warn("Fluid plan validation produced warnings", { warnings: secondValidation.warnings });
	}
	if (secondValidation.valid) {
		return revisedPlan;
	}

	const secondCritique =
		secondValidation.errors.length > 0
			? `Structural validation failed after one refinement attempt: ${secondValidation.errors.join("; ")}`
			: "Plan failed validation after one refinement attempt.";
	emitPlanError(eventBus, secondCritique);
	return undefined;
}

function promoteFirstRunnableTask(phases: TodoPhase[]): void {
	const tasks = phases.flatMap(phase => phase.tasks);
	for (const task of tasks) {
		task.status =
			task.status === "completed" || task.status === "abandoned" || task.status === "failed"
				? task.status
				: "pending";
	}
	for (const task of tasks) {
		if (!hasUnresolvedBlockers(task, tasks)) {
			task.status = "in_progress";
			return;
		}
	}
}

function isTodoTerminal(phases: TodoPhase[]): boolean {
	const tasks = phases.flatMap(phase => phase.tasks);
	return (
		tasks.length > 0 &&
		tasks.every(task => task.status === "completed" || task.status === "abandoned" || task.status === "failed")
	);
}

function deriveAgentState(taskId: string, phases: TodoPhase[]): AgentRuntime["state"] {
	const task = findTask(phases, taskId);
	if (!task) return "failed";
	const allTasks = phases.flatMap(phase => phase.tasks);
	if (task.status === "completed") return "completed";
	if (task.status === "abandoned" || task.status === "failed") return "failed";
	if (task.status === "in_progress") return "running";
	return hasUnresolvedBlockers(task, allTasks) ? "pending" : "ready";
}

function buildExecutionPrompt(plan: FluidPlan): string {
	const executionItems = plan.agents.map(agent => ({
		id: agent.id,
		task: agent.task,
		dependsOn: agent.dependsOn,
		effort: agent.effort ?? "",
		priority: agent.priority ?? "",
		body: agent.body ?? "",
	}));
	return renderPromptTemplate(executionPromptTemplate, {
		planId: "fluid-canvas",
		executionItems,
		isSimple: plan.agents.length <= 2,
		itemCount: plan.agents.length,
	});
}

async function executeFluidPlan(
	session: AgentSession,
	eventBus: EventBus,
	plan: FluidPlan,
	signal?: AbortSignal,
	retryState?: { phases: TodoPhase[]; taskIdByAgentId: Map<string, string> },
): Promise<FluidExecutionResult | undefined> {
	let taskIdByAgentId: Map<string, string>;
	let phases: TodoPhase[];
	if (retryState) {
		taskIdByAgentId = retryState.taskIdByAgentId;
		phases = retryState.phases;
	} else {
		const todoPlan = materializeFluidPlanToTodos(plan);
		taskIdByAgentId = todoPlan.taskIdByAgentId;
		phases = cloneTodoPhases(todoPlan.phases);
		promoteFirstRunnableTask(phases);
	}
	const runtimes = new Map<string, AgentRuntime>(
		plan.agents.map(agent => {
			const taskId = taskIdByAgentId.get(agent.id);
			const task = taskId ? findTask(phases, taskId) : undefined;
			const isCompleted = task?.status === "completed";
			return [
				agent.id,
				{
					node: agent,
					state: isCompleted ? "completed" : "pending",
					result: undefined,
				},
			];
		}),
	);
	let executionCompleteEmitted = false;
	const syncRuntimeStates = (nextPhases: TodoPhase[]): void => {
		for (const [agentId, taskId] of taskIdByAgentId) {
			const runtime = runtimes.get(agentId);
			if (!runtime) continue;
			const nextState = deriveAgentState(taskId, nextPhases);
			if (runtime.state === nextState) continue;
			const timestamp = Date.now();
			const nextRuntime: AgentRuntime = { ...runtime, state: nextState };
			if (nextState === "running" && !runtime.startedAt) {
				nextRuntime.startedAt = timestamp;
			}
			if ((nextState === "completed" || nextState === "failed") && !runtime.completedAt) {
				nextRuntime.completedAt = timestamp;
			}
			runtimes.set(agentId, nextRuntime);
			eventBus.enqueue(
				FLUID_EVENT_CHANNEL,
				{
					type: "agent_state_change",
					agentId,
					state: nextState,
					result: nextRuntime.result,
					error: nextRuntime.error,
					startedAt: nextRuntime.startedAt,
					completedAt: nextRuntime.completedAt,
				},
				Priority.P1,
			);
		}
		if (!executionCompleteEmitted && isTodoTerminal(nextPhases)) {
			executionCompleteEmitted = true;
			eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "execution_complete", results: new Map(runtimes) }, Priority.P1);
		}
	};
	const unsubscribeTodo = eventBus.subscribe("todo:change", raw => {
		const nextPhases = (raw as { phases?: TodoPhase[] }).phases;
		if (!nextPhases) return;
		syncRuntimeStates(cloneTodoPhases(nextPhases));
	});
	const abortExecution = (): void => {
		void session.abort().catch(error => {
			logger.error("Fluid execution abort failed", { error: String(error) });
		});
	};
	if (signal) {
		signal.addEventListener("abort", abortExecution, { once: true });
	}
	try {
		eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_complete", plan }, Priority.P1);
		session.setTodoPhases(phases, { reset: true });
		eventBus.emit("todo:change", { phases });
		await session.prompt(buildExecutionPrompt(plan), { synthetic: true });
		if (signal?.aborted) {
			emitExecutionCancelled(eventBus, signal);
			return undefined;
		}
		const latestPhases = cloneTodoPhases(session.getTodoPhases());
		syncRuntimeStates(latestPhases);
		if (!executionCompleteEmitted) {
			eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "execution_complete", results: new Map(runtimes) }, Priority.P1);
		}
		await eventBus.drain();
		return { runtimes: new Map(runtimes), taskIdByAgentId };
	} catch (err) {
		if (signal?.aborted) {
			emitExecutionCancelled(eventBus, signal);
			return undefined;
		}
		logger.error("Fluid plan execution failed", { error: String(err) });
		emitPlanError(eventBus, err);
		return undefined;
	} finally {
		unsubscribeTodo();
		if (signal) {
			signal.removeEventListener("abort", abortExecution);
		}
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
	critique?: string,
): Promise<FluidPlan | undefined> {
	const systemPrompt = renderPromptTemplate(fluidPlannerPrompt, { cwd });

	const agent: AgentDefinition = {
		name: "fluid-planner",
		description: "Decomposes user intent into a DAG of agent tasks",
		systemPrompt,
		source: "bundled",
		tools: fastPlan ? [] : ["read", "grep", "find", "lsp"],
	};

	const planningTask = critique
		? renderPromptTemplate(fluidPlannerRetryPrompt, { userPrompt: prompt, critique })
		: prompt;
	let lastIntent = "";
	try {
		const result = await runSubprocess({
			cwd,
			agent,
			task: planningTask,
			assignment: planningTask,
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
 * Event loop: wait for QML user actions and dispatch them.
 * Exits when the shell window closes.
 */
async function processFluidEvents(
	session: AgentSession,
	eventBus: EventBus,
	bridge: QmlBridge,
	cwd: string,
	fastPlan: boolean,
	initialPrompt?: string,
): Promise<void> {
	let activeController: AbortController | null = null;
	let activeExecution: Promise<void> | null = null;
	let lastPlan: FluidPlan | undefined;
	let lastRuntimes: Map<string, AgentRuntime> | undefined;
	let lastPhases: TodoPhase[] | undefined;
	let lastTaskIdByAgentId: Map<string, string> | undefined;

	const startExecution = (prompt: string): void => {
		if (activeExecution) {
			return;
		}
		const controller = new AbortController();
		activeController = controller;
		activeExecution = executePlan(session, eventBus, prompt, cwd, fastPlan, controller.signal)
			.then(snapshot => {
				if (!snapshot) {
					return;
				}
				lastPlan = snapshot.plan;
				lastRuntimes = snapshot.results;
				lastPhases = snapshot.phases;
				lastTaskIdByAgentId = snapshot.taskIdByAgentId;
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
		if (!lastPlan || !lastRuntimes || !lastPhases || !lastTaskIdByAgentId) {
			emitPlanError(eventBus, "No prior fluid execution to retry");
			return;
		}

		const retryRoots = resolveRetryRoots(lastRuntimes, requestedAgentIds);
		if (retryRoots.length === 0) {
			emitPlanError(eventBus, "No failed agents available to retry");
			return;
		}

		// Map failed agent IDs to task IDs
		const failedTaskIds = new Set<string>();
		for (const agentId of retryRoots) {
			const taskId = lastTaskIdByAgentId.get(agentId);
			if (taskId) failedTaskIds.add(taskId);
		}

		// Compute full retry set: failed tasks + downstream dependents
		const retryTaskIds = computeRetryTaskIds(lastPhases, failedTaskIds);

		// Patch captured phases: reset retry tasks to pending, keep completed as-is
		const patchedPhases = cloneTodoPhases(lastPhases);
		for (const phase of patchedPhases) {
			for (const task of phase.tasks) {
				if (retryTaskIds.has(task.id)) {
					task.status = "pending";
				}
			}
		}
		promoteFirstRunnableTask(patchedPhases);

		const controller = new AbortController();
		activeController = controller;
		activeExecution = executeFluidPlan(session, eventBus, lastPlan, controller.signal, {
			phases: patchedPhases,
			taskIdByAgentId: lastTaskIdByAgentId,
		})
			.then(execResult => {
				if (!execResult) {
					return;
				}
				lastRuntimes = execResult.runtimes;
				lastPhases = cloneTodoPhases(session.getTodoPhases());
				lastTaskIdByAgentId = execResult.taskIdByAgentId;
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

/**
 * Given a set of failed task IDs, compute the full set of tasks that need to be
 * retried: the failed tasks plus all transitive dependents (tasks blocked by them).
 */
export function computeRetryTaskIds(phases: TodoPhase[], failedTaskIds: Set<string>): Set<string> {
	const retrySet = new Set(failedTaskIds);
	const allTasks = phases.flatMap(phase => phase.tasks);
	const queue = [...failedTaskIds];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const task of allTasks) {
			if (retrySet.has(task.id)) continue;
			if (task.blockers?.includes(current)) {
				retrySet.add(task.id);
				queue.push(task.id);
			}
		}
	}
	return retrySet;
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
