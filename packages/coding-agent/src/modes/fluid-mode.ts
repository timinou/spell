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
import type { FluidAgentNode, FluidPlan } from "../orchestrators/fluid/types";
import { fluidPlanSchema } from "../orchestrators/fluid/plan-schema";
import fluidPlannerPrompt from "../prompts/agents/fluid-planner.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { runSubprocess } from "../task/executor";
import type { AgentDefinition, SingleResult } from "../task/types";
import { type EventBus, Priority } from "../utils/event-bus";
import { FLUID_EVENT_CHANNEL } from "../orchestrators/fluid/types";

export interface FluidModeOptions {
	initialMessage?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
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

	try {
		// If an initial message was provided, skip the input step
		if (options.initialMessage) {
			await executePlan(session, eventBus, bridge, options.initialMessage, cwd, concurrency, fastPlan);
		}

		// Event loop: wait for user prompt from QML, then plan and execute
		await processFluidEvents(session, eventBus, bridge, cwd, concurrency, fastPlan);
	} finally {
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
	bridge: QmlBridge,
	prompt: string,
	cwd: string,
	concurrency: number,
	fastPlan: boolean,
): Promise<void> {
	// Phase 1: Run the planning agent
	const plan = await runPlanningAgent(session, eventBus, prompt, cwd, fastPlan);
	if (!plan) return;

	// Phase 2: Execute the plan
	const orchestrator = new FluidOrchestrator({
		eventBus,
		cwd,
		concurrency,
		runAgent: (node, upstream) => runFluidAgent(session, eventBus, node, upstream, cwd),
	});

	const ac = new AbortController();

	try {
		const results = await orchestrator.execute(plan, ac.signal);

		// Emit canvas outputs for agents that declared them
		for (const [agentId, runtime] of results) {
			if (runtime.node.canvasOutput && runtime.result) {
				eventBus.enqueue(
					FLUID_EVENT_CHANNEL,
					{
						type: "canvas_output",
						agentId,
						outputType: runtime.node.canvasOutput.type,
						title: runtime.node.canvasOutput.title,
						content: runtime.result.output,
					},
					Priority.P1,
				);
			}
		}

		// Final drain to flush any pending events
		await eventBus.drain();
	} catch (err) {
		if (!ac.signal.aborted) {
			logger.error("Fluid plan execution failed", { error: String(err) });
			await bridge.sendMessage("fluid-shell", {
				type: "fluid:plan_error",
				error: err instanceof Error ? err.message : String(err),
			});
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
): Promise<FluidPlan | undefined> {
	const systemPrompt = renderPromptTemplate(fluidPlannerPrompt, { cwd });

	const agent: AgentDefinition = {
		name: "fluid-planner",
		description: "Decomposes user intent into a DAG of agent tasks",
		systemPrompt,
		source: "bundled",
		tools: fastPlan ? [] : ["read", "grep", "find", "lsp"],
	};

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
		});

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
): Promise<void> {
	while (true) {
		const events = await bridge.waitForEvent("fluid-shell", 600_000);
		for (const event of events) {
			if (!event.payload) continue;
			const { type } = event.payload as { type?: string };

			switch (type) {
				case "prompt": {
					const text = (event.payload as { text: string }).text;
					await executePlan(session, eventBus, bridge, text, cwd, concurrency, fastPlan);
					break;
				}
			}
		}

		// Check if shell was closed
		const shell = bridge.getWindow("fluid-shell");
		if (!shell || shell.state === "closed") {
			break;
		}
	}
}
