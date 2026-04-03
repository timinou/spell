import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSharedSyncState } from "../src/shared-sync-state";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async dir => {
			tempDirs.delete(dir);
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

describe("shared sync state", () => {
	it("loads rsync-friendly snapshot folders", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "qml-sync-"));
		tempDirs.add(rootDir);
		for (const folder of ["approvals", "checkpoints", "downstream-jobs", "audit", "goals"]) {
			await fs.mkdir(path.join(rootDir, folder), { recursive: true });
		}
		await Bun.write(path.join(rootDir, "approvals", "index.json"), JSON.stringify([{ id: "approval-1" }]));
		await Bun.write(
			path.join(rootDir, "approvals", "approval-1.json"),
			JSON.stringify({ id: "approval-1", title: "Approval" }),
		);
		await Bun.write(path.join(rootDir, "checkpoints", "index.json"), JSON.stringify([]));
		await Bun.write(path.join(rootDir, "downstream-jobs", "index.json"), JSON.stringify([]));
		await Bun.write(path.join(rootDir, "audit", "index.json"), JSON.stringify([]));
		await Bun.write(path.join(rootDir, "goals", "index.json"), JSON.stringify([{ id: "discover" }]));
		await Bun.write(
			path.join(rootDir, "goals", "discover.json"),
			JSON.stringify({ id: "discover", data: { state: "pending" } }),
		);

		const state = await loadSharedSyncState(rootDir);
		expect(state.approvals).toEqual([{ id: "approval-1", title: "Approval" }]);
		expect(state.goals).toEqual([{ id: "discover", data: { state: "pending" } }]);
	});
});
