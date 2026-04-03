import { afterEach, describe, expect, it } from "bun:test";
import { ActionRegistry } from "../../src/actions";
import { loadManifestFromFile } from "../../src/manifest";
import { cleanupManifestProject, createManifestProject } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupManifestProject(dir)));
	tempDirs.clear();
});

function createEnvRegistry(): ActionRegistry {
	const registry = new ActionRegistry();
	registry.register({
		id: "test.toggle",
		source: "first-party",
		params: {
			enabled: { type: "boolean", required: true },
			limit: { type: "number", required: true },
			label: { type: "string", required: true },
		},
	});
	return registry;
}

describe("manifest env resolution", () => {
	it("resolves string, number, and boolean env references at load time", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "env-root"
version "1.0.0"
setup "worker" {
	domain "coding"
	max-cost-usd "env(MAX_COST, type=number)"
	state-store "workflow" backend="sqlite" path="env(WORKFLOW_DB)"
}
goal "toggle" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "test.toggle" {
		param "enabled" "env(ENABLED, type=boolean)"
		param "limit" "env(LIMIT, type=number)"
		param "label" "env(LABEL)"
	}
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createEnvRegistry(),
			env: {
				MAX_COST: "12.5",
				WORKFLOW_DB: "./data/workflow.db",
				ENABLED: "true",
				LIMIT: "7",
				LABEL: "nightly",
			},
		});

		expect(manifest.setups.get("worker")?.maxCostUsd).toBe(12.5);
		expect(manifest.setups.get("worker")?.stateStores).toEqual(
			new Map([["workflow", { backend: "sqlite", path: "./data/workflow.db" }]]),
		);
		expect(manifest.goals.get("toggle")?.action?.params).toEqual({
			enabled: true,
			limit: 7,
			label: "nightly",
		});
	});

	it("supports defaulted env references without silent empty-string coercion", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "env-defaults"
version "1.0.0"
setup "worker" {
	domain "coding"
	state-store "cache" backend="sqlite" path="env(CACHE_DB, default=cache-db)"
}
goal "toggle" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "test.toggle" {
		param "enabled" #true
		param "limit" 2
		param "label" "manual"
	}
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createEnvRegistry(),
			env: {},
		});

		expect(manifest.setups.get("worker")?.stateStores).toEqual(
			new Map([["cache", { backend: "sqlite", path: "cache-db" }]]),
		);
	});

	it("fails on missing or empty required env references", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "env-required"
version "1.0.0"
setup "worker" {
	domain "coding"
	state-store "workflow" backend="sqlite" path="env(WORKFLOW_DB)"
}
goal "toggle" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "test.toggle" {
		param "enabled" #true
		param "limit" 2
		param "label" "manual"
	}
}
`,
		});
		tempDirs.add(dir);

		await expect(
			loadManifestFromFile(manifestPath, {
				registry: createEnvRegistry(),
				env: {},
			}),
		).rejects.toThrow(/WORKFLOW_DB/);
		await expect(
			loadManifestFromFile(manifestPath, {
				registry: createEnvRegistry(),
				env: { WORKFLOW_DB: "" },
			}),
		).rejects.toThrow(/WORKFLOW_DB/);
	});
});
