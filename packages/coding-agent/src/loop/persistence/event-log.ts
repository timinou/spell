import { isEnoent, logger } from "@spell/pi-utils";
import type { LoopEvent } from "../contracts";
import type { LoopSnapshot } from "../types";

function getEventLogPath(cwd: string, loopId: string): string {
	return `${cwd}/.local/!tracks/loops/${loopId}/events.ndjson`;
}

export async function appendLoopEvent(cwd: string, event: LoopEvent, snapshot: LoopSnapshot): Promise<void> {
	const payload =
		typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
	const line = JSON.stringify({ ...event, payload: { ...payload, snapshot } });
	try {
		let previous = "";
		try {
			previous = await Bun.file(getEventLogPath(cwd, event.loopId)).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await Bun.write(getEventLogPath(cwd, event.loopId), previous ? `${previous}${line}\n` : `${line}\n`);
	} catch (error) {
		logger.error("Failed to append loop event", { loopId: event.loopId, error: String(error) });
	}
}

export async function readLoopEvents(cwd: string, loopId: string): Promise<LoopEvent[]> {
	let text = "";
	try {
		text = await Bun.file(getEventLogPath(cwd, loopId)).text();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const lines = text.split("\n");
	const events: LoopEvent[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as LoopEvent);
		} catch (error) {
			logger.warn("Skipping invalid loop event log line", { loopId, error: String(error) });
		}
	}
	return events;
}

export function replayLoopEvents(events: LoopEvent[], atIteration?: number): LoopSnapshot | undefined {
	let current: LoopSnapshot | undefined;
	for (const event of events) {
		const snapshot = (event.payload as { snapshot?: LoopSnapshot }).snapshot;
		if (!snapshot) continue;
		if (atIteration !== undefined && snapshot.iteration > atIteration) {
			break;
		}
		current = structuredClone(snapshot);
	}
	return current;
}
