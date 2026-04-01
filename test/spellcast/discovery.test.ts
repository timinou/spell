import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSpellcastManifests } from "@oh-my-pi/pi-coding-agent/spellcast/discovery";

async function writeManifest(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
}

function manifestYaml(name: string, entry = "Main.qml"): string {
	return `
name: ${name}
entry: ${entry}
files:
  - ${entry}
`;
}

describe("discoverSpellcastManifests", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	async function createTempRoot(): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spellcast-discovery-"));
		tempDirs.push(root);
		return root;
	}

	test("discovers manifests recursively up to max depth", async () => {
		const root = await createTempRoot();
		await writeManifest(path.join(root, "root.spellcast.manifest.yaml"), manifestYaml("root"));
		await writeManifest(
			path.join(root, "a", "b", "c", "depth-3.spellcast.manifest.yaml"),
			manifestYaml("depth-3"),
		);
		await writeManifest(
			path.join(root, "a", "b", "c", "d", "depth-4.spellcast.manifest.yaml"),
			manifestYaml("depth-4"),
		);

		const result = await discoverSpellcastManifests(root);
		const discovered = result.manifests
			.map(item => path.relative(root, item.manifestPath).replaceAll("\\", "/"))
			.sort();

		expect(discovered).toEqual([
			"a/b/c/depth-3.spellcast.manifest.yaml",
			"root.spellcast.manifest.yaml",
		]);
	});

	test("skips node_modules, .git, and .local directories", async () => {
		const root = await createTempRoot();
		await writeManifest(path.join(root, "src", "good.spellcast.manifest.yaml"), manifestYaml("good"));
		await writeManifest(
			path.join(root, "node_modules", "pkg", "skip.spellcast.manifest.yaml"),
			manifestYaml("skip-node-modules"),
		);
		await writeManifest(path.join(root, ".git", "skip.spellcast.manifest.yaml"), manifestYaml("skip-git"));
		await writeManifest(path.join(root, ".local", "skip.spellcast.manifest.yaml"), manifestYaml("skip-local"));

		const result = await discoverSpellcastManifests(root);
		expect(result.manifests).toHaveLength(1);
		expect(path.basename(result.manifests[0]!.manifestPath)).toBe("good.spellcast.manifest.yaml");
	});

	test("returns empty manifests when no manifest files exist", async () => {
		const root = await createTempRoot();
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await Bun.write(path.join(root, "src", "Main.qml"), "import QtQuick 2.15");

		const result = await discoverSpellcastManifests(root);
		expect(result.manifests).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("returns warnings for invalid manifests without failing discovery", async () => {
		const root = await createTempRoot();
		await writeManifest(path.join(root, "valid.spellcast.manifest.yaml"), manifestYaml("valid"));
		await writeManifest(
			path.join(root, "invalid.spellcast.manifest.yaml"),
			`name: invalid\nfiles:\n  - Main.qml\n`,
		);

		const result = await discoverSpellcastManifests(root);

		expect(result.manifests).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("invalid.spellcast.manifest.yaml");
	});
});
