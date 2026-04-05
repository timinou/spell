import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutonomyStateTool } from "../../src/tools/autonomy-state/tool";

const tmpDir = mkdtempSync(join(tmpdir(), "autonomy-state-sql-test-"));
const testDbPath = join(tmpDir, "test.db");
const kvDbPath = join(tmpDir, "kv.db");

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
	for (const key of keys) savedEnv[key] = Bun.env[key];
}

function restoreEnv() {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

const storeSchema = {
	tables: [
		{
			name: "articles",
			columns: [
				{ name: "id", type: "text", primary: true },
				{ name: "title", type: "text" },
				{ name: "url", type: "text" },
				{ name: "score", type: "real" },
				{ name: "status", type: "text" },
			],
		},
		{
			name: "personas",
			columns: [
				{ name: "id", type: "text", primary: true },
				{ name: "name", type: "text" },
			],
		},
	],
};

function createTestDb() {
	const db = new Database(testDbPath);
	db.exec(`
		CREATE TABLE IF NOT EXISTS articles (
			id TEXT PRIMARY KEY,
			title TEXT,
			url TEXT,
			score REAL,
			status TEXT
		);
		CREATE TABLE IF NOT EXISTS personas (
			id TEXT PRIMARY KEY,
			name TEXT
		);
		INSERT OR REPLACE INTO articles VALUES ('a1', 'First Article', 'https://example.com/1', 0.9, 'pending');
		INSERT OR REPLACE INTO articles VALUES ('a2', 'Second Article', 'https://example.com/2', 0.7, 'approved');
		INSERT OR REPLACE INTO articles VALUES ('a3', 'Third Article', 'https://example.com/3', 0.5, 'pending');
		INSERT OR REPLACE INTO personas VALUES ('p1', 'Tech Lead');
		INSERT OR REPLACE INTO personas VALUES ('p2', 'Investor');
	`);
	db.close();
}

async function exec(tool: AutonomyStateTool, input: Record<string, unknown>) {
	const result = await tool.execute("test-call", input as never);
	return result.details as Record<string, unknown>;
}

describe("autonomy_state SQL ops", () => {
	beforeAll(() => {
		saveEnv(
			"SPELL_AUTONOMY_STATE_DB",
			"SPELL_AUTONOMY_STATE_STORES",
			"SPELL_AUTONOMY_STATE_SCHEMAS",
			"SPELL_AUTONOMY_STATE_SCHEMA",
			"SPELL_AUTONOMY_RUN_ID",
		);
		createTestDb();
		Bun.env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify({ workflow: testDbPath });
		Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS = JSON.stringify({ workflow: storeSchema });
		delete Bun.env.SPELL_AUTONOMY_STATE_DB;
	});

	afterAll(() => {
		restoreEnv();
		try {
			rmSync(tmpDir, { recursive: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("createIf returns tool when SPELL_AUTONOMY_STATE_STORES is set", () => {
		const tool = AutonomyStateTool.createIf(null as never);
		expect(tool).not.toBeNull();
	});

	describe("query", () => {
		it("returns all rows from a table", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, { op: "query", store: "workflow", table: "articles" });
			expect(result.success).toBe(true);
			expect(result.rows).toBeArrayOfSize(3);
			expect(result.rowCount).toBe(3);
		});

		it("filters with WHERE clause", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "query",
				store: "workflow",
				table: "articles",
				where: { status: "pending" },
			});
			expect(result.success).toBe(true);
			expect(result.rows).toBeArrayOfSize(2);
			expect(result.rowCount).toBe(2);
		});

		it("paginates with LIMIT and OFFSET", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "query",
				store: "workflow",
				table: "articles",
				limit: 1,
				offset: 1,
			});
			expect(result.success).toBe(true);
			expect(result.rows).toBeArrayOfSize(1);
			expect(result.rowCount).toBe(3); // total count ignores limit/offset
		});

		it("orders by column", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "query",
				store: "workflow",
				table: "articles",
				orderBy: "score",
				orderDir: "desc",
			});
			expect(result.success).toBe(true);
			const rows = result.rows as Array<{ score: number }>;
			expect(rows[0].score).toBe(0.9);
			expect(rows[2].score).toBe(0.5);
		});

		it("rejects unknown store name", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, { op: "query", store: "nonexistent", table: "articles" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown store");
		});

		it("rejects unknown table name", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, { op: "query", store: "workflow", table: "nonexistent" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown table");
		});
	});

	describe("mutate", () => {
		it("INSERT adds a row", async () => {
			const tool = new AutonomyStateTool();
			const insertResult = await exec(tool, {
				op: "mutate",
				store: "workflow",
				table: "articles",
				action: "insert",
				values: { id: "a4", title: "Fourth Article", url: "https://example.com/4", score: 0.8, status: "pending" },
			});
			expect(insertResult.success).toBe(true);
			expect(insertResult.affectedRows).toBe(1);

			// Verify
			const queryResult = await exec(tool, {
				op: "query",
				store: "workflow",
				table: "articles",
				where: { id: "a4" },
			});
			expect(queryResult.rows).toBeArrayOfSize(1);
			expect((queryResult.rows as Array<{ title: string }>)[0].title).toBe("Fourth Article");
		});

		it("UPDATE modifies a row", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "mutate",
				store: "workflow",
				table: "articles",
				action: "update",
				values: { status: "approved" },
				where: { id: "a1" },
			});
			expect(result.success).toBe(true);
			expect(result.affectedRows).toBe(1);

			const queryResult = await exec(tool, {
				op: "query",
				store: "workflow",
				table: "articles",
				where: { id: "a1" },
			});
			expect((queryResult.rows as Array<{ status: string }>)[0].status).toBe("approved");
		});

		it("DELETE removes a row", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "mutate",
				store: "workflow",
				table: "articles",
				action: "delete",
				where: { id: "a4" },
			});
			expect(result.success).toBe(true);
			expect(result.affectedRows).toBe(1);
		});

		it("rejects unknown columns", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, {
				op: "mutate",
				store: "workflow",
				table: "articles",
				action: "insert",
				values: { id: "a5", nonexistent_col: "value" },
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown column");
		});
	});

	describe("list_tables", () => {
		it("returns all table names", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, { op: "list_tables", store: "workflow" });
			expect(result.success).toBe(true);
			expect(result.tables).toEqual(["articles", "personas"]);
		});
	});

	describe("describe_table", () => {
		it("returns column definitions", async () => {
			const tool = new AutonomyStateTool();
			const result = await exec(tool, { op: "describe_table", store: "workflow", table: "articles" });
			expect(result.success).toBe(true);
			expect(result.columns).toBeArrayOfSize(5);
			const cols = result.columns as Array<{ name: string; type: string }>;
			expect(cols[0].name).toBe("id");
			expect(cols[0].type).toBe("text");
		});
	});

	describe("backwards compatibility", () => {
		it("KV ops still work when SPELL_AUTONOMY_STATE_DB is set", async () => {
			// Set KV env, unset SQL env
			Bun.env.SPELL_AUTONOMY_STATE_DB = kvDbPath;
			try {
				const tool = new AutonomyStateTool();
				const setResult = await exec(tool, { op: "set", key: "test-key", value: "test-value" });
				expect(setResult.success).toBe(true);

				const getResult = await exec(tool, { op: "get", key: "test-key" });
				expect(getResult.success).toBe(true);
				expect(getResult.value).toBe("test-value");

				const listResult = await exec(tool, { op: "list" });
				expect(listResult.success).toBe(true);
				expect(listResult.keys).toContain("test-key");
			} finally {
				Bun.env.SPELL_AUTONOMY_STATE_DB = undefined;
			}
		});
	});

	describe("env var validation", () => {
		it("rejects SPELL_AUTONOMY_STATE_STORES when not a JSON object", async () => {
			const prev = Bun.env.SPELL_AUTONOMY_STATE_STORES;
			try {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify(["not", "an", "object"]);
				const tool = new AutonomyStateTool();
				const result = await exec(tool, { op: "list_tables", store: "test" });
				expect(result.success).toBe(false);
				expect(result.error).toContain("SPELL_AUTONOMY_STATE_STORES");
			} finally {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = prev;
			}
		});

		it("rejects SPELL_AUTONOMY_STATE_STORES with non-string values", async () => {
			const prev = Bun.env.SPELL_AUTONOMY_STATE_STORES;
			try {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify({ bad: 123 });
				const tool = new AutonomyStateTool();
				const result = await exec(tool, { op: "list_tables", store: "test" });
				expect(result.success).toBe(false);
				expect(result.error).toContain("SPELL_AUTONOMY_STATE_STORES");
			} finally {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = prev;
			}
		});

		it("rejects SPELL_AUTONOMY_STATE_SCHEMAS without tables array", async () => {
			const prevStores = Bun.env.SPELL_AUTONOMY_STATE_STORES;
			const prevSchemas = Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS;
			try {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify({ test: testDbPath });
				Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS = JSON.stringify({ test: { notTables: [] } });
				const tool = new AutonomyStateTool();
				const result = await exec(tool, { op: "list_tables", store: "test" });
				expect(result.success).toBe(false);
				expect(result.error).toContain("SPELL_AUTONOMY_STATE_SCHEMAS");
			} finally {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = prevStores;
				Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS = prevSchemas;
			}
		});

		it("rejects SPELL_AUTONOMY_STATE_SCHEMAS when not a JSON object", async () => {
			const prevStores = Bun.env.SPELL_AUTONOMY_STATE_STORES;
			const prevSchemas = Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS;
			try {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify({ test: testDbPath });
				Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS = JSON.stringify("a string");
				const tool = new AutonomyStateTool();
				const result = await exec(tool, { op: "list_tables", store: "test" });
				expect(result.success).toBe(false);
				expect(result.error).toContain("SPELL_AUTONOMY_STATE_SCHEMAS");
			} finally {
				Bun.env.SPELL_AUTONOMY_STATE_STORES = prevStores;
				Bun.env.SPELL_AUTONOMY_STATE_SCHEMAS = prevSchemas;
			}
		});
	});
});
