import { describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const BROWSE_SHELL_QML = "BrowseShell.qml";

describe.skipIf(!isBridgeAvailable())("BrowseShell layout", () => {
	it("launches with the chat tab active and a visible status bar", async () => {
		const journey = await QmlJourney.launch(BROWSE_SHELL_QML, {
			props: { model: "test-provider/test-model", settingsCategory: `browse-shell-layout-${Date.now()}` },
			width: 1360,
			height: 900,
		});

		try {
			await journey.settle(100);
			expect(await journey.evaluate<string>("root.activeTabId()")).toBe("chat");
			await journey.expectText("Chat");
			await journey.expectText("Ready");
			await journey.expectText("test-provider/test-model");
		} finally {
			await journey.teardown();
		}
	});
});
