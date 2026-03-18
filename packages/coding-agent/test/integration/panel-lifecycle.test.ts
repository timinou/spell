import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney, resetShell } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";
const DEFAULT_PANELS = [
	{ id: "chat", title: "Chat", icon: "\u25cf", path: "panels/ChatPanel.qml" },
	{ id: "dashboard", title: "Dashboard", icon: "\u25a0", path: "panels/DashboardPanel.qml" },
];

describe.skipIf(!isBridgeAvailable())("Panel Lifecycle", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(SHELL_QML, {
			props: { panels: DEFAULT_PANELS },
		});
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	beforeEach(async () => {
		await resetShell(journey);
	});

	it("panel switch preserves chat state", async () => {
		await journey.agentSends({ type: "message_start", id: "m1", role: "assistant" });
		await journey.agentSends({ type: "message_update", id: "m1", text: "hello" });
		await journey.agentSends({ type: "message_end", id: "m1" });
		const countBefore = await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count");
		expect(countBefore).toBe(1);

		await journey.switchPanel("dashboard");
		await journey.switchPanel("chat");
		const countAfter = await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count");
		expect(countAfter).toBe(1);
	});

	describe("panel mutations", () => {
		let mutationJourney: QmlJourney;

		beforeAll(async () => {
			mutationJourney = await QmlJourney.launch(SHELL_QML, {
				props: { panels: DEFAULT_PANELS },
			});
			await mutationJourney.settle(100);
		});

		afterAll(async () => {
			await mutationJourney.teardown();
		});

		beforeEach(async () => {
			await resetShell(mutationJourney);
		});

		it("add_panel creates sidebar entry", async () => {
			const before = await mutationJourney.evaluate<number>("panelsModel.count");
			await mutationJourney.agentSends({
				type: "add_panel",
				id: "custom1",
				title: "Custom",
				icon: "+",
				path: "panels/DashboardPanel.qml",
			});
			const after = await mutationJourney.evaluate<number>("panelsModel.count");
			expect(after).toBe(before + 1);
		});

		it("add_panel with existing id replaces in-place", async () => {
			const before = await mutationJourney.evaluate<number>("panelsModel.count");
			await mutationJourney.agentSends({
				type: "add_panel",
				id: "replaceable",
				title: "V1",
				icon: "1",
				path: "panels/DashboardPanel.qml",
			});
			const afterFirst = await mutationJourney.evaluate<number>("panelsModel.count");
			expect(afterFirst).toBe(before + 1);

			await mutationJourney.agentSends({
				type: "add_panel",
				id: "replaceable",
				title: "V2",
				icon: "2",
				path: "panels/DashboardPanel.qml",
			});
			const afterSecond = await mutationJourney.evaluate<number>("panelsModel.count");
			expect(afterSecond).toBe(afterFirst);
		});

		it("remove_panel removes sidebar entry", async () => {
			await mutationJourney.agentSends({
				type: "add_panel",
				id: "removeme",
				title: "Remove",
				icon: "x",
				path: "panels/DashboardPanel.qml",
			});
			const before = await mutationJourney.evaluate<number>("panelsModel.count");

			await mutationJourney.agentSends({ type: "remove_panel", id: "removeme" });
			const after = await mutationJourney.evaluate<number>("panelsModel.count");
			expect(after).toBe(before - 1);
		});

		it("switching to added panel loads it", async () => {
			await mutationJourney.agentSends({
				type: "add_panel",
				id: "loaded",
				title: "Loaded",
				icon: "L",
				path: "panels/DashboardPanel.qml",
			});
			await mutationJourney.switchPanel("loaded");
			await mutationJourney.waitUntil(async () => {
				const hasItem = await mutationJourney.evaluate<boolean>("root.getActivePanelItem() !== null");
				return hasItem || null;
			}, 2000);
			const hasHandler = await mutationJourney.evaluate<boolean>(
				"typeof root.getActivePanelItem().handleMessage === 'function'",
			);
			expect(hasHandler).toBe(true);
		});
	});
});
