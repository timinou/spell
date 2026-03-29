/**
 * Health dashboard tests.
 *
 * Verifies that the service registry correctly tracks validation timestamps
 * and status transitions, which power the health dashboard UI.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildServicePromptSection } from "../../src/browser/service-prompt-section";
import { ServiceRegistry } from "../../src/browser/service-registry";

let tmpDir: string;
let registryPath: string;
let storageRoot: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-health-test-"));
	registryPath = path.join(tmpDir, "services.json");
	storageRoot = path.join(tmpDir, "QtWebEngine");
	await fs.mkdir(storageRoot, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Session health dashboard", () => {
	it("tracks aggregate service status counts", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		await registry.add({
			name: "github",
			displayName: "GitHub",
			description: "",
			profileStorage: "github",
			domains: ["github.com"],
		});
		await registry.add({
			name: "linkedin",
			displayName: "LinkedIn",
			description: "",
			profileStorage: "linkedin",
			domains: ["linkedin.com"],
		});

		// Both start as connected
		const services = await registry.list();
		const connected = services.filter(s => s.status === "connected").length;
		const unknown = services.filter(s => s.status === "unknown").length;
		expect(connected).toBe(2);
		expect(unknown).toBe(0);

		// Simulate storage dir deleted externally (makes status 'unknown' on get)
		await fs.rm(path.join(storageRoot, "linkedin"), { recursive: true, force: true });
		const linkedin = await registry.get("linkedin");
		expect(linkedin!.status).toBe("unknown");
	});

	it("updateLastValidated sets ISO timestamp", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		await registry.add({
			name: "github",
			displayName: "GitHub",
			description: "",
			profileStorage: "github",
			domains: [],
		});

		const before = await registry.get("github");
		expect(before!.lastValidated).toBeUndefined();

		await registry.updateLastValidated("github");

		const after = await registry.get("github");
		expect(after!.lastValidated).toBeDefined();
		// Should be a valid ISO datetime
		const parsed = new Date(after!.lastValidated!);
		expect(parsed.getTime()).toBeGreaterThan(0);
	});

	it("prompt section reflects service list", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);

		await registry.add({
			name: "github",
			displayName: "GitHub",
			description: "",
			profileStorage: "github",
			domains: [],
		});
		await registry.add({
			name: "linkedin",
			displayName: "LinkedIn",
			description: "",
			profileStorage: "linkedin",
			domains: [],
		});

		const section = await buildServicePromptSection(registryPath);
		expect(section).not.toBeNull();
		expect(section).toContain("github");
		expect(section).toContain("linkedin");
		expect(section).toContain("service:list");
	});

	it("prompt section returns null for empty registry", async () => {
		const section = await buildServicePromptSection(registryPath);
		expect(section).toBeNull();
	});
});
