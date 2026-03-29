import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoopDashboardBridge } from "../../src/loop/dashboard-bridge";
import { LoopManager } from "../../src/loop/loop-manager";
import { EventBus } from "../../src/utils/event-bus";

describe("LoopDashboardBridge", () => {
	let cwd: string;
	let manager: LoopManager;
	let bridge: LoopDashboardBridge;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-dashboard-bridge-"));
		const eventBus = new EventBus();
		manager = new LoopManager({
			cwd,
			settings: { getModelRole: role => (role === "review" ? "anthropic/claude-sonnet-4-6" : undefined) },
			eventBus,
		});
		bridge = new LoopDashboardBridge(manager, eventBus);
	});

	afterEach(async () => {
		bridge.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("builds snapshots and applies control actions", async () => {
		const loop = await manager.start({ name: "dashboard", domains: [] });
		const snapshot = bridge.buildSnapshot(loop.id);
		expect(snapshot.loop.name).toBe("dashboard");
		await bridge.handleControl({ loopId: loop.id, action: "pause" });
		expect(manager.getLoop(loop.id).state).toBe("paused");
		await bridge.handleControl({ loopId: loop.id, action: "resume" });
		expect(manager.getLoop(loop.id).state).toBe("iterating");
	});
});
