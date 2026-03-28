import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";
import { ReconnectTestServer } from "./server";

const TEST_TIMEOUT_MS = 20_000;

async function waitForStatus(browser: BrowserJourney, expectedStatus: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await browser.sync();
		if (state.state === "interactive") {
			const status = await browser.getText("#status");
			if (status.text.trim() === expectedStatus) {
				return;
			}
		}
		await Bun.sleep(200);
	}
	throw new Error(`Browser did not report status ${expectedStatus} within ${timeoutMs}ms`);
}

async function waitForConnected(browser: BrowserJourney, timeoutMs = 10_000): Promise<void> {
	await waitForStatus(browser, "open", timeoutMs);
}

describe.skipIf(!isBridgeAvailable())("Browser reconnect recovery", () => {
	let browser: BrowserJourney;
	let server: ReconnectTestServer;

	beforeAll(async () => {
		server = new ReconnectTestServer();
		const started = await server.start();
		browser = await BrowserJourney.launch({ initialUrl: `${started.baseUrl}/` });
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		try {
			if (browser) {
				await browser.teardown();
			}
		} finally {
			if (server) {
				await server.stop();
			}
		}
	}, TEST_TIMEOUT_MS);

	it(
		"reaches interactive state with an open websocket on initial load",
		async () => {
			await browser.waitUntilInteractive(10_000);
			await browser.waitForSelector("#status", 5_000);
			await waitForConnected(browser, 10_000);
			expect((await browser.getText("#status")).text.trim()).toBe("open");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"recovers to interactive open state after a short endpoint restart",
		async () => {
			await browser.goto(`${server.state().baseUrl}/`);
			await waitForConnected(browser, 10_000);

			await server.restart({ delayMs: 1_000 });
			await waitForConnected(browser, 12_000);
			expect((await browser.getText("#status")).text.trim()).toBe("open");
		},
		TEST_TIMEOUT_MS,
	);

	it("can recover after a long endpoint restart via force reload", async () => {
		await browser.goto(`${server.state().baseUrl}/`);
		await waitForConnected(browser, 10_000);

		const restartPromise = server.restart({ delayMs: 5_000 });
		await restartPromise;
		await waitForStatus(browser, "stalled", 12_000);

		const result = await browser.forceReload(15_000);
		expect(result.state).toBe("interactive");
		await waitForConnected(browser, 15_000);
		expect((await browser.getText("#status")).text.trim()).toBe("open");
	}, 30_000);
});
