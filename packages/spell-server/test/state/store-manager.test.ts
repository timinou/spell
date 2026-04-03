import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AutonomyManifest, ManifestGoal, ManifestSetup, NamedStateStore, StateSchema } from "../../src/manifest";
import { StateStoreManager } from "../../src/state/store-manager";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "store-manager-test-"));
}

function createSqliteFixture(dir: string, name: string, ddl: string, rows?: string[]): string {
	const dbPath = path.join(dir, `${name}.db`);
	const db = new Database(dbPath);
	db.run(ddl);
	for (const sql of rows ?? []) {
		db.run(sql);
	}
	db.close();
	return dbPath;
}

function buildManifest(overrides?: {
	setups?: Map<string, ManifestSetup>;
	goals?: Map<string, ManifestGoal>;
	stateSchemas?: StateSchema[];
}): AutonomyManifest {
	return {
		name: "test",
		version: "0.0.1",
		setups: overrides?.setups ?? new Map(),
		goals: overrides?.goals ?? new Map(),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: overrides?.stateSchemas ?? [],
	};
}

const ITEMS_SCHEMA: StateSchema = {
	id: "items-schema",
	backend: "sqlite",
	tables: [
		{
			name: "items",
			columns: [
				{ name: "id", type: "integer", primary: true },
				{ name: "title", type: "text" },
				{ name: "status", type: "text" },
			],
		},
	],
};

