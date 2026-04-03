import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { writeGrowthCuration } from "../src/actions/curation-writeback";
import { cleanupTempDir, createTempDir } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupTempDir(dir)));
	tempDirs.clear();
});

describe("curation writeback", () => {
	it("writes canonical kdl, normalized artifacts, and patch artifacts for append and update", async () => {
		const dir = await createTempDir("spell-growth-curation-");
		tempDirs.add(dir);
		const registryPath = path.join(dir, "sources.kdl");
		await Bun.write(
			registryPath,
			`source "ora" label="Ora" kind="website" value="https://ora.example" direct=#true priority=1\n`,
		);

		const appended = await writeGrowthCuration({
			registryPath,
			artifactDir: path.join(dir, "artifacts"),
			operation: "append",
			record: {
				slug: "rss",
				label: "RSS",
				kind: "rss",
				value: "https://ora.example/feed.xml",
				direct: true,
				priority: 2,
			},
		});
		expect(await Bun.file(registryPath).text()).toContain(`source "rss"`);
		expect(await Bun.file(appended.patchArtifactPath).text()).toContain(`+ source "rss"`);

		const updated = await writeGrowthCuration({
			registryPath,
			artifactDir: path.join(dir, "artifacts"),
			operation: "update",
			record: {
				slug: "ora",
				label: "Ora Ventures",
				kind: "website",
				value: "https://ora.example",
				direct: true,
				priority: 1,
			},
		});
		expect(await Bun.file(updated.normalizedArtifactPath).json()).toEqual(
			expect.objectContaining({ slug: "ora", label: "Ora Ventures" }),
		);
		expect(await Bun.file(updated.patchArtifactPath).text()).toContain('- source "ora"');
	});
});
