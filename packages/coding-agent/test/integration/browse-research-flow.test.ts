import { describe, expect, it } from "bun:test";
import { BrowseJourney, isBridgeAvailable } from "../helpers/browse-journey";

/**
 * Access the chat panel's messages model through the loader.
 * BrowseChatPanel exposes `messagesModel` as a readonly property alias.
 */
const chatModel = "chatLoader.item.messagesModel";

describe.skipIf(!isBridgeAvailable())("Browse research flow", () => {
	it("web_search batch populates findings panel and creates search group in chat", async () => {
		const browse = await BrowseJourney.launch();
		try {
			await browse.sendSearchBatch("quantum computing", [
				{ url: "https://arxiv.org/paper1", title: "QC Paper 1", excerpt: "First quantum paper" },
				{ url: "https://nature.com/paper2", title: "QC Paper 2", excerpt: "Second quantum paper" },
				{ url: "https://phys.org/paper3", title: "QC Paper 3", excerpt: "Third quantum paper" },
			]);

			await browse.expectFindingsCount(3);
			await browse.openFindingsDrawer();

			// Wait for panel
			await browse.waitUntil(async () => {
				return (await browse.evaluate<boolean>("root.getFindingsPanelItem() !== null")) || null;
			}, 5_000);

			// Default curated view hides auto-generated findings
			const displayCount = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(displayCount).toBe(0);

			// Switch to All mode to see them
			await browse.evaluate("root.getFindingsPanelItem().setViewMode('all')");
			await browse.settle();

			const allCount = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(allCount).toBe(3);

			// Search group should exist in chat
			await browse.switchToChat();
			await browse.settle();

			const chatCount = await browse.evaluate<number>(`${chatModel}.count`);
			expect(chatCount).toBeGreaterThan(0);

			const firstRole = await browse.evaluate<string>(`${chatModel}.get(0).role`);
			expect(firstRole).toBe("search_group");

			const groupQuery = await browse.evaluate<string>(`${chatModel}.get(0).query`);
			expect(groupQuery).toBe("quantum computing");
		} finally {
			await browse.teardown();
		}
	}, 15_000);

	it("fetch finding creates individual entry (not grouped)", async () => {
		const browse = await BrowseJourney.launch();
		try {
			await browse.sendFetchFinding(
				"https://docs.example.com/guide",
				"docs.example.com",
				"# Getting Started\n\nThis is the guide content.",
			);

			await browse.expectFindingsCount(1);
			await browse.openFindingsDrawer();

			await browse.waitUntil(async () => {
				return (await browse.evaluate<boolean>("root.getFindingsPanelItem() !== null")) || null;
			}, 5_000);

			await browse.evaluate("root.getFindingsPanelItem().setViewMode('all')");
			await browse.settle();

			const count = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(count).toBe(1);

			// Chat should have an individual finding entry (not a search group)
			await browse.switchToChat();
			await browse.settle();

			const chatCount = await browse.evaluate<number>(`${chatModel}.count`);
			expect(chatCount).toBeGreaterThan(0);

			const role = await browse.evaluate<string>(`${chatModel}.get(0).role`);
			expect(role).toBe("finding");
		} finally {
			await browse.teardown();
		}
	}, 15_000);

	it("duplicate URL enriches existing finding instead of creating new one", async () => {
		const browse = await BrowseJourney.launch();
		try {
			await browse.sendSearchBatch("test topic", [
				{ url: "https://example.com/article", title: "Short Title", excerpt: "Brief" },
			]);

			await browse.expectFindingsCount(1);

			await browse.sendFetchFinding("https://example.com/article", "example.com", "Full article content here");

			await browse.openFindingsDrawer();
			await browse.waitUntil(async () => {
				return (await browse.evaluate<boolean>("root.getFindingsPanelItem() !== null")) || null;
			}, 5_000);
			await browse.evaluate("root.getFindingsPanelItem().setViewMode('all')");
			await browse.settle();

			const modelCount = await browse.evaluate<number>("root.getFindingsPanelItem().findingCount()");
			expect(modelCount).toBe(1);

			const enriched = await browse.evaluate<string>("root.getFindingsPanelItem().findingsModel.get(0).enriched");
			expect(enriched).toBe("true");
		} finally {
			await browse.teardown();
		}
	}, 15_000);

	it("curated toggle hides auto-generated findings and shows agent-curated", async () => {
		const browse = await BrowseJourney.launch();
		try {
			await browse.sendSearchBatch("auto topic", [
				{ url: "https://auto1.com", title: "Auto Finding 1" },
				{ url: "https://auto2.com", title: "Auto Finding 2" },
			]);

			await browse.sendFinding({
				url: "https://curated.com/important",
				title: "Curated Finding",
				excerpt: "This is important",
				tags: ["curated"],
			});

			await browse.expectFindingsCount(3);
			await browse.openFindingsDrawer();

			await browse.waitUntil(async () => {
				return (await browse.evaluate<boolean>("root.getFindingsPanelItem() !== null")) || null;
			}, 5_000);

			await browse.settle();
			const curatedCount = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(curatedCount).toBe(1);

			await browse.evaluate("root.getFindingsPanelItem().setViewMode('all')");
			await browse.settle();

			const allCount = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(allCount).toBe(3);

			await browse.evaluate("root.getFindingsPanelItem().setViewMode('curated')");
			await browse.settle();

			const backCount = await browse.evaluate<number>("root.getFindingsPanelItem().displayCount()");
			expect(backCount).toBe(1);
		} finally {
			await browse.teardown();
		}
	}, 15_000);
});
