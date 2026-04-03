import { afterEach, describe, expect, it } from "bun:test";
import { createBuiltinActionRegistry } from "../../src/actions";
import { loadManifestFromFile, resolveGoalStateStores } from "../../src/manifest";
import { cleanupManifestProject, createManifestProject } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupManifestProject(dir)));
	tempDirs.clear();
});

describe("named state stores", () => {
	it("inherits setup-level state stores and applies goal-level additions deterministically", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "state-root"
version "1.0.0"
setup "worker" {
	domain "coding"
	state-store "workflow" backend="sqlite" path="./data/workflow.db"
	state-store "artifacts" backend="artifact-store" path="./artifacts"
}
goal "publish" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "spell.noop"
	state-store "workflow" backend="sqlite" path="./data/publish.db" schema="publish"
	state-store "cache" backend="sqlite" path="./data/cache.db"
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createBuiltinActionRegistry(),
		});
		const resolved = resolveGoalStateStores(manifest, "publish");

		expect(resolved).toEqual(
			new Map([
				["workflow", { backend: "sqlite", path: "./data/publish.db", schema: "publish" }],
				["artifacts", { backend: "artifact-store", path: "./artifacts" }],
				["cache", { backend: "sqlite", path: "./data/cache.db" }],
			]),
		);
	});

	it("fails fast for invalid backend references", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "bad-state"
version "1.0.0"
setup "worker" {
	domain "coding"
	state-store "workflow" backend="postgres" path="./data/workflow.db"
}
goal "publish" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "spell.noop"
}
`,
		});
		tempDirs.add(dir);

		await expect(
			loadManifestFromFile(manifestPath, {
				registry: createBuiltinActionRegistry(),
			}),
		).rejects.toThrow(/backend must be sqlite or artifact-store/);
	});
});
