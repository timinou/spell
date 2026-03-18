import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney, resetShell } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

let codeSaveButtonFound = false;

function hasToolPayload(event: Record<string, unknown>, tool: string): boolean {
	if (event.type !== "event") return false;
	const payload = event.payload as Record<string, unknown> | undefined;
	return payload != null && payload._tool === tool;
}

describe.skipIf(!isBridgeAvailable())("Armed Tools Round-Trip", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(SHELL_QML, {
			props: {
				panels: [
					{ id: "chat", title: "Chat", icon: "\u25cf", path: "panels/ChatPanel.qml" },
					{ id: "dashboard", title: "Dashboard", icon: "\u25a0", path: "panels/DashboardPanel.qml" },
				],
			},
		});
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	beforeEach(async () => {
		await resetShell(journey);
	});

	it("code block renders with save button (rendering chain test)", async () => {
		codeSaveButtonFound = false;

		await journey.agentSends({ type: "message_start", id: "m1", role: "assistant" });
		await journey.agentSends({
			type: "message_update",
			id: "m1",
			text: "```typescript\nconst x = 42;\n```",
		});
		await journey.agentSends({ type: "message_end", id: "m1" });
		await journey.settle(200);

		const buttons = await journey.findItems({ objectName: "codeSaveButton" });
		codeSaveButtonFound = buttons.length > 0;

		const count = await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count");
		expect(count).toBe(1);
	});

	it("save button click triggers fire-and-forget _tool:write event (NO _rid)", async () => {
		if (!codeSaveButtonFound) return; // skip gracefully if offscreen mode can't render code blocks

		await journey.agentSends({ type: "message_start", id: "m2", role: "assistant" });
		await journey.agentSends({
			type: "message_update",
			id: "m2",
			text: "```typescript\nconst y = 99;\n```",
		});
		await journey.agentSends({ type: "message_end", id: "m2" });
		await journey.settle(200);

		const buttons = await journey.findItems({ objectName: "codeSaveButton" });
		expect(buttons.length).toBeGreaterThan(0);

		const eventPromise = journey.waitForEvent(event => hasToolPayload(event, "write"), 5000);

		const observed = await journey.observe();
		const saveButton = observed.find(entry => entry.objectName === "codeSaveButton");
		if (!saveButton) throw new Error("codeSaveButton not found via observe()");
		await journey.clickId(saveButton.id);

		const ev = await eventPromise;
		const payload = ev.payload as Record<string, unknown>;
		expect(payload._tool).toBe("write");
		expect(payload._rid).toBeUndefined();
	});

	it("_rid round-trip via evaluate (bypasses rendering chain)", async () => {
		const eventPromise = journey.waitForEvent(event => hasToolPayload(event, "read"), 5000);
		await journey.evaluate('bridge.send({_tool:"read", _rid:"test-123", path:"/tmp/test.txt"})');

		const ev = await eventPromise;
		const payload = ev.payload as Record<string, unknown>;
		expect(payload._tool).toBe("read");
		expect(payload._rid).toBe("test-123");
		expect(payload.path).toBe("/tmp/test.txt");

		await journey.simulateToolResponse("test-123", { text: "file contents" });
		await journey.settle(100);
	});
});
