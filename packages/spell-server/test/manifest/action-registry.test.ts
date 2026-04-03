import { afterEach, describe, expect, it } from "bun:test";
import { ActionRegistry, createBuiltinActionRegistry } from "../../src/actions";
import { loadManifestFromFile } from "../../src/manifest";
import { cleanupManifestProject, createManifestProject } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupManifestProject(dir)));
	tempDirs.clear();
});

describe("action registry", () => {
	it("rejects unknown action ids", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "unknown-action"
version "1.0.0"
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "growth.discovery"
}
`,
		});
		tempDirs.add(dir);

		await expect(
			loadManifestFromFile(manifestPath, {
				registry: createBuiltinActionRegistry(),
			}),
		).rejects.toThrow(/Unknown action id/);
	});

	it("validates typed params and required prompt slots", async () => {
		const registry = new ActionRegistry();
		registry.register({
			id: "test.review",
			source: "first-party",
			params: {
				limit: { type: "number", required: true },
				dryRun: { type: "boolean" },
			},
			promptSlots: {
				review: { required: true },
			},
		});
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "typed-action"
version "1.0.0"
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "test.review" {
		param "limit" 5
		param "dryRun" #true
		prompt "review" "Review the staged digest."
	}
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, { registry });
		expect(manifest.goals.get("run")?.action?.params).toEqual({ limit: 5, dryRun: true });
		expect(manifest.goals.get("run")?.action?.promptSlots.review.content).toBe("Review the staged digest.");

		const invalidProject = await createManifestProject({
			"autonomy.kdl": `name "typed-action-invalid"
version "1.0.0"
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "test.review" {
		param "limit" "five"
	}
}
`,
		});
		tempDirs.add(invalidProject.dir);

		await expect(loadManifestFromFile(invalidProject.manifestPath, { registry })).rejects.toThrow(
			/must be a number/i,
		);
	});

	it("keeps built-in registry first-party only", () => {
		const registry = createBuiltinActionRegistry();
		expect(registry.list().every(descriptor => descriptor.source === "first-party")).toBe(true);
		expect(() =>
			registry.register({
				id: "external.review",
				source: "external" as never,
			}),
		).toThrow(/first-party descriptors only/);
	});
});
