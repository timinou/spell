import { readLoopEvents } from "../persistence/event-log";
import { formatLoopStatus, formatLoopTimeline } from "./formatter";
import { replayLoopState } from "./replayer";

export async function handleLoopReplayCommand(cwd: string, loopId: string, atIteration?: number): Promise<string> {
	const snapshot = await replayLoopState(cwd, loopId, atIteration);
	if (!snapshot) return `Loop ${loopId} has no replayable state.`;
	return formatLoopStatus(snapshot);
}

export async function handleLoopDebugCommand(cwd: string, loopId: string, typeFilter?: string): Promise<string> {
	const events = await readLoopEvents(cwd, loopId);
	const filtered = typeFilter ? events.filter(event => event.type.includes(typeFilter)) : events;
	return formatLoopTimeline(filtered);
}
