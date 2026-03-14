import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";

const HARNESS_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/CanvasTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("Canvas Structured Input Integration", () => {
	const harness = new QmlTestHarness({ width: 900, height: 600 });

	beforeAll(async () => {
		await harness.setup(HARNESS_QML);
	});

	afterAll(async () => {
		await harness.teardown();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	// ── Prompt lifecycle ─────────────────────────────────────────────────────

	it("prompt message creates a prompt entry", async () => {
		await harness.sendMessage({
			action: "prompt",
			promptId: "p1",
			type: "radio",
			question: "Which option?",
			options: ["A", "B", "C"],
		});
		expect(await harness.query<number>("promptCount")).toBe(1);

		const p = await harness.query<Record<string, unknown>>("promptById?p1");
		expect(p).not.toBeNull();
		expect(p.question).toBe("Which option?");
		expect(p.answered).toBe(false);
	});

	it("multiple prompts with different ids coexist", async () => {
		await harness.sendMessage({ action: "prompt", promptId: "p1", type: "radio", question: "Q1", options: ["A"] });
		await harness.sendMessage({ action: "prompt", promptId: "p2", type: "radio", question: "Q2", options: ["B"] });
		expect(await harness.query<number>("promptCount")).toBe(2);
	});

	it("second prompt with same id replaces first", async () => {
		await harness.sendMessage({ action: "prompt", promptId: "p1", type: "radio", question: "Q1", options: ["A"] });
		await harness.sendMessage({ action: "prompt", promptId: "p1", type: "radio", question: "Q2", options: ["B"] });
		expect(await harness.query<number>("promptCount")).toBe(1);

		const p = await harness.query<Record<string, unknown>>("promptById?p1");
		expect(p.question).toBe("Q2");
	});

	// ── Prompt types ─────────────────────────────────────────────────────────

	it("text prompt type is created correctly", async () => {
		await harness.sendMessage({
			action: "prompt",
			promptId: "txt1",
			type: "text",
			question: "Enter name",
			options: [],
		});
		const p = await harness.query<Record<string, unknown>>("promptById?txt1");
		expect(p.type).toBe("text");
	});

	// ── Response protocol ────────────────────────────────────────────────────

	it("radio selection emits respond event", async () => {
		await harness.sendMessage({
			action: "prompt",
			promptId: "arch-1",
			type: "radio",
			question: "Pick arch",
			options: ["monolith", "microservices"],
		});

		// submitPromptResponse(promptId, value, promptIndex) — single prompt is at index 0
		await harness.evaluate("canvas.submitPromptResponse('arch-1', 'monolith', 0)");

		const ev = await harness.waitForBridgeEvent(
			e => e.type === "event" && (e as any).payload?.action === "respond",
			3000,
		);
		const payload = (ev as any).payload as { action: string; promptId: string; value: string };
		expect(payload.action).toBe("respond");
		expect(payload.promptId).toBe("arch-1");
		expect(payload.value).toBe("monolith");
	});

	it("prompt is marked answered after response", async () => {
		await harness.sendMessage({
			action: "prompt",
			promptId: "p1",
			type: "radio",
			question: "Q",
			options: ["X"],
		});

		await harness.evaluate("canvas.submitPromptResponse('p1', 'X', 0)");

		// Drain the bridge event
		await harness.waitForBridgeEvent(e => e.type === "event" && (e as any).payload?.action === "respond", 3000);

		const p = await harness.query<Record<string, unknown>>("promptById?p1");
		expect(p.answered).toBe(true);
	});

	// ── Armed tool protocol ──────────────────────────────────────────────────

	it("QML _tool invocation round-trip", async () => {
		// Emit a _tool event from QML via bridge.send and verify it arrives as a bridge event
		await harness.evaluate(
			"bridge.send({ _tool: 'write', _rid: 'r-1', path: '/tmp/canvas-test.txt', content: 'hello' })",
		);

		const ev = await harness.waitForBridgeEvent(
			e => e.type === "event" && typeof (e as any).payload?._tool === "string",
			3000,
		);
		expect((ev as any).payload._tool).toBe("write");
		expect((ev as any).payload._rid).toBe("r-1");
	});
});
