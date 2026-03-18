import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney, resetShell } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Shell Chat Input", () => {
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

	it("typing and pressing Return emits prompt event through shell", async () => {
		const prompt = await journey.submitPrompt("hello from shell");
		expect(prompt.type).toBe("prompt");
		expect(prompt.text).toBe("hello from shell");
	});

	it("abort button emits abort event during streaming", async () => {
		await journey.agentSends({ type: "message_start", id: "m1", role: "assistant" });
		await journey.settle(100);

		const eventPromise = journey.waitForEvent(
			e =>
				e.type === "event" &&
				typeof e.payload === "object" &&
				e.payload !== null &&
				"type" in e.payload &&
				(e.payload as { type: unknown }).type === "abort",
			5000,
		);

		const elements = await journey.observe();
		const abortButton = elements.find(
			e => e.className.startsWith("QQuickMouseArea") && e.geometry.width <= 40 && e.geometry.height <= 40,
		);
		if (!abortButton) {
			throw new Error("Abort button not found via observe(); expected small MouseArea in streaming state");
		}
		await journey.clickId(abortButton.id);

		const ev = await eventPromise;
		expect((ev.payload as { type: unknown }).type).toBe("abort");
	});
});
