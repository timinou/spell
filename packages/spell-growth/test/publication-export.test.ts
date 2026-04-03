import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { exportPublicationArtifacts, slugifyTitle } from "../src/actions/export-publish";
import { cleanupTempDir, createTempDir } from "./test-helpers";

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...tempDirs].map(async dir => cleanupTempDir(dir)));
	tempDirs.clear();
});

describe("publication export", () => {
	it("validates contract, generates slugs, and writes cms and repo artifacts", async () => {
		const cmsDir = await createTempDir("spell-growth-cms-");
		const repoDir = await createTempDir("spell-growth-drafts-");
		tempDirs.add(cmsDir);
		tempDirs.add(repoDir);
		const result = await exportPublicationArtifacts({
			cmsOutboxDir: cmsDir,
			repoDraftDir: repoDir,
			items: [
				{
					id: "article-1",
					title: "Automation for Finance Teams",
					summary: "Summary",
					canonicalUrl: "https://example.com/post",
					body: "Body",
					publishedAt: "2026-04-02",
				},
			],
		});

		expect(slugifyTitle("Automation for Finance Teams")).toBe("automation-for-finance-teams");
		expect(result.cmsPath).toBe(path.join(cmsDir, "publication-export.json"));
		expect(result.draftPaths[0]).toBe(path.join(repoDir, "automation-for-finance-teams.md"));
		expect(await Bun.file(result.draftPaths[0]).text()).toContain("canonicalUrl: https://example.com/post");

		await expect(
			exportPublicationArtifacts({
				cmsOutboxDir: cmsDir,
				repoDraftDir: repoDir,
				items: [{ id: "bad", title: "", summary: "", canonicalUrl: "", body: "" }],
			}),
		).rejects.toThrow(/missing required fields/);
	});
});
