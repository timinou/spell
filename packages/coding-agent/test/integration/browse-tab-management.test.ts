import { describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const BROWSE_SHELL_QML = "BrowseShell.qml";

function dataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`;
}

async function waitForProtocolResult(
	journey: QmlJourney,
	action: string,
	rid: string,
	timeout = 10_000,
): Promise<Record<string, unknown>> {
	return journey.waitForEvent(raw => {
		if (raw.type !== "event") return false;
		const payload = raw.payload as { action?: string; _rid?: string } | undefined;
		return payload?.action === action && payload._rid === rid;
	}, timeout);
}

describe.skipIf(!isBridgeAvailable())("Browse tab management", () => {
	it("opens and closes browser tabs from protocol commands", async () => {
		const journey = await QmlJourney.launch(BROWSE_SHELL_QML, {
			props: { model: "test-provider/test-model", settingsCategory: `browse-tab-management-${Date.now()}-a` },
			width: 1360,
			height: 900,
		});

		try {
			const openResultPromise = waitForProtocolResult(journey, "tab:result", "tab-open-1");
			await journey.agentSends({
				action: "tab:open",
				_rid: "tab-open-1",
				tabId: "research-1",
				title: "Research",
				url: "about:blank",
			});
			const openResult = (await openResultPromise).payload as {
				ok?: boolean;
				result?: { tab?: { tabId?: string } };
			};

			expect(openResult.ok).toBe(true);
			expect(openResult.result?.tab?.tabId).toBe("research-1");
			expect(await journey.evaluate<number>("root.browserTabCount()")).toBe(1);
			expect(await journey.evaluate<string>("root.activeTabId()")).toBe("research-1");
			await journey.expectText("Research");

			const closeResultPromise = waitForProtocolResult(journey, "tab:result", "tab-close-1");
			await journey.agentSends({ action: "tab:close", _rid: "tab-close-1", tabId: "research-1" });
			const closeResult = (await closeResultPromise).payload as { ok?: boolean };

			expect(closeResult.ok).toBe(true);
			expect(await journey.evaluate<number>("root.browserTabCount()")).toBe(0);
			expect(await journey.evaluate<string>("root.activeTabId()")).toBe("chat");
			await journey.expectTextAbsent("Research");
		} finally {
			await journey.teardown();
		}
	});

	it("routes browser commands to the targeted tab", async () => {
		const journey = await QmlJourney.launch(BROWSE_SHELL_QML, {
			props: { model: "test-provider/test-model", settingsCategory: `browse-tab-management-${Date.now()}-b` },
			width: 1360,
			height: 900,
		});
		const page = dataUrl(
			`<!doctype html><html><head><title>Browse Target</title></head><body><h1>Browse Target</h1></body></html>`,
		);

		try {
			const openResultPromise = waitForProtocolResult(journey, "tab:result", "tab-open-2");
			await journey.agentSends({
				action: "tab:open",
				_rid: "tab-open-2",
				tabId: "research-2",
				title: "Browse Target",
				url: "about:blank",
			});
			await openResultPromise;

			const gotoResultPromise = waitForProtocolResult(journey, "browser:result", "browser-goto-1");
			await journey.agentSends({
				action: "browser:goto",
				_rid: "browser-goto-1",
				tabId: "research-2",
				url: page,
			});
			const gotoResult = (await gotoResultPromise).payload as {
				ok?: boolean;
				tabId?: string;
				url?: string;
			};

			expect(gotoResult.ok).toBe(true);
			expect(gotoResult.tabId).toBe("research-2");
			expect(gotoResult.url).toContain("data:text/html");

			await journey.waitUntil(async () => {
				const title = await journey.evaluate<string>("root.getBrowserPanelItem().currentTabTitle()");
				return title === "Browse Target" || null;
			}, 10_000);

			expect(await journey.evaluate<string>("root.getBrowserPanelItem().currentTabTitle()")).toBe("Browse Target");
			expect(await journey.evaluate<string>("root.getBrowserPanelItem().currentTabUrl()")).toContain(
				"data:text/html",
			);
		} finally {
			await journey.teardown();
		}
	});
});
