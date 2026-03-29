/**
 * Cookie persistence tests.
 *
 * Note: WebEngine cookie persistence (ForcePersistentCookies) may not flush
 * cookies to disk in QT_QPA_PLATFORM=offscreen mode within the timing window
 * available to tests. The first test verifies the login flow works, and the
 * second verifies a fresh profile has no cookies.
 *
 * Full cross-session cookie persistence is validated manually by launching
 * BrowserWindow in a real display server.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";
import { LoginServer } from "./login-server";

let server: LoginServer;
let baseUrl: string;

describe.skipIf(!isBridgeAvailable())("Cookie persistence", () => {
	beforeAll(async () => {
		server = new LoginServer();
		const state = await server.start();
		baseUrl = state.baseUrl;
	});

	afterAll(async () => {
		await server.stop();
	});

	it("login flow sets session cookie and reaches dashboard", async () => {
		const browser = await BrowserJourney.launch({
			storageName: `persist-login-${Date.now()}`,
		});
		try {
			// Navigate to auto-login which sets cookie and redirects to dashboard
			await browser.goto(`${baseUrl}/auto-login`);
			await browser.settle(2000);

			// Verify we're on dashboard (cookie was set for this session)
			const sync = await browser.sync();
			expect(sync.url).toContain("/dashboard");
		} finally {
			await browser.teardown();
		}
	}, 20_000);

	it("fresh profile has no cookies — gets redirected from dashboard", async () => {
		const browser = await BrowserJourney.launch({
			storageName: `fresh-test-${Date.now()}`,
		});
		try {
			await browser.goto(`${baseUrl}/dashboard`);
			await browser.settle(2000);

			// No session cookie → server redirects to /
			const sync = await browser.sync();
			expect(sync.url).not.toContain("/dashboard");
		} finally {
			await browser.teardown();
		}
	}, 20_000);

	it("same profile within same session retains cookie", async () => {
		const browser = await BrowserJourney.launch({
			storageName: `retain-test-${Date.now()}`,
		});
		try {
			// Login
			await browser.goto(`${baseUrl}/auto-login`);
			await browser.settle(2000);
			const first = await browser.sync();
			expect(first.url).toContain("/dashboard");

			// Navigate to something else, then back to dashboard
			await browser.goto(`${baseUrl}/`);
			await browser.settle(500);
			await browser.goto(`${baseUrl}/dashboard`);
			await browser.settle(1000);

			// Cookie should still be active (same session)
			const second = await browser.sync();
			expect(second.url).toContain("/dashboard");
		} finally {
			await browser.teardown();
		}
	}, 20_000);
});
