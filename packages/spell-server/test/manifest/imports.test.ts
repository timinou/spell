import { afterEach, describe, expect, it } from "bun:test";
import { createBuiltinActionRegistry } from "../../src/actions";
import { loadManifestFromFile } from "../../src/manifest";
import { cleanupManifestProject, createManifestProject } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupManifestProject(dir)));
	tempDirs.clear();
});

describe("manifest imports", () => {
	it("resolves alias imports relative paths and keeps imported symbols namespaced", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "import-root"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"
goal "dispatch" {
	setup "workflow.worker"
	schedule type="cron" expression="0 1 * * *"
	action "spell.noop"
}
`,
			"workflow/base.kdl": `setup "worker" {
	domain "coding"
	tools {
		allow "grep"
	}
}
goal "scan" {
	setup "worker"
	schedule type="cron" expression="0 2 * * *"
	action "spell.noop"
}
`,
		});
		tempDirs.add(dir);

		const manifest = await loadManifestFromFile(manifestPath, {
			registry: createBuiltinActionRegistry(),
		});

		expect(manifest.setups.get("workflow.worker")).toEqual({
			domain: "coding",
			tools: { allow: ["grep"] },
		});
		expect(manifest.goals.get("dispatch")?.setup).toBe("workflow.worker");
		expect(manifest.goals.has("workflow.scan")).toBe(true);
	});

	it("detects manifest import cycles with the full chain", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "cycle-root"
version "1.0.0"
import "./a.kdl" as="a"
`,
			"a.kdl": `import "./b.kdl" as="b"
setup "worker" { domain "coding" }
`,
			"b.kdl": `import "./autonomy.kdl" as="root"
setup "worker" { domain "coding" }
`,
		});
		tempDirs.add(dir);

		await expect(loadManifestFromFile(manifestPath)).rejects.toThrow(/Manifest import cycle detected/);
		await expect(loadManifestFromFile(manifestPath)).rejects.toThrow(
			/autonomy\.kdl -> .*a\.kdl -> .*b\.kdl -> .*autonomy\.kdl/,
		);
	});

	it("allows explicit overrides to materialize imported symbols under local names", async () => {
		const { dir, manifestPath } = await createManifestProject({
			"autonomy.kdl": `name "override-root"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"
override "setup" "worker" from="workflow.worker" strategy="merge" {
	mode "worker"
	tools {
		allow "read"
	}
	timeout "15m"
}
goal "dispatch" {
	setup "worker"
	schedule type="cron" expression="0 1 * * *"
	action "spell.noop"
}
`,
			"workflow/base.kdl": `setup "worker" {
	domain "coding"
	tools {
		allow "grep"
		deny "bash"
	}
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
			tools: {
				allow: ["grep", "read"],
				deny: ["bash"],
			},
			timeout: "15m",
		});
		expect(manifest.goals.get("dispatch")?.setup).toBe("worker");
	});
});
