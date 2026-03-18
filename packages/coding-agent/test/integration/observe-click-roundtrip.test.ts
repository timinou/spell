/**
 * PROJ-F integration test: observe() + clickId() round-trip contract.
 * Verifies the full pipeline: observe returns entries with valid geometry,
 * clickId succeeds with valid ids, and error paths work correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Observe + ClickId Round-Trip", () => {
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

	it("observe returns entries with valid geometry", async () => {
		const entries = await journey.observe();
		expect(entries.length).toBeGreaterThan(0);

		for (const entry of entries) {
			expect(entry.id).toBeGreaterThan(0);
			expect(entry.geometry.width).toBeGreaterThan(0);
			expect(entry.geometry.height).toBeGreaterThan(0);
			expect(entry.visible).toBe(true);
			expect(typeof entry.className).toBe("string");
		}
	});

	it("clickId with valid id succeeds", async () => {
		const entries = await journey.observe();
		const target = entries[0];
		// Should not throw
		await journey.clickId(target.id);
	});

	it("clickId with invalid id throws", async () => {
		// Must observe first so the observation cache exists
		await journey.observe();
		await expect(journey.clickId(99999)).rejects.toThrow(/No observed element with id 99999/);
	});

	it("clickId without prior observe throws", async () => {
		// Create a fresh journey to guarantee no prior observation
		const fresh = await QmlJourney.launch(SHELL_QML, {
			props: {
				panels: [{ id: "chat", title: "Chat", icon: "\u25cf", path: "panels/ChatPanel.qml" }],
			},
		});
		try {
			await expect(fresh.clickId(1)).rejects.toThrow(/observe\(\)/);
		} finally {
			await fresh.teardown();
		}
	});

	it("multiple observe calls return fresh results", async () => {
		const first = await journey.observe();
		const second = await journey.observe();

		// Both should return valid entries (ids are re-assigned each call)
		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);

		// Ids from second observation should be valid for clickId
		await journey.clickId(second[0].id);
	});
});
