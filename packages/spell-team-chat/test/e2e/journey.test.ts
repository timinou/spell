/**
 * Tier 3 — Full-stack E2E (bun:test + Playwright as a library).
 *
 * Spins a real spell-server subprocess with our SPA mounted, drives it with
 * a real Chromium via Playwright. Asserts the user journey end-to-end.
 *
 * Mirrors packages/spell-server/test/socket/integration.test.ts shape: own
 * the subsystem inside the test, drive via a real client, single test runner.
 *
 * Note: bun:test\'s `expect` lacks Playwright\'s web-first matchers, so we
 * use Playwright\'s locator.waitFor() / textContent() / isVisible() directly
 * and compose them with plain bun:test expectations. One test runner, one
 * set of primitives.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { startTestSpellServer, type TestSpellServer } from "../helpers/test-server";

let server: TestSpellServer;
let browser: Browser;
let page: Page;

const SPAWN_TIMEOUT_MS = 60_000;

beforeAll(async () => {
	server = await startTestSpellServer();
	browser = await chromium.launch();
	page = await browser.newPage();
	await page.goto(`${server.url}/web/`, { waitUntil: "networkidle" });
});

afterAll(async () => {
	if (page) await page.close().catch(() => undefined);
	if (browser) await browser.close().catch(() => undefined);
	if (server) await server.stop().catch(() => undefined);
});

/** Helper: assert a locator becomes visible within a timeout. */
async function waitVisible(loc: Locator, timeout = 5_000): Promise<void> {
	await loc.waitFor({ state: "visible", timeout });
}

describe("Spell Team Chat E2E", () => {
	it("renders the login form on first load", async () => {
		await waitVisible(page.getByRole("button", { name: "Connect" }));
		const bodyText = await page.locator("body").textContent();
		expect(bodyText).toContain("Sign in with the bearer token");
	});

	it("auths via /web/ws and lands on the empty Shell", async () => {
		await page.locator("input[type=password]").fill(server.token);
		await page.getByRole("button", { name: "Connect" }).click();
		await waitVisible(page.getByText("connected"));
		await waitVisible(page.getByText("No sessions yet."));
		await waitVisible(page.getByText("Signed in as tester"));
	});

	it("opens the spawn dialog and accepts a raw cwd (no template)", async () => {
		await page.getByRole("button", { name: "+ New" }).click();
		await waitVisible(page.locator(".dialog"));
		await page.locator(".dialog input[type=text]").fill(server.configDir);
		await page.locator(".dialog textarea").fill("ignored — no agent will reply in e2e");
		await page.locator(".dialog button[type=submit]").click();

		// Spawn ack must arrive (was the not_implemented bug regression).
		await waitVisible(page.locator(".toast").filter({ hasText: "Spawned session" }), SPAWN_TIMEOUT_MS);
		await page.locator(".dialog").waitFor({ state: "hidden" });
		await waitVisible(page.getByText("1 session"));
	});

	it("renders a user bubble immediately on Send (reactivity regression)", async () => {
		// Wait for the input bar to be available (chat pane mounted after spawn).
		await waitVisible(page.locator(".bar textarea"));
		await page.locator(".bar textarea").fill("ping");
		await page.getByRole("button", { name: /Send/ }).click();
		// This is the exact bug we shipped: bubble must appear before any server reply.
		await waitVisible(page.locator(".bubble.user").filter({ hasText: "ping" }), 2_000);
	});

	it("toggles theme between light and dark via the statusbar button", async () => {
		const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
		// statusbar theme toggle (skip if any modal is intercepting).
		const toggle = page.locator(".statusbar button").filter({ hasText: /[☀🌙]/ });
		await toggle.click();
		await page.waitForFunction(
			prev => document.documentElement.getAttribute("data-theme") !== prev,
			before,
			{ timeout: 2_000 },
		);
		const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
		expect(after).not.toBe(before);
		expect(["light", "dark"]).toContain(after);
	});

	it("REST /web/api/sessions returns the spawned session", async () => {
		const r = await fetch(`${server.url}/web/api/sessions`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { sessions: Array<{ kind: string; ownedBy?: string }> };
		expect(body.sessions.length).toBeGreaterThanOrEqual(1);
		expect(body.sessions[0]?.kind).toBe("spawned");
		expect(body.sessions[0]?.ownedBy).toBe("tester");
	});
});
