import { readLoopEvents, replayLoopEvents } from "../persistence/event-log";
import type { LoopSnapshot } from "../types";

export async function replayLoopState(
	cwd: string,
	loopId: string,
	atIteration?: number,
): Promise<LoopSnapshot | undefined> {
	return replayLoopEvents(await readLoopEvents(cwd, loopId), atIteration);
}
