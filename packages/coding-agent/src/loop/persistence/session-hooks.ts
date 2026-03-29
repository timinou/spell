import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { LoopSnapshot } from "../types";
import { loadLoopState } from "./checkpoint";
import { readLoopEvents, replayLoopEvents } from "./event-log";
import { reconcileLoopState } from "./reconcile";

export async function restoreLoopSnapshots(cwd: string): Promise<LoopSnapshot[]> {
	const loopsDir = `${cwd}/.local/!tracks/loops`;
	let entries: string[];
	try {
		entries = await fs.readdir(loopsDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const restored: LoopSnapshot[] = [];
	for (const loopId of entries) {
		let snapshot = await loadLoopState(cwd, loopId);
		if (!snapshot) {
			const replayed = replayLoopEvents(await readLoopEvents(cwd, loopId));
			if (replayed) snapshot = replayed;
		}
		if (!snapshot) continue;
		restored.push(await reconcileLoopState(cwd, snapshot));
	}
	return restored;
}
