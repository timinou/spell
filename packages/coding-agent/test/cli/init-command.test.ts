import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runInitCommand } from "../../src/cli/init-cli";
import { parseSpellKdl } from "../../src/config/spell-kdl";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-init-"));
	tempDirs.push(tempDir);
	return tempDir;
}

describe("runInitCommand", () => {
	beforeEach(() => {
		spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(async () => {
		spyOn(process, "cwd").mockRestore();
		spyOn(process.stdout, "write").mockRestore();
		await Promise.all(tempDirs.splice(0).map(tempDir => fs.rm(tempDir, { recursive: true, force: true })));
	});

	it("creates spell.kdl for a TypeScript project", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				name: "test-app",
				scripts: { test: "bun test" },
				devDependencies: { typescript: "^5" },
			}),
		);
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: {} });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		const config = parseSpellKdl(content);
		expect(content).toContain('domain "coding"');
		expect(content).toContain('import "spell.coding.typescript"');
		expect(config).toBeDefined();
		expect(config!.policies.policies.find(policy => policy.name === "api-quality")?.gates.gateCmd).toBe("bun test");
	});

	it("uses the growth template when domain is overridden", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), JSON.stringify({ name: "growth-app" }));
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: { domain: "growth" } });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		expect(content).toContain('domain "growth"');
		expect(content).toContain('import "spell.growth.default"');
		expect(parseSpellKdl(content)).toBeDefined();
	});

	it("overwrites spell.kdl when force is set", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), JSON.stringify({ name: "force-app" }));
		await Bun.write(path.join(tempDir, "spell.kdl"), 'domain "old"\n');
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: { force: true } });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		expect(content).not.toContain('domain "old"');
		expect(content).toContain('domain "coding"');
		expect(parseSpellKdl(content)).toBeDefined();
	});

	it("does not overwrite spell.kdl without force", async () => {
		const tempDir = await createTempDir();
		const originalContent = 'domain "existing"\n';
		await Bun.write(path.join(tempDir, "spell.kdl"), originalContent);
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: {} });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		expect(content).toBe(originalContent);
	});

	it("creates .spell/AGENTS.md with the project name", async () => {
		const tempDir = await createTempDir();
		await Bun.write(path.join(tempDir, "package.json"), JSON.stringify({ name: "agents-app" }));
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: {} });

		const content = await Bun.file(path.join(tempDir, ".spell", "AGENTS.md")).text();
		expect(content).toContain("agents-app");
	});

	it("creates a minimal spell.kdl for an unknown project", async () => {
		const tempDir = await createTempDir();
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: {} });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		expect(content).toContain('domain "coding"');
		expect(content).not.toContain("import ");
		expect(parseSpellKdl(content)).toBeDefined();
	});

	it("uses language template for arbitrary custom domain", async () => {
		const tempDir = await createTempDir();
		await Bun.write(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "ops-app", devDependencies: { typescript: "^5" } }),
		);
		spyOn(process, "cwd").mockReturnValue(tempDir);

		await runInitCommand({ flags: { domain: "ops" } });

		const content = await Bun.file(path.join(tempDir, "spell.kdl")).text();
		expect(content).toContain('domain "ops"');
		// Custom non-growth domain still uses language-specific template
		expect(content).toContain('import "spell.coding.typescript"');
		const config = parseSpellKdl(content);
		expect(config).toBeDefined();
		expect(config!.domain).toBe("ops");
	});
});
