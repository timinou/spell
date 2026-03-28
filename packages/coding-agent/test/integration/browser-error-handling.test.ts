import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BrowserObservationEntry } from "../../src/tools/canvas-browser-protocol";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";

function dataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`;
}

const BUTTON_PAGE = dataUrl(`<!doctype html><html><body><button id="target">Target</button></body></html>`);

describe.skipIf(!isBridgeAvailable())("Browser error handling", () => {
	let browser: BrowserJourney;

	beforeAll(async () => {
		browser = await BrowserJourney.launch();
	});

	afterAll(async () => {
		await browser.teardown();
	});

	it("blocks disallowed navigation schemes", async () => {
		const result = await browser.command({ action: "browser:goto", url: "file:///etc/passwd" });
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("navigation_blocked");
	});

	it("reports stale element ids after navigation and times out missing selectors", async () => {
		await browser.goto(BUTTON_PAGE);
		const observation = await browser.observe({ include_all: true });
		const button = observation.elements.find(entry => entry.tag === "button") as BrowserObservationEntry | undefined;
		expect(button).toBeDefined();

		await browser.goto("about:blank");
		const stale = await browser.command({ action: "browser:click", element_id: button!.id });
		expect(stale.ok).toBe(false);
		expect(stale.error?.code).toBe("stale_element");

		const timeout = await browser.command(
			{ action: "browser:wait_for_selector", selector: "#never-appears", timeout_ms: 300 },
			3_000,
		);
		expect(timeout.ok).toBe(false);
		expect(timeout.error?.code).toBe("timeout");
	});
});
