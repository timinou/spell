import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GatewayRegistry, GatewayRegistryError } from "../src/registry";

let tmpDir: string;
let registry: GatewayRegistry;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-registry-"));
	const registryPath = path.join(tmpDir, "services.json");
	registry = new GatewayRegistry(registryPath);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GatewayRegistry", () => {
	test("register and retrieve a service", async () => {
		const entry = await registry.add({
			alias: "myapp",
			target: "http://127.0.0.1:3000",
		});

		expect(entry.alias).toBe("myapp");
		expect(entry.target).toBe("http://127.0.0.1:3000");
		expect(entry.status).toBe("active");
		expect(entry.createdAt).toBeTruthy();

		const retrieved = await registry.get("myapp");
		expect(retrieved).not.toBeNull();
		expect(retrieved!.alias).toBe("myapp");
	});

	test("persists to JSON file and reads back", async () => {
		await registry.add({ alias: "svc1", target: "http://127.0.0.1:4000" });

		// Create a fresh registry instance pointing at the same file
		const registry2 = new GatewayRegistry(registry.registryPath);
		const entry = await registry2.get("svc1");
		expect(entry).not.toBeNull();
		expect(entry!.target).toBe("http://127.0.0.1:4000");
	});

	test("duplicate alias throws conflict error", async () => {
		await registry.add({ alias: "dup", target: "http://127.0.0.1:5000" });

		try {
			await registry.add({ alias: "dup", target: "http://127.0.0.1:5001" });
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(GatewayRegistryError);
			expect((err as GatewayRegistryError).code).toBe("alias_conflict");
		}
	});

	test("deregister removes service", async () => {
		await registry.add({ alias: "removeme", target: "http://127.0.0.1:6000" });
		await registry.remove("removeme");

		const entry = await registry.get("removeme");
		expect(entry).toBeNull();
	});

	test("deregister non-existent alias throws not_found", async () => {
		try {
			await registry.remove("nonexistent");
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(GatewayRegistryError);
			expect((err as GatewayRegistryError).code).toBe("not_found");
		}
	});

	test("list returns all services", async () => {
		await registry.add({ alias: "a", target: "http://127.0.0.1:1001" });
		await registry.add({ alias: "b", target: "http://127.0.0.1:1002" });

		const services = await registry.list();
		expect(services.length).toBe(2);
		const aliases = services.map(s => s.alias).sort();
		expect(aliases).toEqual(["a", "b"]);
	});

	test("session cleanup removes only session-scoped services", async () => {
		await registry.add({
			alias: "session-svc",
			target: "http://127.0.0.1:2001",
			sessionId: "sess-123",
		});
		await registry.add({
			alias: "persistent-svc",
			target: "http://127.0.0.1:2002",
			persistent: true,
			sessionId: "sess-123",
		});
		await registry.add({
			alias: "other-session",
			target: "http://127.0.0.1:2003",
			sessionId: "sess-456",
		});

		const removed = await registry.cleanupSession("sess-123");
		expect(removed).toEqual(["session-svc"]);

		const remaining = await registry.list();
		expect(remaining.length).toBe(2);
		const aliases = remaining.map(s => s.alias).sort();
		expect(aliases).toEqual(["other-session", "persistent-svc"]);
	});

	test("cleanup non-existent session is a no-op", async () => {
		const removed = await registry.cleanupSession("nonexistent");
		expect(removed).toEqual([]);
	});

	test("invalid alias is rejected", async () => {
		try {
			await registry.add({ alias: "UPPER_CASE", target: "http://127.0.0.1:9000" });
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(GatewayRegistryError);
			expect((err as GatewayRegistryError).code).toBe("invalid_alias");
		}
	});

	test("corrupt registry file is backed up and reset", async () => {
		// Write garbage to the registry file
		await Bun.write(registry.registryPath, "not valid json {{{{");

		// Should not throw — falls back to empty
		const services = await registry.list();
		expect(services).toEqual([]);

		// Backup file should exist
		const backupPath = `${registry.registryPath}.bak`;
		const backupExists = await Bun.file(backupPath).exists();
		expect(backupExists).toBe(true);
	});

	test("concurrent writes don't lose data", async () => {
		// Fire multiple register operations concurrently
		await Promise.all([
			registry.add({ alias: "c1", target: "http://127.0.0.1:7001" }),
			registry.add({ alias: "c2", target: "http://127.0.0.1:7002" }),
			registry.add({ alias: "c3", target: "http://127.0.0.1:7003" }),
		]);

		const services = await registry.list();
		expect(services.length).toBe(3);
	});

	test("updateStatus modifies existing entry", async () => {
		await registry.add({ alias: "svc", target: "http://127.0.0.1:8000" });
		await registry.updateStatus("svc", "error", { error: "connection refused" });

		const entry = await registry.get("svc");
		expect(entry!.status).toBe("error");
		expect(entry!.error).toBe("connection refused");
		expect(entry!.lastHealthCheck).toBeTruthy();
	});
});
