import { afterEach, describe, expect, it } from "bun:test";
import { ActionRegistry, createBuiltinActionRegistry } from "../../src/actions";
import { loadManifestFromFile, parseManifestKdl, serializeManifestKdl } from "../../src/manifest";
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

	it("parses and round-trips json params", async () => {
		const registry = new ActionRegistry();
		registry.register({
			id: "test.review-json",
			source: "first-party",
			params: {
				payload: { type: "json", required: true },
			},
		});
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "typed-action-json"
	version "1.0.0"
	setup "worker" { domain "coding" }
	goal "run" {
		setup "worker"
		schedule type="cron" expression="0 1 * * *"
		action "test.review-json" {
			param-json "payload" "{\\"summary\\":\\"ok\\",\\"metrics\\":[1,{\\"passed\\":true}],\\"details\\":{\\"owner\\":\\"qa\\"}}"
		}
	}
	`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, { registry });
		expect(manifest.goals.get("run")?.action?.params).toEqual({
			payload: {
				summary: "ok",
				metrics: [1, { passed: true }],
				details: { owner: "qa" },
			},
		});

		const rendered = serializeManifestKdl(manifest);
		expect(rendered).toContain("param-json payload");
		const reparsed = parseManifestKdl(rendered, { registry });
		expect(reparsed.goals.get("run")?.action?.params).toEqual(manifest.goals.get("run")?.action?.params);
	});

	it("rejects invalid json param payloads", async () => {
		const registry = new ActionRegistry();
		registry.register({
			id: "test.review-json",
			source: "first-party",
			params: {
				payload: { type: "json", required: true },
			},
		});
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "typed-action-json-invalid"
	version "1.0.0"
	setup "worker" { domain "coding" }
	goal "run" {
		setup "worker"
		schedule type="cron" expression="0 1 * * *"
		action "test.review-json" {
			param-json "payload" "{not valid json}"
		}
	}
	`,
		});
		tempDirs.add(dir);

		await expect(loadManifestFromFile(manifestPath, { registry })).rejects.toThrow(/must be valid JSON/i);
	});

	it("loads KDL-declared action descriptors with project source", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "kdl-actions"
version "1.0.0"
action-descriptor "my.action" source="project"
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "my.action"
}
`,
		});
		tempDirs.add(dir);
		const registry = createBuiltinActionRegistry();
		const manifest = await loadManifestFromFile(manifestPath, { registry });
		expect(manifest.goals.get("run")?.action?.id).toBe("my.action");
		expect(registry.get("my.action")?.source).toBe("project");
	});

	it("validates params declared in KDL action descriptors", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "kdl-action-params"
version "1.0.0"
action-descriptor "my.typed" source="project" {
	param "limit" type="number" required=#true
	prompt-slot "context" required=#true
}
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "my.typed" {
		param "limit" "not-a-number"
	}
}
`,
		});
		tempDirs.add(dir);
		await expect(loadManifestFromFile(manifestPath, { registry: createBuiltinActionRegistry() })).rejects.toThrow(
			/Action param "limit" must be number/i,
		);
	});

	it("registers action descriptors from imported modules", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"actions.kdl": `action-descriptor "custom.review" source="project" {
	param "maxItems" type="number"
}
`,
			"autonomy.kdl": `name "imported-actions"
version "1.0.0"
import "./actions.kdl" as="ext"
setup "worker" { domain "coding" }
goal "run" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "custom.review" {
		param "maxItems" 10
	}
}
`,
		});
		tempDirs.add(dir);
		const registry = createBuiltinActionRegistry();
		const manifest = await loadManifestFromFile(manifestPath, { registry });
		expect(manifest.goals.get("run")?.action?.params).toEqual({ maxItems: 10 });
		expect(registry.get("custom.review")?.source).toBe("project");
	});

	it("keeps built-in registry first-party only", () => {
		const registry = createBuiltinActionRegistry();
		expect(registry.list().every(descriptor => descriptor.source === "first-party")).toBe(true);
		expect(() =>
			registry.register({
				id: "external.review",
				source: "external" as never,
			}),
		).toThrow(/first-party or project descriptors only/);
	});
});
