import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AutonomyStateStore } from "@oh-my-pi/pi-coding-agent/tools/autonomy-state";
import { AutonomyStateTool } from "@oh-my-pi/pi-coding-agent/tools/autonomy-state/tool";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("AutonomyStateStore", () => {
	let tempDir: string;
	let previousDb: string | undefined;
	let previousSchema: string | undefined;
	let previousRunId: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autonomy-state-"));
		previousDb = Bun.env.SPELL_AUTONOMY_STATE_DB;
		previousSchema = Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
		previousRunId = Bun.env.SPELL_AUTONOMY_RUN_ID;
		delete Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
		Bun.env.SPELL_AUTONOMY_RUN_ID = "test-run";
	});

	afterEach(async () => {
		if (previousDb === undefined) delete Bun.env.SPELL_AUTONOMY_STATE_DB;
		else Bun.env.SPELL_AUTONOMY_STATE_DB = previousDb;
		if (previousSchema === undefined) delete Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
		else Bun.env.SPELL_AUTONOMY_STATE_SCHEMA = previousSchema;
		if (previousRunId === undefined) delete Bun.env.SPELL_AUTONOMY_RUN_ID;
		else Bun.env.SPELL_AUTONOMY_RUN_ID = previousRunId;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function dbPath(name = "state.sqlite"): string {
		return path.join(tempDir, name);
	}

	it("get returns null for non-existent key", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		expect(store.get("missing")).toBeNull();
		store.close();
	});

	it("set stores value and get retrieves it", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		store.set("count", 3);
		expect(store.get("count")).toBe(3);
		store.close();
	});

	it("set stores JSON object and get retrieves parsed object", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		store.set("payload", { ok: true, nested: { value: 1 } });
		expect(store.get("payload")).toEqual({ ok: true, nested: { value: 1 } });
		store.close();
	});

	it("set overwrites existing key", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		store.set("status", "queued");
		store.set("status", "done");
		expect(store.get("status")).toBe("done");
		store.close();
	});

	it("list returns all keys sorted", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		store.set("zeta", 1);
		store.set("alpha", 2);
		store.set("middle", 3);
		expect(store.list()).toEqual(["alpha", "middle", "zeta"]);
		store.close();
	});

	it("delete removes key and deleting a missing key is a no-op", () => {
		const store = new AutonomyStateStore(dbPath(), "run-a");
		store.set("ephemeral", true);
		store.delete("ephemeral");
		store.delete("missing");
		expect(store.get("ephemeral")).toBeNull();
		store.close();
	});

	it("metadata table has run_id and started_at and persists across reopen", () => {
		const databasePath = dbPath();
		const first = new AutonomyStateStore(databasePath, "run-a");
		const metadata = first.getMetadata();
		expect(metadata?.runId).toBe("run-a");
		expect(metadata?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		first.set("persisted", { ok: true });
		first.close();

		const reopened = new AutonomyStateStore(databasePath, "run-a");
		expect(reopened.get("persisted")).toEqual({ ok: true });
		expect(reopened.getMetadata()?.runId).toBe("run-a");
		reopened.close();
	});
});

describe("AutonomyStateTool", () => {
	let tempDir: string;
	let previousDb: string | undefined;
	let previousSchema: string | undefined;
	let previousRunId: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autonomy-state-tool-"));
		previousDb = Bun.env.SPELL_AUTONOMY_STATE_DB;
		previousSchema = Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
		previousRunId = Bun.env.SPELL_AUTONOMY_RUN_ID;
		Bun.env.SPELL_AUTONOMY_STATE_DB = path.join(tempDir, "tool.sqlite");
		Bun.env.SPELL_AUTONOMY_RUN_ID = "tool-run";
		delete Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
	});

	afterEach(async () => {
		if (previousDb === undefined) delete Bun.env.SPELL_AUTONOMY_STATE_DB;
		else Bun.env.SPELL_AUTONOMY_STATE_DB = previousDb;
		if (previousSchema === undefined) delete Bun.env.SPELL_AUTONOMY_STATE_SCHEMA;
		else Bun.env.SPELL_AUTONOMY_STATE_SCHEMA = previousSchema;
		if (previousRunId === undefined) delete Bun.env.SPELL_AUTONOMY_RUN_ID;
		else Bun.env.SPELL_AUTONOMY_RUN_ID = previousRunId;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("typed schema rejects wrong type", async () => {
		Bun.env.SPELL_AUTONOMY_STATE_SCHEMA = JSON.stringify([{ name: "count", type: "number" }]);
		const tool = new AutonomyStateTool();
		const result = await tool.execute("call-1", { op: "set", key: "count", value: "oops" });
		expect(result.details).toEqual({ success: false, error: "Key 'count' expects number" });
	});

	it("typed schema allows correct type", async () => {
		Bun.env.SPELL_AUTONOMY_STATE_SCHEMA = JSON.stringify([{ name: "enabled", type: "boolean" }]);
		const tool = new AutonomyStateTool();
		await tool.execute("call-1", { op: "set", key: "enabled", value: true });
		const result = await tool.execute("call-2", { op: "get", key: "enabled" });
		expect(result.details).toEqual({ success: true, value: true });
	});

	it("is hidden by default and activates only when explicitly requested", async () => {
		expect(BUILTIN_TOOLS.autonomy_state).toBeUndefined();
		expect(HIDDEN_TOOLS.autonomy_state).toBeDefined();
		const defaultTools = await createTools(createSession(tempDir));
		expect(defaultTools.map(entry => entry.name)).not.toContain("autonomy_state");
		const tools = await createTools(createSession(tempDir), ["autonomy_state"]);
		const tool = tools.find(entry => entry.name === "autonomy_state");
		expect(tool).toBeDefined();
		await tool!.execute("call-1", { op: "set", key: "payload", value: { free: [1, "x", true] } });
		const result = await tool!.execute("call-2", { op: "get", key: "payload" });
		expect(result.details).toEqual({ success: true, value: { free: [1, "x", true] } });
	});

	it("skips activation when autonomy state env is missing", async () => {
		delete Bun.env.SPELL_AUTONOMY_STATE_DB;
		const tools = await createTools(createSession(tempDir), ["autonomy_state"]);
		expect(tools.map(entry => entry.name)).not.toContain("autonomy_state");
	});
});
