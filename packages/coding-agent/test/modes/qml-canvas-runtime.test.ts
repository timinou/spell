import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/CanvasTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("Canvas Runtime Integration", () => {
	const harness = new QmlTestHarness();

	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
	});

	afterAll(async () => {
		await harness.teardown();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	// ── Helpers ───────────────────────────────────────────────────────────────

	const block = (id: string, type = "markdown", data: Record<string, unknown> = { text: "hello" }) => ({
		id,
		type,
		data,
	});

	// ── Protocol contracts ────────────────────────────────────────────────────

	it("starts with empty content model", async () => {
		expect(await harness.query<number>("blockCount")).toBe(0);
	});

	it("set replaces entire content model", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1"), block("b2"), block("b3")],
		});
		expect(await harness.query<number>("blockCount")).toBe(3);

		const b2 = await harness.query<Record<string, unknown>>("blockById?b2");
		expect(b2).toBeTruthy();
		expect(b2.id).toBe("b2");
	});

	it("append adds blocks without disturbing existing ones", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1")],
		});
		expect(await harness.query<number>("blockCount")).toBe(1);

		await harness.sendMessage({
			action: "append",
			content: [block("b2"), block("b3")],
		});
		expect(await harness.query<number>("blockCount")).toBe(3);

		// Original block still present
		const b1 = await harness.query<Record<string, unknown>>("blockById?b1");
		expect(b1).toBeTruthy();
		expect(b1.id).toBe("b1");
	});

	it("remove by blockId deletes exactly that block", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1"), block("b2"), block("b3")],
		});
		expect(await harness.query<number>("blockCount")).toBe(3);

		await harness.sendMessage({ action: "remove", id: "b2" });
		expect(await harness.query<number>("blockCount")).toBe(2);

		// b2 gone, b1 and b3 remain
		expect(await harness.query("blockById?b2")).toBeNull();
		expect(await harness.query<Record<string, unknown>>("blockById?b1")).toBeTruthy();
		expect(await harness.query<Record<string, unknown>>("blockById?b3")).toBeTruthy();
	});

	it("set with empty content array clears all blocks", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1"), block("b2")],
		});
		expect(await harness.query<number>("blockCount")).toBe(2);

		await harness.sendMessage({ action: "set", content: [] });
		expect(await harness.query<number>("blockCount")).toBe(0);
	});

	// ── Ordering ──────────────────────────────────────────────────────────────

	it("set after set — last wins", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("first1"), block("first2")],
		});

		await harness.sendMessage({
			action: "set",
			content: [block("second1")],
		});

		expect(await harness.query<number>("blockCount")).toBe(1);
		const b = await harness.query<Record<string, unknown>>("blockById?second1");
		expect(b).toBeTruthy();
		expect(b.id).toBe("second1");

		// Old blocks gone
		expect(await harness.query("blockById?first1")).toBeNull();
	});

	it("append after set appends to the new content", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("s1")],
		});

		await harness.sendMessage({
			action: "append",
			content: [block("a1")],
		});

		expect(await harness.query<number>("blockCount")).toBe(2);
		expect(await harness.query<Record<string, unknown>>("blockById?s1")).toBeTruthy();
		expect(await harness.query<Record<string, unknown>>("blockById?a1")).toBeTruthy();
	});

	// ── Error resilience ──────────────────────────────────────────────────────

	it("remove with nonexistent blockId is a no-op", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1")],
		});
		expect(await harness.query<number>("blockCount")).toBe(1);

		await harness.sendMessage({ action: "remove", id: "nonexistent" });
		expect(await harness.query<number>("blockCount")).toBe(1);
	});

	it("set with unknown component type still creates a block", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("u1", "totally_unknown_widget", { foo: "bar" })],
		});
		expect(await harness.query<number>("blockCount")).toBe(1);
	});

	it("malformed payload (missing action field) does not crash canvas", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1")],
		});
		expect(await harness.query<number>("blockCount")).toBe(1);

		// Send payload without action — should be ignored
		await harness.sendMessage({ content: [block("b2")] } as any);
		expect(await harness.query<number>("blockCount")).toBe(1);
	});

	it("set without content field degrades gracefully", async () => {
		await harness.sendMessage({ action: "set" } as any);
		expect(await harness.query<number>("blockCount")).toBe(0);
	});

	// ── State sync ────────────────────────────────────────────────────────────

	it("sync action emits state bridge event", async () => {
		await harness.sendMessage({ action: "sync" });
		const stateEvent = await harness.waitForBridgeEvent(
			e => e.type === "event" && e.id === "test" && (e as any).payload?.action === "state",
			3000,
		);
		const payload = (stateEvent as any).payload as {
			action: string;
			blocks: unknown[];
			prompts: unknown[];
		};
		expect(payload.action).toBe("state");
		expect(Array.isArray(payload.blocks)).toBe(true);
		expect(Array.isArray(payload.prompts)).toBe(true);
	});

	it("after set with 3 blocks, sync returns exactly 3 blocks", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1"), block("b2"), block("b3")],
		});

		await harness.sendMessage({ action: "sync" });
		const stateEvent = await harness.waitForBridgeEvent(
			e => e.type === "event" && e.id === "test" && (e as any).payload?.action === "state",
			3000,
		);
		const payload = (stateEvent as any).payload as {
			action: string;
			blocks: unknown[];
			prompts: unknown[];
		};
		expect(payload.blocks).toHaveLength(3);
	});

	it("after remove, sync reflects the removal", async () => {
		await harness.sendMessage({
			action: "set",
			content: [block("b1"), block("b2"), block("b3")],
		});

		await harness.sendMessage({ action: "remove", id: "b2" });

		await harness.sendMessage({ action: "sync" });
		const stateEvent = await harness.waitForBridgeEvent(
			e => e.type === "event" && e.id === "test" && (e as any).payload?.action === "state",
			3000,
		);
		const payload = (stateEvent as any).payload as {
			action: string;
			blocks: Array<{ id: string }>;
			prompts: unknown[];
		};
		expect(payload.blocks).toHaveLength(2);
		const ids = payload.blocks.map(b => b.id);
		expect(ids).toContain("b1");
		expect(ids).toContain("b3");
		expect(ids).not.toContain("b2");
	});
});
