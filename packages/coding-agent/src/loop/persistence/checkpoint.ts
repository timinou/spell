import { isEnoent, logger } from "@spell/pi-utils";
import { Value } from "@sinclair/typebox/value";
import { type IterationCheckpoint, IterationCheckpointSchema } from "../contracts";
import type { LoopSnapshot } from "../types";

interface PersistedLoopState {
	snapshot: LoopSnapshot;
	checkpoint: IterationCheckpoint;
}

function getLoopStatePath(cwd: string, loopId: string): string {
	return `${cwd}/.local/!tracks/loops/${loopId}/state.json`;
}

export function buildIterationCheckpoint(loop: LoopSnapshot): IterationCheckpoint {
	return {
		loopId: loop.id,
		iteration: loop.iteration,
		state: loop.state,
		timestamp: loop.updatedAt,
		taskFileHash: loop.taskFileHash,
		orgItemId: loop.orgItemId,
		childLoopIds: [...loop.childLoopIds],
		pendingGates: [...loop.pendingGates],
	};
}

export async function saveLoopState(cwd: string, loop: LoopSnapshot): Promise<void> {
	const checkpoint = buildIterationCheckpoint(loop);
	const payload: PersistedLoopState = { snapshot: loop, checkpoint };
	try {
		await Bun.write(getLoopStatePath(cwd, loop.id), JSON.stringify(payload, null, 2));
	} catch (error) {
		logger.error("Failed to persist loop checkpoint", { loopId: loop.id, error: String(error) });
	}
}

export async function loadLoopState(cwd: string, loopId: string): Promise<LoopSnapshot | undefined> {
	try {
		const payload = (await Bun.file(getLoopStatePath(cwd, loopId)).json()) as PersistedLoopState;
		if (!Value.Check(IterationCheckpointSchema, payload.checkpoint)) {
			throw new Error(`Invalid checkpoint shape for ${loopId}`);
		}
		return payload.snapshot;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}
