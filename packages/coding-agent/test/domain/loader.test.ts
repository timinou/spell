import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadDomain } from "../../src/domain/loader";

describe("loadDomain", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-domain-load-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("loads the built-in coding manifest without project files", async () => {
		const manifest = await loadDomain("coding", tempDir);

		expect(manifest.name).toBe("coding");
		expect(manifest.workspaces).toEqual([]);
	});

	it("loads a workspace domain manifest from domain/<name>/manifest.ts", async () => {
		await Bun.write(
			path.join(tempDir, "domain", "growth", "manifest.ts"),
			'export default { name: "growth", description: "Growth", tools: {}, panels: [], workspaces: [] };',
		);

		const manifest = await loadDomain("growth", tempDir);

		expect(manifest.name).toBe("growth");
		expect(manifest.description).toBe("Growth");
	});

	it("fails fast when the domain manifest file is missing", async () => {
		await expect(loadDomain("growth", tempDir)).rejects.toThrow("Failed to load domain manifest 'growth'");
	});

	it("fails fast when the manifest name does not match the requested domain", async () => {
		await Bun.write(
			path.join(tempDir, "domain", "growth", "manifest.ts"),
			'export default { name: "coding", description: "Mismatch", tools: {}, panels: [], workspaces: [] };',
		);

		await expect(loadDomain("growth", tempDir)).rejects.toThrow("field 'name' must equal 'growth'");
	});

	it("fails fast when optional manifest fields have the wrong type", async () => {
		await Bun.write(
			path.join(tempDir, "domain", "growth", "manifest.ts"),
			'export default { name: "growth", description: "Growth", tools: {}, panels: [], workspaces: [], contextFiles: [123] };',
		);

		await expect(loadDomain("growth", tempDir)).rejects.toThrow("field 'contextFiles' must be an array of strings");
	});
});
