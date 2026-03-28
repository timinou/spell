import { describe, expect, it } from "bun:test";
import { BrowseJourney, isBridgeAvailable } from "../helpers/browse-journey";

describe.skipIf(!isBridgeAvailable())("Browse tab lifecycle", () => {
	it("opens, switches, and closes tabs through the semantic helper", async () => {
		const browse = await BrowseJourney.launch();
		try {
			const firstTab = await browse.openTab("https://example.com/first", {
				tabId: "research-1",
				title: "First tab",
			});
			const secondTab = await browse.openTab("https://example.com/second", {
				tabId: "research-2",
				title: "Second tab",
			});

			expect(firstTab).toBe("research-1");
			expect(secondTab).toBe("research-2");
			await browse.expectTabCount(2);
			await browse.expectActiveTab("research-2");

			await browse.switchToChat();
			await browse.expectActiveTab("chat");
			await browse.switchToTab("research-1");
			await browse.expectActiveTab("research-1");

			await browse.closeTab("research-1");
			await browse.expectTabCount(1);
			await browse.expectActiveTab("research-2");
		} finally {
			await browse.teardown();
		}
	}, 10_000);
});
