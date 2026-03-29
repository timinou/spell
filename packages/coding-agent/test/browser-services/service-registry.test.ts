import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServiceRegistry, ServiceRegistryError, sanitizeStorageName } from "../../src/browser/service-registry";

let tmpDir: string;
let registryPath: string;
let storageRoot: string;
let registry: ServiceRegistry;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-registry-test-"));
	registryPath = path.join(tmpDir, "services.json");
	storageRoot = path.join(tmpDir, "QtWebEngine");
	await fs.mkdir(storageRoot, { recursive: true });
	registry = new ServiceRegistry(registryPath, storageRoot);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides?: Partial<Omit<import("../../src/browser/types").ServiceEntry, "status">>) {
	return {
		name: "linkedin",
		displayName: "LinkedIn",
		description: "Professional network",
		profileStorage: "linkedin",
		domains: ["linkedin.com", "www.linkedin.com"],
		...overrides,
	};
}

describe("ServiceRegistry", () => {
	it("adds a service, writes valid JSON, and creates storage dir with 0700", async () => {
		await registry.add(makeEntry());

		// Registry file is valid JSON
		const raw = await Bun.file(registryPath).json();
		expect(raw.services.linkedin).toBeDefined();
		expect(raw.services.linkedin.name).toBe("linkedin");
		expect(raw.services.linkedin.status).toBe("connected");

		// Storage dir exists with correct permissions
		const storagePath = registry.resolveStoragePath("linkedin");
		const stat = await fs.stat(storagePath);
		expect(stat.isDirectory()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o700);
	});

	it("removes a service and deletes storage directory", async () => {
		await registry.add(makeEntry());
		const storagePath = registry.resolveStoragePath("linkedin");
		expect(await dirExists(storagePath)).toBe(true);

		await registry.remove("linkedin");

		const list = await registry.list();
		expect(list).toHaveLength(0);
		expect(await dirExists(storagePath)).toBe(false);
	});

	it("lists all services", async () => {
		await registry.add(makeEntry());
		await registry.add(
			makeEntry({ name: "github", displayName: "GitHub", profileStorage: "github", domains: ["github.com"] }),
		);

		const list = await registry.list();
		expect(list).toHaveLength(2);
		expect(list.map(s => s.name).sort()).toEqual(["github", "linkedin"]);
	});

	it("gets a service by name", async () => {
		await registry.add(makeEntry());

		const entry = await registry.get("linkedin");
		expect(entry).not.toBeNull();
		expect(entry!.displayName).toBe("LinkedIn");
		expect(entry!.domains).toEqual(["linkedin.com", "www.linkedin.com"]);
	});

	it("resolves domain to service via exact match", async () => {
		await registry.add(makeEntry());

		expect(await registry.resolveByDomain("linkedin.com")).not.toBeNull();
		expect(await registry.resolveByDomain("www.linkedin.com")).not.toBeNull();
		expect(await registry.resolveByDomain("m.linkedin.com")).toBeNull();
		expect(await registry.resolveByDomain("notlinkedin.com")).toBeNull();
	});

	it("rejects add when sanitized storageName collides with existing service", async () => {
		await registry.add(makeEntry({ name: "svc-a", profileStorage: "my-service" }));

		// "my.service" sanitizes to "my-service" -> collision
		await expect(registry.add(makeEntry({ name: "svc-b", profileStorage: "my.service" }))).rejects.toThrow(
			ServiceRegistryError,
		);
	});

	it("sanitizes storageName: 'my.service' and 'my-service' both become 'my-service'", () => {
		expect(sanitizeStorageName("my.service")).toBe("my-service");
		expect(sanitizeStorageName("my-service")).toBe("my-service");
		expect(sanitizeStorageName("  hello world!  ")).toBe("hello-world");
		// Strip leading/trailing dashes from the final result
		expect(sanitizeStorageName("---test---")).toBe("test");
		expect(sanitizeStorageName("a".repeat(100))).toHaveLength(48);
	});

	it("writes atomically — file always contains valid JSON", async () => {
		// Sequential adds to verify each write produces valid JSON
		for (let i = 0; i < 5; i++) {
			await registry.add(
				makeEntry({
					name: `service-${i}`,
					profileStorage: `storage-${i}`,
					domains: [`s${i}.example.com`],
				}),
			);
			// After each write, file must be valid JSON
			const raw = await Bun.file(registryPath).text();
			const parsed = JSON.parse(raw);
			expect(parsed.services).toBeDefined();
			expect(Object.keys(parsed.services).length).toBe(i + 1);
		}
	});

	it("parent-child: child shares parent storageName; removing parent does not cascade", async () => {
		await registry.add(makeEntry({ name: "google", profileStorage: "google-personal", domains: ["google.com"] }));
		await registry.add(
			makeEntry({
				name: "youtube",
				profileStorage: "youtube",
				domains: ["youtube.com"],
				parentService: "google",
			}),
		);

		// Child should have resolved to parent's profileStorage
		const youtube = await registry.get("youtube");
		expect(youtube).not.toBeNull();
		expect(youtube!.profileStorage).toBe("google-personal");

		// Remove parent — child remains, parent storage preserved (child still uses it)
		await registry.remove("google");
		const afterRemoval = await registry.get("youtube");
		expect(afterRemoval).not.toBeNull();
		expect(afterRemoval!.profileStorage).toBe("google-personal");

		// Storage dir still exists since youtube references it
		const storagePath = registry.resolveStoragePath("google-personal");
		expect(await dirExists(storagePath)).toBe(true);
	});

	it("recovers from corrupt registry: backs up and starts fresh", async () => {
		await Bun.write(registryPath, "not valid json {{{");

		// Should not throw — returns empty list
		const list = await registry.list();
		expect(list).toHaveLength(0);

		// Backup should exist
		const bakExists = await fileExists(`${registryPath}.bak`);
		expect(bakExists).toBe(true);

		// Can add new entries after recovery
		await registry.add(makeEntry());
		const newList = await registry.list();
		expect(newList).toHaveLength(1);
	});

	it("returns status 'unknown' when storage dir is missing", async () => {
		await registry.add(makeEntry());

		// Delete the storage directory externally
		const storagePath = registry.resolveStoragePath("linkedin");
		await fs.rm(storagePath, { recursive: true, force: true });

		const entry = await registry.get("linkedin");
		expect(entry).not.toBeNull();
		expect(entry!.status).toBe("unknown");
	});
});

async function dirExists(p: string): Promise<boolean> {
	try {
		const s = await fs.stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
