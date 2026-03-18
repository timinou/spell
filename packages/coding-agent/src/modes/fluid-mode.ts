/**
 * Fluid canvas mode: Decomposes a prompt into a DAG of agent tasks,
 * executes them reactively via a queue-based scheduler, and streams
 * live output to QML panels.
 */
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";

export interface FluidModeOptions {
	initialMessage?: string;
	eventBus?: EventBus;
	orchestratorManager?: CanvasOrchestratorManager;
}

export async function runFluidMode(_session: AgentSession, _options: FluidModeOptions = {}): Promise<void> {
	// Stub — replaced in PROJ-5 with full orchestrator wiring
	throw new Error("Fluid canvas mode is not yet implemented. Use --canvas chat for the existing QML shell.");
}
