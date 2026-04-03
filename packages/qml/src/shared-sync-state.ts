import * as path from "node:path";

export interface SharedSyncState<TGoal = Record<string, unknown>> {
	approvals: Array<Record<string, unknown>>;
	checkpoints: Array<Record<string, unknown>>;
	downstreamJobs: Array<Record<string, unknown>>;
	audit: Array<Record<string, unknown>>;
	goals: Array<{ id: string; data: TGoal }>;
}

async function readCollection<T>(rootDir: string, folderName: string): Promise<T[]> {
	const indexPath = path.join(rootDir, folderName, "index.json");
	const entries = (await Bun.file(indexPath).json()) as Array<{ id: string }>;
	return Promise.all(
		entries.map(async entry => Bun.file(path.join(rootDir, folderName, `${entry.id}.json`)).json() as Promise<T>),
	);
}

export async function loadSharedSyncState<TGoal = Record<string, unknown>>(
	rootDir: string,
): Promise<SharedSyncState<TGoal>> {
	return {
		approvals: await readCollection(rootDir, "approvals"),
		checkpoints: await readCollection(rootDir, "checkpoints"),
		downstreamJobs: await readCollection(rootDir, "downstream-jobs"),
		audit: await readCollection(rootDir, "audit"),
		goals: await readCollection(rootDir, "goals"),
	};
}
