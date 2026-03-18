/**
 * PROJ-F integration test: Chat input interaction via simulated keyboard/mouse.
 * Exercises the type/press/click input simulation against ChatPanel's InputBar.
 * Verifies the full pipeline: focus → type → submit → bridge event.
 *
 * Uses observe()+clickId() for all interactions — selector-based click() does not
 * work in ChatPanelTestHarness because the TextEdit sits deep inside a child
 * component scope (InputBar.qml) which the C++ walkTree may not resolve via
 * the click selector path consistently in offscreen mode.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, type ObservationEntry, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/panels/ChatPanelTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("Chat Input Interaction", () => {
	const harness = new QmlTestHarness({ width: 900, height: 600 });

	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
		await harness.settle(200);
	});

	afterAll(async () => {
		await harness.teardown();
	});

	beforeEach(async () => {
		await harness.reset();
		await harness.settle(100);
	});

	/** Find the TextEdit element via observe and click it for focus. */
	async function focusInput(): Promise<void> {
		const elements = await harness.observe();
		const textEdit = elements.find(e => e.className.startsWith("QQuickTextEdit"));
		if (textEdit) {
			await harness.clickId(textEdit.id);
			await harness.settle();
		} else {
			// Fallback: click the Flickable that contains the TextEdit
			const flickable = elements.find(e => e.className.startsWith("QQuickFlickable"));
			if (!flickable) throw new Error("Neither TextEdit nor Flickable found via observe()");
			await harness.clickId(flickable.id);
			await harness.settle();
		}
	}

	/** Find a small button-sized MouseArea from observed elements. */
	function findSmallButton(elements: ObservationEntry[]): ObservationEntry | undefined {
		return elements.find(
			e => e.className.startsWith("QQuickMouseArea") && e.geometry.width <= 40 && e.geometry.height <= 40,
		);
	}

	it("typing text and pressing Return sends prompt event", async () => {
		await focusInput();

		await harness.type("hello world");
		await harness.settle();

		// Listen for the prompt bridge event before pressing Return
		const eventPromise = harness.waitForBridgeEvent(
			e =>
				e.type === "event" && (e as { type: "event"; payload: Record<string, unknown> }).payload?.type === "prompt",
			3000,
		);
		await harness.press("Return");

		const ev = await eventPromise;
		const payload = (ev as { type: "event"; payload: Record<string, unknown> }).payload;
		expect(payload.type).toBe("prompt");
		expect(payload.text).toBe("hello world");
	});

	it("clicking send button submits message", async () => {
		await focusInput();
		await harness.type("click test");
		await harness.settle();

		const eventPromise = harness.waitForBridgeEvent(
			e =>
				e.type === "event" && (e as { type: "event"; payload: Record<string, unknown> }).payload?.type === "prompt",
			3000,
		);

		// Find and click the send button (small MouseArea)
		const elements = await harness.observe();
		const sendButton = findSmallButton(elements);
		if (!sendButton) throw new Error("Send button not found via observe()");
		await harness.clickId(sendButton.id);

		const ev = await eventPromise;
		const payload = (ev as { type: "event"; payload: Record<string, unknown> }).payload;
		expect(payload.text).toBe("click test");
	});

	it("clicking abort button sends abort event", async () => {
		// Put ChatPanel into streaming state
		await harness.sendMessage({ type: "message_start", id: "m1", role: "assistant" });
		await harness.settle(100);

		const eventPromise = harness.waitForBridgeEvent(
			e =>
				e.type === "event" && (e as { type: "event"; payload: Record<string, unknown> }).payload?.type === "abort",
			3000,
		);

		// Abort button replaces send button during streaming
		const elements = await harness.observe();
		const abortButton = findSmallButton(elements);
		if (!abortButton) throw new Error("Abort button not found via observe()");
		await harness.clickId(abortButton.id);

		const ev = await eventPromise;
		const payload = (ev as { type: "event"; payload: Record<string, unknown> }).payload;
		expect(payload.type).toBe("abort");
	});

	it("pressing Return with empty input does not send", async () => {
		await focusInput();

		// Press Return with no text typed
		await harness.press("Return");
		await harness.settle(200);

		// No message should have been added to the model
		expect(await harness.query<number>("messageCount")).toBe(0);
	});
});
