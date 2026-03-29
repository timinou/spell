import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoopKernel } from "../../src/loop/kernel";
import { loadLoopState, saveLoopState } from "../../src/loop/persistence/checkpoint";
import { appendLoopEvent, readLoopEvents, replayLoopEvents } from "../../src/loop/persistence/event-log";
import { readLoopOrgState, syncLoopOrgItem } from "../../src/loop/persistence/org-sync";
import { reconcileLoopState } from "../../src/loop/persistence/reconcile";
import { restoreLoopSnapshots } from "../../src/loop/persistence/session-hooks";

describe("loop persistence", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-persist-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("round-trips checkpoints and replays event logs", async () => {
		const events: unknown[] = [];
		const kernel = new LoopKernel({ onEvent: event => events.push(event) });
		let loop = kernel.start({ name: "persisted", taskContent: "Task" });
		loop = kernel.done(loop.id);
		loop = kernel.done(loop.id, { summary: "iteration complete", changedFiles: ["src/index.ts"] });
		await saveLoopState(cwd, loop);
		const restored = await loadLoopState(cwd, loop.id);
		expect(restored?.state).toBe(loop.state);

		for (const event of events as never[]) {
			await appendLoopEvent(cwd, event, loop);
		}
		const readBack = await readLoopEvents(cwd, loop.id);
		expect(readBack.length).toBe((events as unknown[]).length);
		expect(replayLoopEvents(readBack)?.iteration).toBe(loop.iteration);
	});

	it("syncs org state and lets org win during reconciliation", async () => {
		const kernel = new LoopKernel();
		const loop = kernel.start({ name: "org-state", taskContent: "Task" });
		await syncLoopOrgItem(cwd, loop);
		expect((await readLoopOrgState(cwd, loop.id))?.state).toBe("planning");
		await Bun.write(
			path.join(cwd, "!tasks", "projects", `${loop.id}.org`),
			`#+TITLE: Loop\n#+STATE: BLOCKED\n#+CUSTOM_ID: ${loop.id}\n#+EFFORT: 1h\n#+PRIORITY: #B\n#+LAYER: backend\n#+LOOP_STATE: paused\n\nBody\n`,
		);
		const reconciled = await reconcileLoopState(cwd, loop);
		expect(reconciled.state).toBe("paused");
	});

	it("restores persisted loops on session resume", async () => {
		const kernel = new LoopKernel();
		const loop = kernel.start({ name: "resume" });
		await saveLoopState(cwd, loop);
		await syncLoopOrgItem(cwd, loop);
		const restored = await restoreLoopSnapshots(cwd);
		expect(restored.map(item => item.id)).toContain(loop.id);
	});
});
