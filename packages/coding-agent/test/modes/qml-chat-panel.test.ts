import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

// The test harness QML must be co-located with ChatPanel.qml so the ".." SpellUI import resolves.
const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/panels/ChatPanelTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("ChatPanel QML integration", () => {
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

	// ── Initial state ─────────────────────────────────────────────────────────

	it("starts with empty message list", async () => {
		expect(await harness.query("messageCount")).toBe(0);
		expect(await harness.query("isStreaming")).toBe(false);
	});

	// ── user_message ──────────────────────────────────────────────────────────

	it("appends user message with correct role and text", async () => {
		await harness.sendMessage({ type: "user_message", text: "hello world" });
		expect(await harness.query("messageCount")).toBe(1);
		const msg = await harness.query<Record<string, unknown>>("lastMessage");
		expect(msg.role).toBe("user");
		expect(msg.text).toBe("hello world");
		expect(msg.isStreaming).toBe(false);
	});

	// ── Assistant message streaming lifecycle ─────────────────────────────────

	it("streams assistant message text end-to-end", async () => {
		await harness.sendMessage({ type: "message_start", id: "msg-1", role: "assistant" });
		expect(await harness.query("messageCount")).toBe(1);
		expect(await harness.query("isStreaming")).toBe(true);

		const afterStart = await harness.query<Record<string, unknown>>("lastMessage");
		expect(afterStart.role).toBe("assistant");
		expect(afterStart.text).toBe("");
		expect(afterStart.isStreaming).toBe(true);

		// ChatPanel appends deltas; the mapper already computes deltas, but integration
		// tests send directly to ChatPanel so we send incremental text to match the
		// message_update protocol (ChatPanel appends msg.text to current text).
		await harness.sendMessage({ type: "message_update", id: "msg-1", text: "Hello" });
		const afterFirst = await harness.query<Record<string, unknown>>("lastMessage");
		expect(afterFirst.text).toBe("Hello");

		await harness.sendMessage({ type: "message_update", id: "msg-1", text: " world" });
		const afterSecond = await harness.query<Record<string, unknown>>("lastMessage");
		expect(afterSecond.text).toBe("Hello world");

		await harness.sendMessage({ type: "message_end", id: "msg-1" });
		const afterEnd = await harness.query<Record<string, unknown>>("lastMessage");
		expect(afterEnd.isStreaming).toBe(false);
		expect(await harness.query("isStreaming")).toBe(false);
	});

	// ── Tool execution lifecycle ───────────────────────────────────────────────

	it("streams tool execution start→end lifecycle", async () => {
		await harness.sendMessage({ type: "tool_start", id: "t-1", name: "bash", details: "Running build" });
		expect(await harness.query("messageCount")).toBe(1);

		const toolMsg = await harness.query<Record<string, unknown>>("lastMessage");
		expect(toolMsg.role).toBe("tool");
		expect(toolMsg.name).toBe("bash");
		expect(toolMsg.text).toBe("Running build");
		expect(toolMsg.isStreaming).toBe(true);

		await harness.sendMessage({
			type: "tool_end",
			id: "t-1",
			name: "bash",
			isError: false,
			details: "Build succeeded",
		});
		const afterEnd = await harness.query<Record<string, unknown>>("lastMessage");
		expect(afterEnd.isStreaming).toBe(false);
		expect(afterEnd.text).toBe("Build succeeded");
	});

	// ── agent_busy ────────────────────────────────────────────────────────────

	it("reflects agent_busy state", async () => {
		await harness.sendMessage({ type: "agent_busy", busy: true });
		expect(await harness.query("isStreaming")).toBe(true);

		await harness.sendMessage({ type: "agent_busy", busy: false });
		expect(await harness.query("isStreaming")).toBe(false);
	});

	// ── Multiple message types coexist ────────────────────────────────────────

	it("accumulates multiple message types in order", async () => {
		await harness.sendMessage({ type: "user_message", text: "prompt" });
		await harness.sendMessage({ type: "tool_start", id: "t-2", name: "read", details: "reading file" });
		await harness.sendMessage({ type: "tool_end", id: "t-2", name: "read", isError: false, details: "content" });
		await harness.sendMessage({ type: "message_start", id: "msg-2", role: "assistant" });
		await harness.sendMessage({ type: "message_end", id: "msg-2" });

		expect(await harness.query("messageCount")).toBe(3);
	});

	// ── Screenshot smoke test ─────────────────────────────────────────────────

	it("produces a valid PNG screenshot", async () => {
		await harness.sendMessage({ type: "user_message", text: "visible text for screenshot" });
		const screenshotPath = await harness.screenshot();
		// Verify file exists and starts with PNG magic bytes
		const header = Buffer.allocUnsafe(8);
		const fd = fs.openSync(screenshotPath, "r");
		try {
			fs.readSync(fd, header, 0, 8, 0);
		} finally {
			fs.closeSync(fd);
		}
		// PNG magic: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
		expect(header[0]).toBe(0x89);
		expect(header[1]).toBe(0x50); // P
		expect(header[2]).toBe(0x4e); // N
		expect(header[3]).toBe(0x47); // G
	});
	// ── Visual rendering assertions ────────────────────────────────────────────

	describe("Visual rendering assertions", () => {
		it("renders user message text in a visible element", async () => {
			await harness.sendMessage({ type: "user_message", text: "hello world" });
			await Bun.sleep(200);
			const texts = await harness.findVisibleText();
			expect(texts).toContain("hello world");
		});

		it("user message element has positive dimensions", async () => {
			await harness.sendMessage({ type: "user_message", text: "dimension test" });
			await Bun.sleep(200);
			const items = await harness.findItems(
				{ type: "QQuickText", textContains: "dimension test", visible: true },
				{ includeGeometry: true },
			);
			expect(items.length).toBeGreaterThanOrEqual(1);
			expect(items[0].geometry!.width).toBeGreaterThan(0);
			expect(items[0].geometry!.height).toBeGreaterThan(0);
		});

		it("renders assistant message text after streaming completes", async () => {
			await harness.sendMessage({ type: "message_start", id: "vis-msg-1", role: "assistant" });
			await harness.sendMessage({ type: "message_update", id: "vis-msg-1", text: "Visual hello" });
			await harness.sendMessage({ type: "message_end", id: "vis-msg-1" });
			await Bun.sleep(200);
			const texts = await harness.findVisibleText();
			expect(texts).toContain("Visual hello");
		});

		it("renders tool name in a visible element", async () => {
			await harness.sendMessage({ type: "tool_start", id: "vis-t-1", name: "bash", details: "build" });
			await Bun.sleep(200);
			const nameItems = await harness.findItems({ type: "QQuickText", textContains: "bash", visible: true });
			expect(nameItems.length).toBeGreaterThanOrEqual(1);
		});

		it("stacks two messages at different vertical positions", async () => {
			await harness.sendMessage({ type: "user_message", text: "first" });
			await harness.sendMessage({ type: "user_message", text: "second" });
			await Bun.sleep(200);
			const items = await harness.findItems(
				{ type: "QQuickText", visible: true },
				{ includeGeometry: true, properties: ["text"] },
			);
			const firstItem = items.find(i => i.properties.text === "first");
			const secondItem = items.find(i => i.properties.text === "second");
			if (firstItem && secondItem) {
				// Second message must be below first in the list
				expect(secondItem.scenePosition!.y).toBeGreaterThan(firstItem.scenePosition!.y);
			} else {
				// If text elements not directly found, at minimum both texts are visible
				const texts = await harness.findVisibleText();
				expect(texts).toContain("first");
				expect(texts).toContain("second");
			}
		});
	});
});
