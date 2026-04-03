import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { emitWorkflowSyncSnapshot, groupWorkflowItems } from "../../src/workflow";
import { createApprovalInput, createCheckpointInput, createWorkflowEngine } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async dir => {
			tempDirs.delete(dir);
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

describe("workflow sync snapshot emitter", () => {
	it("emits stable folder indexes and per-record json files", async () => {
		const engine = createWorkflowEngine();
		const approval = engine.createApproval(createApprovalInput());
		const checkpoint = engine.createCheckpoint(createCheckpointInput());
		const { approvals, checkpoints } = groupWorkflowItems(engine.listItems());
		const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-sync-"));
		tempDirs.add(snapshotDir);

		await emitWorkflowSyncSnapshot(snapshotDir, {
			approvals,
			checkpoints,
			downstreamJobs: engine.listJobs(),
			audit: engine.listAudit(),
			goals: [{ id: "goal-discovery", data: { state: "pending" } }],
		});

		expect(JSON.parse(await Bun.file(path.join(snapshotDir, "index.json")).text())).toEqual({
			approvals: [approval.id],
			checkpoints: [checkpoint.id],
			downstreamJobs: [],
			audit: engine.listAudit().map(entry => entry.id),
			goals: ["goal-discovery"],
		});
		expect(await Bun.file(path.join(snapshotDir, "approvals", `${approval.id}.json`)).json()).toMatchObject({
			id: approval.id,
			title: "Approve article",
		});
		expect(await Bun.file(path.join(snapshotDir, "goals", "goal-discovery.json")).json()).toEqual({
			id: "goal-discovery",
			data: { state: "pending" },
		});
	});
});
