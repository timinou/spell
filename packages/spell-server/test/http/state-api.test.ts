import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalExecutionController } from "../../src/executor/goal-executor";
import type { GoalRun } from "../../src/executor/types";
import { startHttpServer } from "../../src/http";
import type { AutonomyManifest, ManifestSetup, NamedStateStore, StateSchema } from "../../src/manifest";
import { GoalScheduler } from "../../src/scheduler";
import { StateStoreManager } from "../../src/state/store-manager";

const AUTH_HEADER = `Basic ${Buffer.from("spell:secret").toString("base64")}`;

class StubExecutor {
	getState(): string {
		return "pending";
	}
	getRunHistory(): GoalRun[] {
		return [];
	}
	async executeGoal(goalName: string): Promise<{ goalName: string }> {
		return { goalName };
	}
}

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "state-api-test-"));
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

function buildManifest(stateStores?: Map<string, NamedStateStore>, stateSchemas?: StateSchema[]): AutonomyManifest {
	const defaultSetup: ManifestSetup = {
		domain: "coding",
		stateStores,
	};
	return {
		name: "test-server",
		version: "0.0.1",
		setups: new Map([["default", defaultSetup]]),
		goals: new Map(),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: stateSchemas ?? [],
	};
}

describe("State API routes", () => {
	let tmpDir: string;
	let stop: (() => void) | undefined;
	let baseUrl = "";
	let storeManager: StateStoreManager | undefined;

	afterEach(() => {
		stop?.();
		stop = undefined;
		storeManager?.close();
		storeManager = undefined;
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	function startServer(stateStores?: Map<string, NamedStateStore>, schemas?: StateSchema[]) {
		const manifest = buildManifest(stateStores, schemas);
		storeManager = new StateStoreManager(manifest, tmpDir);
		const executor = new StubExecutor() as unknown as GoalExecutionController;
		const scheduler = new GoalScheduler();
		const started = startHttpServer({
			executor,
			scheduler,
			manifest,
			config: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
			},
			cwd: tmpDir,
			stateStoreManager: storeManager,
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;
	}

	function get(urlPath: string): Promise<Response> {
		return fetch(`${baseUrl}${urlPath}`, { headers: { Authorization: AUTH_HEADER } });
	}

	describe("GET /api/state", () => {
		it("lists registered stores", async () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)");
			const stores = new Map<string, NamedStateStore>([
				["main-db", { backend: "sqlite", path: "main.db", schema: "items-schema" }],
			]);
			startServer(stores, [ITEMS_SCHEMA]);

			const res = await get("/api/state");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual([{ name: "main-db", backend: "sqlite", path: "main.db", schemaId: "items-schema" }]);
		});

		it("returns empty array when no stores configured", async () => {
			tmpDir = createTempDir();
			startServer();

			const res = await get("/api/state");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual([]);
		});
	});

	describe("GET /api/state/:store/tables", () => {
		it("lists tables for a known store", async () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");
			const stores = new Map<string, NamedStateStore>([
				["db", { backend: "sqlite", path: "main.db", schema: "items-schema" }],
			]);
			startServer(stores, [ITEMS_SCHEMA]);

			const res = await get("/api/state/db/tables");
			expect(res.status).toBe(200);
			const tables = (await res.json()) as { name: string }[];
			expect(tables).toHaveLength(1);
			expect(tables[0].name).toBe("items");
		});

		it("returns 404 for unknown store", async () => {
			tmpDir = createTempDir();
			startServer();

			const res = await get("/api/state/nope/tables");
			expect(res.status).toBe(404);
		});
	});

	describe("GET /api/state/:store/tables/:table", () => {
		it("returns rows with pagination", async () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)", [
				"INSERT INTO items VALUES (1, 'A', 'open')",
				"INSERT INTO items VALUES (2, 'B', 'closed')",
				"INSERT INTO items VALUES (3, 'C', 'open')",
			]);
			const stores = new Map<string, NamedStateStore>([
				["db", { backend: "sqlite", path: "main.db", schema: "items-schema" }],
			]);
			startServer(stores, [ITEMS_SCHEMA]);

			const res = await get("/api/state/db/tables/items?limit=2&offset=0");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { rows: unknown[]; total: number; columns: string[] };
			expect(body.rows).toHaveLength(2);
			expect(body.total).toBe(3);
			expect(body.columns).toEqual(["id", "title", "status"]);
		});

		it("returns 404 for unknown table", async () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)");
			const stores = new Map<string, NamedStateStore>([
				["db", { backend: "sqlite", path: "main.db", schema: "items-schema" }],
			]);
			startServer(stores, [ITEMS_SCHEMA]);

			const res = await get("/api/state/db/tables/nonexistent");
			expect(res.status).toBe(404);
		});

		it("returns 404 for unknown store", async () => {
			tmpDir = createTempDir();
			startServer();

			const res = await get("/api/state/nope/tables/items");
			expect(res.status).toBe(404);
		});
	});

	describe("GET /api/state/:store/tables/:table/count", () => {
		it("returns row count", async () => {
			tmpDir = createTempDir();
			createSqliteFixture(tmpDir, "main", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, status TEXT)", [
				"INSERT INTO items VALUES (1, 'A', 'open')",
				"INSERT INTO items VALUES (2, 'B', 'closed')",
			]);
			const stores = new Map<string, NamedStateStore>([
				["db", { backend: "sqlite", path: "main.db", schema: "items-schema" }],
			]);
			startServer(stores, [ITEMS_SCHEMA]);

			const res = await get("/api/state/db/tables/items/count");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ total: 2 });
		});

		it("returns 404 for unknown store or table", async () => {
			tmpDir = createTempDir();
			startServer();

			const res = await get("/api/state/nope/tables/items/count");
			expect(res.status).toBe(404);
		});
	});
});
