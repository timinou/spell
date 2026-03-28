import { describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const BROWSE_SHELL_QML = "BrowseShell.qml";

async function launchShell(): Promise<QmlJourney> {
	return QmlJourney.launch(BROWSE_SHELL_QML, {
		props: {
			model: "test-provider/test-model",
			settingsCategory: `browse-findings-panel-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
		},
		width: 1360,
		height: 900,
		settleMs: 100,
		assertTimeout: 5_000,
	});
}

describe.skipIf(!isBridgeAvailable())("Browse findings panel", () => {
	it("accumulates findings and shows them in the drawer", async () => {
		const journey = await launchShell();
		try {
			await journey.agentSends({
				type: "finding",
				id: "finding-1",
				url: "https://example.com/one",
				title: "First finding",
				excerpt: "First excerpt.",
				tags: ["alpha"],
				tabId: "research-1",
			});
			await journey.agentSends({
				type: "finding",
				id: "finding-2",
				url: "https://example.com/two",
				title: "Second finding",
				excerpt: "Second excerpt.",
				tags: ["beta"],
				tabId: "research-2",
			});

			await journey.click({ objectName: "findingsToggleButton", visible: true });
			await journey.waitUntil(async () => {
				return (await journey.evaluate<boolean>("root.findingsDrawerOpen")) || null;
			}, 5_000);

			expect(await journey.evaluate<number>("root.getFindingsPanelItem().findingCount()")).toBe(2);
			await journey.expectText("First finding");
			await journey.expectText("Second finding");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("sorts accumulated findings by domain", async () => {
		const journey = await launchShell();
		try {
			await journey.agentSends({
				type: "finding",
				id: "finding-1",
				url: "https://zeta.example.com/one",
				title: "Zeta finding",
				excerpt: "Zeta excerpt.",
				tags: [],
				tabId: "research-1",
			});
			await journey.agentSends({
				type: "finding",
				id: "finding-2",
				url: "https://alpha.example.com/two",
				title: "Alpha finding",
				excerpt: "Alpha excerpt.",
				tags: [],
				tabId: "research-2",
			});

			await journey.click({ objectName: "findingsToggleButton", visible: true });
			await journey.waitUntil(async () => {
				return (await journey.evaluate<boolean>("root.findingsDrawerOpen")) || null;
			}, 5_000);
			await journey.evaluate("root.getFindingsPanelItem().setSortMode('domain')");

			await journey.waitUntil(async () => {
				const title = await journey.evaluate<string>("root.getFindingsPanelItem().displayTitleAt(0)");
				return title === "Alpha finding" || null;
			}, 5_000);
			expect(await journey.evaluate<string>("root.getFindingsPanelItem().displayTitleAt(0)")).toBe("Alpha finding");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("toggles the findings drawer open and closed", async () => {
		const journey = await launchShell();
		try {
			expect(await journey.evaluate<boolean>("root.findingsDrawerOpen")).toBe(false);
			await journey.click({ objectName: "findingsToggleButton", visible: true });
			await journey.waitUntil(async () => {
				return (await journey.evaluate<boolean>("root.findingsDrawerOpen")) || null;
			}, 5_000);
			expect(await journey.evaluate<boolean>("root.findingsDrawerOpen")).toBe(true);
			await journey.click({ objectName: "findingsToggleButton", visible: true });
			await journey.waitUntil(async () => {
				return !(await journey.evaluate<boolean>("root.findingsDrawerOpen")) || null;
			}, 5_000);
			expect(await journey.evaluate<boolean>("root.findingsDrawerOpen")).toBe(false);
		} finally {
			await journey.teardown();
		}
	}, 10_000);
});
