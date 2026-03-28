import { describe, expect, it } from "bun:test";
import { BrowseJourney, isBridgeAvailable } from "../helpers/browse-journey";

describe.skipIf(!isBridgeAvailable())("Browse finding flow", () => {
	it("covers finding card -> view in tab round trip", async () => {
		const browse = await BrowseJourney.launch();
		try {
			const tabId = await browse.openTab("https://example.com/source", {
				tabId: "research-flow",
				title: "Research source",
			});
			await browse.switchToChat();
			await browse.sendFinding({
				id: "finding-flow",
				url: "https://example.com/source",
				title: "Finding flow",
				excerpt: "Cross-component research flow.",
				tags: ["flow"],
				tabId,
			});
			await browse.expectFindingCard("Finding flow");

			const event = await browse.clickFindingViewInTab();
			expect(event.type).toBe("view_in_tab");
			expect(event.tabId).toBe(tabId);
			expect(event.url).toBe("https://example.com/source");

			// Simulate the host-side browse-mode response to the emitted event.
			await browse.openTab(String(event.url || "https://example.com/source"), {
				tabId: String(event.tabId || tabId),
				title: String(event.title || "Research source"),
			});
			await browse.expectActiveTab(tabId);
		} finally {
			await browse.teardown();
		}
	}, 10_000);
});
