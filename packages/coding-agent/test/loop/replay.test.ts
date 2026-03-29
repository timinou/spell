import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoopKernel } from "../../src/loop/kernel";
import { appendLoopEvent, readLoopEvents } from "../../src/loop/persistence/event-log";
import { handleLoopDebugCommand, handleLoopReplayCommand } from "../../src/loop/replay/commands";

describe("loop replay", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-replay-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("replays final state and formats debug timelines", async () => {
		const snapshots: { event: any; snapshot: any }[] = [];
		const kernel = new LoopKernel({ onEvent: (event, snapshot) => snapshots.push({ event, snapshot }) });
		const loop = kernel.start({ name: "replay" });
		kernel.done(loop.id);
		const final = kernel.done(loop.id, { summary: "done" });
		for (const entry of snapshots) {
			await appendLoopEvent(cwd, entry.event, entry.snapshot);
		}
		expect(await handleLoopReplayCommand(cwd, loop.id)).toContain(`iteration=${final.iteration}`);
		expect(await handleLoopDebugCommand(cwd, loop.id, "state")).toContain("loop.state_changed");
		expect((await readLoopEvents(cwd, loop.id)).length).toBe(snapshots.length);
	});
});
