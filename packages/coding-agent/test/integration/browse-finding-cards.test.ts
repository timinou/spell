import { describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const HARNESS_QML = "panels/BrowseChatPanelTestHarness.qml";

async function launchHarness(): Promise<QmlJourney> {
	return QmlJourney.launch(HARNESS_QML, {
		width: 900,
		height: 700,
		settleMs: 100,
		assertTimeout: 5_000,
	});
}

describe.skipIf(!isBridgeAvailable())("Browse finding cards", () => {
	it("renders finding cards with domain, title, excerpt, and tags", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({
				type: "finding",
				id: "finding-1",
				url: "https://example.com/research/alpha",
				title: "Alpha research finding",
				excerpt: "A concise summary of the source material.",
				tags: ["alpha", "source"],
				tabId: "research-1",
			});

			await journey.expectVisible({ objectName: "findingCard", visible: true });
			await journey.expectText("example.com");
			await journey.expectText("Alpha research finding");
			await journey.expectText("A concise summary of the source material.");
			await journey.expectText("alpha");
			await journey.expectText("source");
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("renders multiple findings sequentially", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({
				type: "finding",
				id: "finding-1",
				url: "https://example.com/one",
				title: "First finding",
				excerpt: "First excerpt.",
				tags: [],
				tabId: "research-1",
			});
			await journey.agentSends({
				type: "finding",
				id: "finding-2",
				url: "https://example.com/two",
				title: "Second finding",
				excerpt: "Second excerpt.",
				tags: [],
				tabId: "research-2",
			});

			const cards = await journey.findItems({ objectName: "findingCard", visible: true }, { includeGeometry: true });
			expect(cards.length).toBe(2);
			expect(cards[1]!.scenePosition!.y).toBeGreaterThan(cards[0]!.scenePosition!.y);
		} finally {
			await journey.teardown();
		}
	}, 10_000);

	it("emits view_in_tab when the card action is clicked", async () => {
		const journey = await launchHarness();
		try {
			await journey.agentSends({
				type: "finding",
				id: "finding-3",
				url: "https://example.com/research/gamma",
				title: "Gamma finding",
				excerpt: "Gamma excerpt.",
				tags: ["gamma"],
				tabId: "research-3",
			});

			const eventPromise = journey.waitForEvent(raw => {
				if (raw.type !== "event") return false;
				const payload = raw.payload as { type?: string; tabId?: string } | undefined;
				return payload?.type === "view_in_tab" && payload.tabId === "research-3";
			}, 5_000);
			await journey.click({ objectName: "viewInTabButton", visible: true });
			const event = await eventPromise;
			const payload = event.payload as { type?: string; tabId?: string; url?: string };

			expect(payload.type).toBe("view_in_tab");
			expect(payload.tabId).toBe("research-3");
			expect(payload.url).toContain("example.com/research/gamma");
		} finally {
			await journey.teardown();
		}
	}, 10_000);
});
