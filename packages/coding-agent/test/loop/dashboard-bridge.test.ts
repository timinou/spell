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
	let eventBus: EventBus;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-dashboard-bridge-"));
		eventBus = new EventBus();
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

	it("subscribe emits initial snapshot to callback", async () => {
		const loop = await manager.start({ name: "sub-test", domains: [] });
		const payloads: unknown[] = [];
		bridge.subscribe(loop.id, payload => payloads.push(payload));
		// Should receive initial snapshot immediately
		expect(payloads).toHaveLength(1);
	});

	it("dispose unsubscribes from EventBus channels", async () => {
		const loop = await manager.start({ name: "dispose-test", domains: [] });
		let callCount = 0;
		bridge.subscribe(loop.id, () => {
			callCount++;
		});
		const beforeDispose = callCount;
		bridge.dispose();
		// Emit on the loop channel after dispose - should not increment
		eventBus.emit(`loop:${loop.id}:state`, {});
		expect(callCount).toBe(beforeDispose);
	});

	it("registerPanel emits shell:add_panel event", async () => {
		const panels: unknown[] = [];
		eventBus.subscribe("shell:add_panel", data => {
			panels.push(data);
		});
		const loop = await manager.start({ name: "panel-test", domains: [] });
		// start() calls registerPanel internally
		expect(panels.length).toBeGreaterThanOrEqual(1);
		const panel = panels[0] as Record<string, unknown>;
		expect(panel.id).toBe(`loop-dashboard-${loop.id}`);
		expect(panel.loopId).toBe(loop.id);
	});

	it("kill emits shell:remove_panel event", async () => {
		const removals: unknown[] = [];
		eventBus.subscribe("shell:remove_panel", data => {
			removals.push(data);
		});
		const loop = await manager.start({ name: "kill-panel", domains: [] });
		await manager.kill(loop.id);
		expect(removals.length).toBeGreaterThanOrEqual(1);
		const removal = removals[0] as Record<string, unknown>;
		expect(removal.id).toBe(`loop-dashboard-${loop.id}`);
	});
});
