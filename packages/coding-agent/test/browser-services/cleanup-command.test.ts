import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupProfiles, findOrphanedProfiles } from "../../src/browser/browser-cleanup";
import { ServiceRegistry } from "../../src/browser/service-registry";

let tmpDir: string;
let registryPath: string;
let storageRoot: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-cleanup-test-"));
	registryPath = path.join(tmpDir, "services.json");
	storageRoot = path.join(tmpDir, "QtWebEngine");
	await fs.mkdir(storageRoot, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Browser profile cleanup", () => {
	it("identifies orphaned timestamped profiles", async () => {
		await fs.mkdir(path.join(storageRoot, "spell-browser-1234567-890"));
		await fs.mkdir(path.join(storageRoot, "spell-browser-9999999-123"));
		const registry = new ServiceRegistry(registryPath, storageRoot);
		await registry.add({
			name: "linkedin",
			displayName: "LinkedIn",
			description: "",
			profileStorage: "linkedin",
			domains: [],
		});

		const orphans = await findOrphanedProfiles({ registryPath, storageRoot });
		expect(orphans).toHaveLength(2);
		expect(orphans.every(o => o.isTimestamped)).toBe(true);
	});

	it("dry-run lists without deleting", async () => {
		await fs.mkdir(path.join(storageRoot, "spell-browser-1111111-222"));

		const result = await cleanupProfiles({ dryRun: true, registryPath, storageRoot });
		expect(result.orphans).toHaveLength(1);
		expect(result.deleted).toHaveLength(0);

		const stat = await fs.stat(path.join(storageRoot, "spell-browser-1111111-222"));
		expect(stat.isDirectory()).toBe(true);
	});

	it("force mode deletes all orphans", async () => {
		await fs.mkdir(path.join(storageRoot, "spell-browser-1111111-222"));
		await fs.mkdir(path.join(storageRoot, "custom-profile"));

		const result = await cleanupProfiles({ force: true, registryPath, storageRoot });
		expect(result.deleted).toHaveLength(2);
	});

	it("skips registry-referenced profiles", async () => {
		const registry = new ServiceRegistry(registryPath, storageRoot);
		await registry.add({
			name: "github",
			displayName: "GitHub",
			description: "",
			profileStorage: "github-profile",
			domains: [],
		});
		await fs.mkdir(path.join(storageRoot, "orphan-dir"));

		const orphans = await findOrphanedProfiles({ registryPath, storageRoot });
		const names = orphans.map(o => o.name);
		expect(names).not.toContain("github-profile");
		expect(names).toContain("orphan-dir");
	});

	it("skips well-known profiles", async () => {
		await fs.mkdir(path.join(storageRoot, "spell-browser"));
		await fs.mkdir(path.join(storageRoot, "spell-browse-mode"));
		await fs.mkdir(path.join(storageRoot, "SpellBrowser"));
		await fs.mkdir(path.join(storageRoot, "orphan"));

		const orphans = await findOrphanedProfiles({ registryPath, storageRoot });
		expect(orphans).toHaveLength(1);
		expect(orphans[0].name).toBe("orphan");
	});

	it("handles missing QtWebEngine directory gracefully", async () => {
		const orphans = await findOrphanedProfiles({ registryPath, storageRoot: "/nonexistent/path" });
		expect(orphans).toHaveLength(0);
	});
});
