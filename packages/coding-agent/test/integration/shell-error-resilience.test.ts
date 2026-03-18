import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Shell Error Resilience", () => {
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

	it("malformed messages do not crash the shell", async () => {
		const malformedPayloads: unknown[] = [null, undefined, 42, "string", { type: null }, { type: "" }];
		for (const payload of malformedPayloads) {
			try {
				await journey.agentSends(payload as Record<string, unknown>);
			} catch {
				// Harness serialization may reject invalid values; shell must still remain functional.
			}
		}
		await journey.agentSends({ type: "completely_unknown_type" });

		await journey.agentSends({ type: "message_start", id: "survive", role: "assistant" });
		await journey.agentSends({ type: "message_update", id: "survive", text: "still alive" });
		await journey.agentSends({ type: "message_end", id: "survive" });

		await journey.waitUntil(async () => {
			const ready = await journey.evaluate<boolean>(
				"root.getActivePanelItem() !== null && typeof root.getActivePanelItem().messagesModel !== 'undefined'",
			);
			return ready || null;
		}, 2000);

		const count = await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count");
		expect(count).toBe(1);
		const text = await journey.evaluate<string>("root.getActivePanelItem().messagesModel.get(0).text");
		expect(text).toBe("still alive");
	});

	it("bad panel path triggers Loader error overlay", async () => {
		await journey.agentSends({
			type: "add_panel",
			id: "broken",
			title: "Broken",
			icon: "!",
			path: "panels/NonExistentPanel.qml",
		});
		await journey.switchPanel("broken");
		await journey.settle(200);

		await journey.expectText("Failed to load panel");
	});

	it("shell survives active panel removal", async () => {
		await journey.agentSends({
			type: "add_panel",
			id: "doomed",
			title: "Doomed",
			icon: "x",
			path: "panels/DashboardPanel.qml",
		});
		await journey.switchPanel("doomed");
		await journey.settle(100);

		await journey.agentSends({ type: "remove_panel", id: "doomed" });
		await journey.settle(100);

		const idx = await journey.evaluate<number>("root.activePanelIndex");
		expect(idx).toBe(0);

		const panelCount = await journey.evaluate<number>("panelsModel.count");
		expect(panelCount).toBeGreaterThanOrEqual(2);
	});
});
