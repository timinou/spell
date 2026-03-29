import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoopManager } from "../../src/loop/loop-manager";

function createSettings() {
	return {
		getModelRole(role: string) {
			return role === "review" ? "anthropic/claude-sonnet-4-6" : undefined;
		},
	};
}

describe("loop slash-command backend", () => {
	let cwd: string;
	let manager: LoopManager;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-manager-"));
		manager = new LoopManager({ cwd, settings: createSettings() });
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("/loop start creates a loop and status shows it", async () => {
		const start = await manager.handleCommand("start", ["demo"]);
		expect(start.ok).toBe(true);
		const loopId = start.loop?.id;
		expect(loopId).toBeDefined();

		const status = await manager.handleCommand("status", [String(loopId)]);
		expect(status.ok).toBe(true);
		expect(status.message).toContain(String(loopId));
		expect(status.message).toContain("state=planning");
	});

	it("/loop pause and /loop resume change state", async () => {
		const start = await manager.handleCommand("start", ["demo"]);
		const loopId = String(start.loop?.id);
		await manager.markDone(loopId);

		const paused = await manager.handleCommand("pause", [loopId]);
		expect(paused.message).toContain("Paused");
		expect(manager.getLoop(loopId).state).toBe("paused");

		const resumed = await manager.handleCommand("resume", [loopId]);
		expect(resumed.message).toContain("Resumed");
		expect(manager.getLoop(loopId).state).toBe("iterating");
	});

	it("/loop list reports all registered loops", async () => {
		await manager.handleCommand("start", ["one"]);
		await manager.handleCommand("start", ["two"]);
		const list = await manager.handleCommand("list", []);
		expect(list.ok).toBe(true);
		expect(list.message).toContain("one");
		expect(list.message).toContain("two");
	});
});
