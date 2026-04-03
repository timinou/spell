import { afterEach, describe, expect, it } from "bun:test";
import { createBuiltinActionRegistry } from "../../src/actions";
import { loadManifestFromFile } from "../../src/manifest";
import { cleanupManifestProject, createManifestProject } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupManifestProject(dir)));
	tempDirs.clear();
});

describe("manifest merge strategies", () => {
	it("merges collection fields according to schema metadata", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "merge-root"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"
override "setup" "worker" from="workflow.worker" strategy="merge" {
	tools {
		allow "read"
	}
	sandbox {
		paths-write "outbox/"
	}
	state-store "audit" backend="artifact-store" path="./artifacts/audit"
	timeout "10m"
}
`,
			"workflow/base.kdl": `setup "worker" {
	domain "coding"
	tools {
		allow "grep"
		deny "bash"
	}
	sandbox {
		paths-write "data/"
	}
	state-store "workflow" backend="sqlite" path="./workflow.db"
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createBuiltinActionRegistry(),
		});
		const setup = manifest.setups.get("worker");

		expect(setup).toEqual({
			domain: "coding",
			tools: {
				allow: ["grep", "read"],
				deny: ["bash"],
			},
			sandbox: {
				pathsWrite: ["data/", "outbox/"],
			},
			stateStores: new Map([
				["workflow", { backend: "sqlite", path: "./workflow.db" }],
				["audit", { backend: "artifact-store", path: "./artifacts/audit" }],
			]),
			timeout: "10m",
		});
	});

	it("supports whole-symbol replace overrides", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "replace-root"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"
override "setup" "worker" from="workflow.worker" strategy="replace" {
	domain "coding"
	mode "worker"
	tools {
		allow "read"
	}
}
`,
			"workflow/base.kdl": `setup "worker" {
	domain "coding"
	tools {
		allow "grep"
		deny "bash"
	}
	timeout "30m"
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createBuiltinActionRegistry(),
		});

		expect(manifest.setups.get("worker")).toEqual({
			domain: "coding",
			mode: "worker",
			tools: { allow: ["read"] },
		});
	});

	it("rejects field merges for non-mergeable goal fields", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "bad-merge"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"
override "goal" "publish" from="workflow.publish" strategy="merge" {
	schedule type="cron" expression="0 5 * * *"
}
`,
			"workflow/base.kdl": `setup "worker" { domain "coding" }
goal "publish" {
	setup "worker"
	schedule type="cron" expression="0 2 * * *"
	action "spell.noop"
}
`,
		});
		tempDirs.add(dir);

		await expect(
			loadManifestFromFile(manifestPath, {
				registry: createBuiltinActionRegistry(),
			}),
		).rejects.toThrow(/schedule is not mergeable/);
	});
});
