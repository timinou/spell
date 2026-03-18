import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney, resetShell } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Shell Message Routing", () => {
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

	it("routes message_start/update/end to active chat panel", async () => {
		await journey.agentSends({ type: "message_start", id: "m1", role: "assistant" });
		await journey.agentSends({ type: "message_update", id: "m1", text: "hello world" });
		await journey.agentSends({ type: "message_end", id: "m1" });

		const count = await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count");
		expect(count).toBe(1);
		const text = await journey.evaluate<string>("root.getActivePanelItem().messagesModel.get(0).text");
		expect(text).toBe("hello world");
	});

	it("routes dashboard_update to active dashboard", async () => {
		await journey.switchPanel("dashboard");
		await journey.agentSends({ type: "dashboard_update", agent: { status: "busy" }, queue: { p1: 5 } });

		expect(await journey.panelProperty<string>("agentStatus")).toBe("busy");
		expect(await journey.panelProperty<number>("queueP1")).toBe(5);
	});

	it("queues dashboard_update for inactive dashboard, flushes on switch", async () => {
		expect(await journey.evaluate<number>("root.activePanelIndex")).toBe(0);
		await journey.agentSends({ type: "dashboard_update", agent: { status: "blocked" } });

		await journey.switchPanel("dashboard");
		await journey.waitUntil(async () => {
			const ready = await journey.evaluate<boolean>(
				"root.getActivePanelItem() !== null && typeof root.getActivePanelItem().agentStatus !== 'undefined'",
			);
			return ready || null;
		}, 2000);

		expect(await journey.panelProperty<string>("agentStatus")).toBe("blocked");
	});

	it("last-write-wins: only final queued update survives", async () => {
		await journey.agentSends({ type: "dashboard_update", agent: { status: "first" } });
		await journey.agentSends({ type: "dashboard_update", agent: { status: "second" } });
		await journey.agentSends({ type: "dashboard_update", agent: { status: "final" } });

		await journey.switchPanel("dashboard");
		await journey.waitUntil(async () => {
			const ready = await journey.evaluate<boolean>(
				"root.getActivePanelItem() !== null && typeof root.getActivePanelItem().agentStatus !== 'undefined'",
			);
			return ready || null;
		}, 2000);

		expect(await journey.panelProperty<string>("agentStatus")).toBe("final");
	});

	it("non-dashboard message to inactive panel is silently dropped", async () => {
		await journey.switchPanel("dashboard");
		await journey.agentSends({ type: "message_start", id: "m2", role: "assistant", panelId: "chat" });
		await journey.agentSends({ type: "message_update", id: "m2", text: "dropped", panelId: "chat" });

		await journey.switchPanel("chat");
		await journey.waitUntil(async () => {
			const ready = await journey.evaluate<boolean>(
				"root.getActivePanelItem() !== null && typeof root.getActivePanelItem().messagesModel !== 'undefined'",
			);
			return ready || null;
		}, 2000);

		expect(await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count")).toBe(0);
	});

	it("messages without panelId go to active panel", async () => {
		await journey.agentSends({ type: "message_start", id: "m3", role: "assistant" });

		expect(await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count")).toBe(1);
	});

	it("malformed messages are silently ignored", async () => {
		await journey.agentSends({});
		await journey.agentSends({ type: "nonexistent_type" });
		await journey.agentSends({ foo: "bar" });
		await journey.agentSends({ type: "message_start", id: "m4", role: "assistant" });

		expect(await journey.evaluate<number>("root.getActivePanelItem().messagesModel.count")).toBe(1);
	});
});
