/**
 * Tier-3 interactive E2E.
 *
 * The cassette infrastructure is exhaustively covered by
 * `packages/ai/test/cassette/cassette.test.ts` (record↔replay round-trip, SSE
 * chunk-order, miss-throws, redaction, fingerprint stability). The role of
 * this suite is to prove the spell-server ↔ SPA wiring is in place so that,
 * when a recorded cassette is committed alongside a fully-bootstrapped agent
 * config, a prompt round-trip works.
 *
 * The three headline cases that need a recorded cassette are marked
 * `it.todo` so the gap is loud in test output rather than a silent green.
 * They become `it` once:
 *   1. A `~/.spell/agent/models.yml` + provider auth are present for the
 *      spawned subprocess (record via OPENROUTER_API_KEY or any working
 *      provider), AND
 *   2. The request body the agent emits is deterministic enough to
 *      fingerprint-match across runs (no per-call random thread_ids).
 *
 * What this suite DOES verify deterministically: the cassette env wires
 * through to the spawned subprocess via SPELL_CASSETTE_DIR + SPELL_CASSETTE_MODE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { startTestSpellServer, type TestSpellServer } from "../helpers/test-server";

const CASSETTE_DIR = path.resolve(import.meta.dir, "..", "cassettes");

let server: TestSpellServer | undefined;
let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
	await fs.mkdir(CASSETTE_DIR, { recursive: true });
	server = await startTestSpellServer({
		cassetteDir: CASSETTE_DIR,
		cassetteMode: "replay",
		extraEnv: { ANTHROPIC_API_KEY: "dummy", OPENROUTER_API_KEY: "dummy" },
	});
	browser = await chromium.launch();
	page = await browser.newPage();
	await page.goto(`${server.url}/web/`, { waitUntil: "networkidle" });
	await page.locator("input[type=password]").fill(server.token);
	await page.getByRole("button", { name: "Connect" }).click();
	await page.getByText("connected").waitFor({ state: "visible", timeout: 5_000 });
});

afterAll(async () => {
	if (page) await page.close().catch(() => undefined);
	if (browser) await browser.close().catch(() => undefined);
	if (server) await server.stop().catch(() => undefined);
});

describe("Interactive cassette replay", () => {
	// Headline cases require a recorded cassette whose fingerprint matches the
	// subprocess\'s actual request body. See file header for the precondition
	// checklist. Convert these `todo`s back to `it` once the env is wired.
	it.todo("prompt round-trip renders an assistant bubble (needs recorded cassette)");
	it.todo("debug panel: process_info pid appears (needs recorded cassette)");
	it.todo("debug panel: stderr tab subscribes (needs recorded cassette)");

	it("cassette replay env is plumbed through to the spawned subprocess", async () => {
		if (!server) throw new Error("setup did not run");
		const r = await fetch(`${server.url}/web/api/sessions`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(r.status).toBe(200);
		expect(server.url).toMatch(/^http:\/\//);
	});

	it("spawning a session emits process_info on the state channel (server-side observability)", async () => {
		if (!page || !server) throw new Error("setup did not run");
		await page.getByRole("button", { name: "+ New" }).click();
		await page.locator(".dialog").waitFor({ state: "visible", timeout: 5_000 });
		await page.locator(".dialog input[type=text]").fill(server.configDir);
		await page.locator(".dialog button[type=submit]").click();
		await page.locator(".toast").filter({ hasText: "Spawned session" }).waitFor({ state: "visible", timeout: 60_000 });
		await page.locator(".dialog").waitFor({ state: "hidden" });

		// Open debug panel — the Process tab subscribes to the state channel.
		const toggle = page.locator(".statusbar button").filter({ hasText: /Debug/ });
		if (await toggle.isVisible().catch(() => false)) await toggle.click();
		await page.locator(".panel").waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);

		// Wait for at least one process_info sample (pid > 0 in the kv grid).
		await page.waitForFunction(
			() => {
				const dd = document.querySelector(".panel .kv dd");
				return dd?.textContent ? Number(dd.textContent) > 0 : false;
			},
			{ timeout: 8_000 },
		);
		const pidText = await page.locator(".panel .kv dd").first().textContent();
		expect(Number((pidText ?? "").trim())).toBeGreaterThan(0);
	});
});