describe("StateStoreManager", () => {
	let tmpDir: string;
	let manager: StateStoreManager | undefined;

	afterEach(() => {
		manager?.close();
		manager = undefined;
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	describe("constructor", () => {
		it("collects state stores from setups", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["main-store", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});

			manager = new StateStoreManager(manifest, tmpDir);
			const stores = manager.getStores();
			expect(stores).toEqual([{ name: "main-store", backend: "sqlite", path: "main.db", schemaId: "items-schema" }]);
		});

		it("collects state stores from goals", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "goal-db", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "goal-db.db", schema: "items-schema" };
			const manifest = buildManifest({
				goals: new Map([
					[
						"my-goal",
						{
							setup: "default",
							schedule: { type: "cron", expression: "* * * * *" },
							stateStores: new Map([["goal-store", store]]),
						},
					],
				]),
				stateSchemas: [ITEMS_SCHEMA],
			});

			manager = new StateStoreManager(manifest, tmpDir);
			const stores = manager.getStores();
			expect(stores).toEqual([
				{ name: "goal-store", backend: "sqlite", path: "goal-db.db", schemaId: "items-schema" },
			]);
		});

		it("does not crash when SQLite file is missing", () => {
			tmpDir = createTempDir();
			const store: NamedStateStore = { backend: "sqlite", path: "nonexistent.db" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["broken-store", store]]) }]]),
			});

			// Should not throw
			manager = new StateStoreManager(manifest, tmpDir);
			const stores = manager.getStores();
			expect(stores).toHaveLength(1);
			expect(stores[0].name).toBe("broken-store");
		});

		it("deduplicates stores — setup-level wins over goal-level for same name", () => {
			tmpDir = createTempDir();
			createSqliteFixture(
				tmpDir,
				"setup-db",
				"CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)",
			);

			const setupStore: NamedStateStore = { backend: "sqlite", path: "setup-db.db" };
			const goalStore: NamedStateStore = { backend: "sqlite", path: "goal-db.db" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["shared-name", setupStore]]) }]]),
				goals: new Map([
					[
						"g1",
						{
							setup: "default",
							schedule: { type: "cron", expression: "* * * * *" },
							stateStores: new Map([["shared-name", goalStore]]),
						},
					],
				]),
			});

			manager = new StateStoreManager(manifest, tmpDir);
			const stores = manager.getStores();
			expect(stores).toHaveLength(1);
			expect(stores[0].path).toBe("setup-db.db");
		});
	});

	describe("queryTable", () => {
		it("returns rows and derives columns from actual DB data", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)", [
				"INSERT INTO items VALUES (1, 'Fix bug', 'open')",
				"INSERT INTO items VALUES (2, 'Add feature', 'closed')",
			]);

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			const result = manager.queryTable("db", "items", 50, 0);
			expect(result).not.toBeNull();
			expect(result!.total).toBe(2);
			expect(result!.rows).toHaveLength(2);
			// Columns derived from actual rows, not schema
			expect(result!.columns).toEqual(["id", "title", "status"]);
			expect(result!.rows[0]).toEqual({ id: 1, title: "Fix bug", status: "open" });
		});

		it("falls back to schema columns when table is empty", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			const result = manager.queryTable("db", "items", 50, 0);
			expect(result).not.toBeNull();
			expect(result!.total).toBe(0);
			expect(result!.rows).toEqual([]);
			expect(result!.columns).toEqual(["id", "title", "status"]);
		});

		it("respects pagination", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)", [
				"INSERT INTO items VALUES (1, 'A', 'open')",
				"INSERT INTO items VALUES (2, 'B', 'open')",
				"INSERT INTO items VALUES (3, 'C', 'open')",
			]);

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			const page1 = manager.queryTable("db", "items", 2, 0);
			expect(page1!.rows).toHaveLength(2);
			expect(page1!.total).toBe(3);

			const page2 = manager.queryTable("db", "items", 2, 2);
			expect(page2!.rows).toHaveLength(1);
			expect(page2!.total).toBe(3);
		});

		it("returns null for unknown store", () => {
			tmpDir = createTempDir();
			manager = new StateStoreManager(buildManifest(), tmpDir);
			expect(manager.queryTable("nope", "items", 50, 0)).toBeNull();
		});

		it("returns null for unknown table in known store", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			expect(manager.queryTable("db", "nonexistent", 50, 0)).toBeNull();
		});

		it("returns empty results when DB file was missing at construction", () => {
			tmpDir = createTempDir();
			const store: NamedStateStore = { backend: "sqlite", path: "missing.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			const result = manager.queryTable("db", "items", 50, 0);
			expect(result).not.toBeNull();
			expect(result!.rows).toEqual([]);
			expect(result!.total).toBe(0);
		});
	});

	describe("countTable", () => {
		it("returns count without fetching rows", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)", [
				"INSERT INTO items VALUES (1, 'A', 'open')",
				"INSERT INTO items VALUES (2, 'B', 'closed')",
			]);

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			expect(manager.countTable("db", "items")).toBe(2);
		});

		it("returns null for unknown store", () => {
			tmpDir = createTempDir();
			manager = new StateStoreManager(buildManifest(), tmpDir);
			expect(manager.countTable("nope", "items")).toBeNull();
		});

		it("returns null for unknown table", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			expect(manager.countTable("db", "nonexistent")).toBeNull();
		});

		it("returns 0 when DB was missing at construction", () => {
			tmpDir = createTempDir();
			const store: NamedStateStore = { backend: "sqlite", path: "missing.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			expect(manager.countTable("db", "items")).toBe(0);
		});
	});

	describe("getTablesForStore", () => {
		it("returns schema tables for a store with linked schema", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db", schema: "items-schema" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
				stateSchemas: [ITEMS_SCHEMA],
			});
			manager = new StateStoreManager(manifest, tmpDir);

			const tables = manager.getTablesForStore("db");
			expect(tables).toHaveLength(1);
			expect(tables![0].name).toBe("items");
		});

		it("returns empty array for store without schema", () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");

			const store: NamedStateStore = { backend: "sqlite", path: "main.db" };
			const manifest = buildManifest({
				setups: new Map([["default", { domain: "coding", stateStores: new Map([["db", store]]) }]]),
			});
			manager = new StateStoreManager(manifest, tmpDir);

			expect(manager.getTablesForStore("db")).toEqual([]);
		});

		it("returns null for unknown store", () => {
			tmpDir = createTempDir();
			manager = new StateStoreManager(buildManifest(), tmpDir);
			expect(manager.getTablesForStore("nope")).toBeNull();
		});
	});
});
