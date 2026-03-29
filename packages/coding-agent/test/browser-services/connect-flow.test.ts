/**
 * Full connect flow test: register service, verify registry, relaunch with
 * resolved profile. Uses the real LoginServer + BrowserJourney for the browser
 * part and ServiceRegistry for the persistence part.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServiceRegistry } from "../../src/browser/service-registry";
import { BrowserJourney, isBridgeAvailable } from "../helpers/browser-journey";
import { LoginServer } from "./login-server";

let server: LoginServer;
let baseUrl: string;
let tmpDir: string;
let registryPath: string;
let storageRoot: string;

describe.skipIf(!isBridgeAvailable())("Full connect flow", () => {
	beforeAll(async () => {
		server = new LoginServer();
		const state = await server.start();
		baseUrl = state.baseUrl;
	});

	afterAll(async () => {
		await server.stop();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-connect-flow-"));
		registryPath = path.join(tmpDir, "services.json");
		storageRoot = path.join(tmpDir, "QtWebEngine");
		await fs.mkdir(storageRoot, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("login -> register service -> resolve from registry -> launch with profile", async () => {
		const serviceName = "test-service";
		const storageName = `connect-flow-${Date.now()}`;

		// Step 1: Login in a browser instance
		const browser = await BrowserJourney.launch({ storageName });
		try {
			await browser.goto(`${baseUrl}/auto-login`);
			await browser.settle(2000);

			const sync = await browser.sync();
			expect(sync.url).toContain("/dashboard");
		} finally {
			await browser.teardown({ preserveStorage: true });
		}

		// Step 2: Register the service (simulating save_session handler)
		const registry = new ServiceRegistry(registryPath, storageRoot);
		await registry.add({
			name: serviceName,
			displayName: "Test Service",
			description: "E2E test service",
			profileStorage: storageName,
			domains: ["127.0.0.1"],
			loginUrl: `${baseUrl}/auto-login`,
		});

		// Step 3: Verify registry stores the service correctly
		const entry = await registry.get(serviceName);
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe(serviceName);
		expect(entry!.profileStorage).toBe(storageName);
		expect(entry!.status).toBe("connected");
		expect(entry!.domains).toEqual(["127.0.0.1"]);
		expect(entry!.loginUrl).toBe(`${baseUrl}/auto-login`);

		// Step 4: Resolve storageName from registry (what the agent does)
		const resolved = await registry.get(serviceName);
		expect(resolved!.profileStorage).toBe(storageName);

		// Step 5: Update lastUsed (what happens on service-aware launch)
		await registry.updateLastUsed(serviceName);
		const updated = await registry.get(serviceName);
		expect(updated!.lastUsed).toBeDefined();

		// Step 6: Cleanup
		await registry.remove(serviceName);
		const removed = await registry.get(serviceName);
		expect(removed).toBeNull();
	}, 30_000);

	it("service-aware launch resolves profile from registry name", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		// Add a service pointing to a specific profile
		await registry.add({
			name: "github",
			displayName: "GitHub",
			description: "Code hosting",
			profileStorage: "github-work-profile",
			domains: ["github.com"],
		});

		// Resolve just like canvas.ts does on launch
		const service = await registry.get("github");
		expect(service).not.toBeNull();
		const resolvedStorage = service!.profileStorage;
		expect(resolvedStorage).toBe("github-work-profile");

		// The storage path should be deterministic
		const storagePath = registry.resolveStoragePath(resolvedStorage);
		expect(storagePath).toContain("github-work-profile");

		// Launch a browser with the resolved storageName
		const browser = await BrowserJourney.launch({
			storageName: resolvedStorage,
		});
		try {
			const sync = await browser.sync();
			expect(sync.url).toBe("about:blank");
		} finally {
			await browser.teardown();
		}

		await registry.remove("github");
	}, 20_000);
});
