import type { LoopEvent } from "../contracts";
import type { LoopSnapshot } from "../types";

export function formatLoopTimeline(events: LoopEvent[]): string {
	if (events.length === 0) return "No loop events recorded.";
	return events.map(event => `${event.timestamp}\t${event.type}\t${JSON.stringify(event.payload)}`).join("\n");
}

export function formatLoopStatus(loop: LoopSnapshot): string {
	return `${loop.name} (${loop.id}) state=${loop.state} iteration=${loop.iteration}/${loop.maxIterations} budget=${loop.budgetStatus.elapsedMs}ms`;
}
