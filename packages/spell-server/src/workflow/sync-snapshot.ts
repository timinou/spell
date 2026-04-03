import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	WorkflowApprovalItem,
	WorkflowAuditEntry,
	WorkflowCheckpointItem,
	WorkflowDownstreamJob,
	WorkflowItem,
} from "./types";

export interface WorkflowGoalSnapshot {
	id: string;
	data: Record<string, unknown>;
}

export interface WorkflowSyncSnapshot {
	approvals: WorkflowApprovalItem[];
	checkpoints: WorkflowCheckpointItem[];
	downstreamJobs: WorkflowDownstreamJob[];
	audit: WorkflowAuditEntry[];
	goals?: WorkflowGoalSnapshot[];
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function emitCollection<T extends { id: string }>(
	rootDir: string,
	folderName: string,
	items: T[],
): Promise<string[]> {
	const folderPath = path.join(rootDir, folderName);
	await fs.mkdir(folderPath, { recursive: true });
	const written: string[] = [];
	const index = items.map(item => ({ id: item.id }));
	await writeJson(path.join(folderPath, "index.json"), index);
	written.push(path.join(folderPath, "index.json"));
	for (const item of items) {
		const itemPath = path.join(folderPath, `${item.id}.json`);
		await writeJson(itemPath, item);
		written.push(itemPath);
	}
	return written;
}

export async function emitWorkflowSyncSnapshot(rootDir: string, snapshot: WorkflowSyncSnapshot): Promise<string[]> {
	await fs.rm(rootDir, { recursive: true, force: true });
	await fs.mkdir(rootDir, { recursive: true });
	const written: string[] = [];
	written.push(...(await emitCollection(rootDir, "approvals", snapshot.approvals)));
	written.push(...(await emitCollection(rootDir, "checkpoints", snapshot.checkpoints)));
	written.push(...(await emitCollection(rootDir, "downstream-jobs", snapshot.downstreamJobs)));
	written.push(...(await emitCollection(rootDir, "audit", snapshot.audit)));
	written.push(...(await emitCollection(rootDir, "goals", snapshot.goals ?? [])));
	await writeJson(path.join(rootDir, "index.json"), {
		approvals: snapshot.approvals.map(item => item.id),
		checkpoints: snapshot.checkpoints.map(item => item.id),
		downstreamJobs: snapshot.downstreamJobs.map(job => job.id),
		audit: snapshot.audit.map(entry => entry.id),
		goals: (snapshot.goals ?? []).map(goal => goal.id),
	});
	written.push(path.join(rootDir, "index.json"));
	return written;
}

export function groupWorkflowItems(items: WorkflowItem[]): {
	approvals: WorkflowApprovalItem[];
	checkpoints: WorkflowCheckpointItem[];
} {
	const approvals: WorkflowApprovalItem[] = [];
	const checkpoints: WorkflowCheckpointItem[] = [];
	for (const item of items) {
		if (item.kind === "approval") approvals.push(item);
		if (item.kind === "checkpoint") checkpoints.push(item);
	}
	return { approvals, checkpoints };
}
