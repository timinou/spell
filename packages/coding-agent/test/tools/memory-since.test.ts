// PLAN-315 W7 T10.6 — diffMemorySince classifies added vs modified
// using filesystem birthtime, not just mtime.

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { diffMemorySince } from "../../src/tools/memory";

async function setup(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "spell-since-"));
	await fs.mkdir(path.join(root, ".spell", "memory", "concepts"), { recursive: true });
	await fs.mkdir(path.join(root, ".spell", "memory", "episodes"), { recursive: true });
	return root;
}

async function seedExistingConcept(root: string, id: string): Promise<string> {
	const file = path.join(root, ".spell", "memory", "concepts", `${id}.org`);
	// CUSTOM_ID must be in the drawer form (`:CUSTOM_ID:`) to be picked
	// up by the diffMemorySince extractor regex; frontmatter form
	// (`#+CUSTOM_ID:`) is not extracted by the since path.
	await fs.writeFile(
		file,
		`#+TITLE: ${id}\n:PROPERTIES:\n:CUSTOM_ID: ${id}\n:END:\n* Body\nseed\n`,
	);
	return file;
}

describe("PLAN-315 W7 (T10.6) — diffMemorySince added vs modified", () => {
	it("classifies a file CREATED after the cutoff as 'added'", async () => {
		const root = await setup();
		const t0Iso = new Date().toISOString();
		await new Promise(r => setTimeout(r, 10));
		await seedExistingConcept(root, "CON-just-born");

		const diff = await diffMemorySince(root, t0Iso);
		const addedIds = diff.added.map(e => e.id);
		expect(addedIds).toContain("CON-just-born");
		const modifiedIds = diff.modified.map(e => e.id);
		expect(modifiedIds).not.toContain("CON-just-born");

		await fs.rm(root, { recursive: true, force: true });
	});

	it("classifies a PRE-EXISTING file with mtime after cutoff as 'modified'", async () => {
		const root = await setup();
		const file = await seedExistingConcept(root, "CON-existing");

		// Cutoff is AFTER birth but BEFORE the second write.
		await new Promise(r => setTimeout(r, 10));
		const t0Iso = new Date().toISOString();
		await new Promise(r => setTimeout(r, 10));

		// Touch the file (changes mtime, leaves birthtime).
		await fs.writeFile(file, "updated content\n", { flag: "a" });

		const diff = await diffMemorySince(root, t0Iso);
		const modifiedIds = diff.modified.map(e => e.id);
		const addedIds = diff.added.map(e => e.id);
		expect(modifiedIds).toContain("CON-existing");
		expect(addedIds).not.toContain("CON-existing");

		await fs.rm(root, { recursive: true, force: true });
	});

	it("returns empty arrays when nothing changed since the cutoff", async () => {
		const root = await setup();
		await seedExistingConcept(root, "CON-quiet");
		// Capture cutoff AFTER seed → nothing happens after t0.
		await new Promise(r => setTimeout(r, 50));
		const t0Iso = new Date().toISOString();

		const diff = await diffMemorySince(root, t0Iso);
		expect(diff.added).toHaveLength(0);
		expect(diff.modified).toHaveLength(0);

		await fs.rm(root, { recursive: true, force: true });
	});

	it("returns added entries sorted by id", async () => {
		const root = await setup();
		const t0Iso = new Date().toISOString();
		await new Promise(r => setTimeout(r, 10));
		await seedExistingConcept(root, "CON-zeta");
		await seedExistingConcept(root, "CON-alpha");
		await seedExistingConcept(root, "CON-mu");

		const diff = await diffMemorySince(root, t0Iso);
		const ids = diff.added.map(e => e.id);
		expect(ids).toEqual(["CON-alpha", "CON-mu", "CON-zeta"]);

		await fs.rm(root, { recursive: true, force: true });
	});
});
