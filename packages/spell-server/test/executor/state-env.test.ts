import { describe, expect, it } from "bun:test";
import type { AutonomyManifest } from "../../src/manifest/types";
import { AutonomyLifecycle } from "../../src/session/autonomy-lifecycle";

function createMinimalManifest(overrides: Partial<AutonomyManifest> = {}): AutonomyManifest {
	return {
		name: "test",
		version: "1.0.0",
		setups: new Map(),
		goals: new Map(),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: [],
		toolModules: [],
		operatorActions: [],
		...overrides,
	};
}

const baseOptions = {
	cwd: "/tmp/test",
	tools: ["read", "grep"],
};

describe("AutonomyLifecycle env wiring", () => {
	it("goal with sqlite state-store produces SPELL_AUTONOMY_STATE_STORES env var", () => {
		const manifest = createMinimalManifest({
			setups: new Map([
				["worker", { domain: "coding", stateStores: new Map([["workflow", { backend: "sqlite", path: "./data/workflow.db" }]]) }],
			]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		expect(result.env).toBeDefined();
		const stores = JSON.parse(result.env!.SPELL_AUTONOMY_STATE_STORES);
		expect(stores).toEqual({ workflow: "./data/workflow.db" });
	});

	it("multiple state-stores produce correct JSON", () => {
		const manifest = createMinimalManifest({
			setups: new Map([
				[
					"worker",
					{
						domain: "coding",
						stateStores: new Map([
							["workflow", { backend: "sqlite", path: "./data/workflow.db" }],
							["audit", { backend: "sqlite", path: "./data/audit.db" }],
						]),
					},
				],
			]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		const stores = JSON.parse(result.env!.SPELL_AUTONOMY_STATE_STORES);
		expect(stores).toEqual({ workflow: "./data/workflow.db", audit: "./data/audit.db" });
	});

	it("state schemas from manifest are serialized into SPELL_AUTONOMY_STATE_SCHEMAS", () => {
		const tables = [{ name: "articles", columns: [{ name: "id", type: "text", primary: true }, { name: "title", type: "text" }] }];
		const manifest = createMinimalManifest({
			setups: new Map([
				["worker", { domain: "coding", stateStores: new Map([["workflow", { backend: "sqlite", path: "./data/workflow.db", schema: "workflow-db" }]]) }],
			]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
			stateSchemas: [{ id: "workflow-db", backend: "sqlite", tables }],
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		expect(result.env!.SPELL_AUTONOMY_STATE_SCHEMAS).toBeDefined();
		const schemas = JSON.parse(result.env!.SPELL_AUTONOMY_STATE_SCHEMAS);
		expect(schemas.workflow.tables).toEqual(tables);
	});

	it("non-sqlite stores are excluded from SPELL_AUTONOMY_STATE_STORES", () => {
		const manifest = createMinimalManifest({
			setups: new Map([
				[
					"worker",
					{
						domain: "coding",
						stateStores: new Map([
							["workflow", { backend: "sqlite", path: "./data/workflow.db" }],
							["artifacts", { backend: "artifact-store", path: "./artifacts" }],
						]),
					},
				],
			]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		const stores = JSON.parse(result.env!.SPELL_AUTONOMY_STATE_STORES);
		expect(stores).toEqual({ workflow: "./data/workflow.db" });
		expect(stores.artifacts).toBeUndefined();
	});

	it("goals without state-stores produce no env vars", () => {
		const manifest = createMinimalManifest({
			setups: new Map([["worker", { domain: "coding" }]]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		expect(result.env).toBeUndefined();
	});

	it("goal state-stores override setup state-stores of the same name", () => {
		const manifest = createMinimalManifest({
			setups: new Map([
				["worker", { domain: "coding", stateStores: new Map([["workflow", { backend: "sqlite", path: "./data/setup.db" }]]) }],
			]),
			goals: new Map([
				[
					"test-goal",
					{
						setup: "worker",
						schedule: { type: "cron", expression: "0 * * * *" },
						prompt: "do stuff",
						stateStores: new Map([["workflow", { backend: "sqlite", path: "./data/goal.db" }]]),
					},
				],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);

		const stores = JSON.parse(result.env!.SPELL_AUTONOMY_STATE_STORES);
		expect(stores.workflow).toBe("./data/goal.db");
	});

	it("unknown goal name produces empty env", () => {
		const manifest = createMinimalManifest();
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("nonexistent", baseOptions);

		expect(result.env).toBeUndefined();
	});

	it("always includes autonomy_state tool", () => {
		const manifest = createMinimalManifest({
			setups: new Map([["worker", { domain: "coding" }]]),
			goals: new Map([
				["test-goal", { setup: "worker", schedule: { type: "cron", expression: "0 * * * *" }, prompt: "do stuff" }],
			]),
		});
		const lifecycle = new AutonomyLifecycle(manifest);
		const result = lifecycle.buildSpawnOptions("test-goal", baseOptions);
		expect(result.tools).toContain("autonomy_state");
	});
});
