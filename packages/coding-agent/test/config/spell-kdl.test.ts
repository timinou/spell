import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadSpellKdl, parseSpellKdl } from "../../src/config/spell-kdl";

describe("parseSpellKdl", () => {
	it("parses domain node", () => {
		const result = parseSpellKdl('domain "coding"');
		expect(result).toBeDefined();
		expect(result!.domain).toBe("coding");
		expect(result!.policies.policies).toEqual([]);
	});

	it("parses layers and policies directly", () => {
		const result = parseSpellKdl(`
layer "api" description="API endpoints"

policy "api-quality" layer="api" {
    gate-commit #true
    gate-cmd "bun test"
}
`);
		expect(result).toBeDefined();
		expect(result!.policies.layers).toEqual({ api: { description: "API endpoints" } });
		expect(result!.policies.policies).toHaveLength(1);
		expect(result!.policies.policies[0].name).toBe("api-quality");
		expect(result!.policies.policies[0].gates.gateCommit).toBe(true);
		expect(result!.policies.policies[0].gates.gateCmd).toBe("bun test");
	});

	it("resolves a single import", () => {
		const result = parseSpellKdl(`
domain "coding"
import "spell.coding.typescript"
`);
		expect(result).toBeDefined();
		expect(result!.domain).toBe("coding");
		// Template provides core, api, ui, data layers
		expect(Object.keys(result!.policies.layers)).toEqual(expect.arrayContaining(["core", "api", "ui", "data"]));
		// Template provides policies
		expect(result!.policies.policies.length).toBeGreaterThanOrEqual(1);
	});

	it("local policy overrides imported policy by name", () => {
		const result = parseSpellKdl(`
import "spell.coding.typescript"

policy "api-quality" layer="api" {
    gate-cmd "bun test src/api/"
}
`);
		expect(result).toBeDefined();
		const apiPolicy = result!.policies.policies.find(p => p.name === "api-quality");
		expect(apiPolicy).toBeDefined();
		// Local override replaces the template's gate-cmd
		expect(apiPolicy!.gates.gateCmd).toBe("bun test src/api/");
		// The template's gateCommit is NOT present because the local policy fully replaces it
		expect(apiPolicy!.gates.gateCommit).toBeUndefined();
	});

	it("local layer overrides imported layer by key", () => {
		const result = parseSpellKdl(`
import "spell.coding.typescript"

layer "api" description="Custom API description"
`);
		expect(result).toBeDefined();
		expect(result!.policies.layers.api).toEqual({ description: "Custom API description" });
		// Other imported layers still present
		expect(result!.policies.layers.core).toBeDefined();
	});

	it("multiple imports merge in order", () => {
		const result = parseSpellKdl(`
import "spell.coding.typescript"
import "spell.growth.default"
`);
		expect(result).toBeDefined();
		// Has layers from both templates
		expect(result!.policies.layers.core).toBeDefined(); // from typescript
		expect(result!.policies.layers.content).toBeDefined(); // from growth
		expect(result!.policies.layers.analytics).toBeDefined(); // from growth
	});

	it("unknown import namespace is skipped", () => {
		const result = parseSpellKdl(`
domain "coding"
import "spell.nonexistent.template"

layer "custom" description="A custom layer"
`);
		expect(result).toBeDefined();
		expect(result!.domain).toBe("coding");
		// Only the local layer is present, no template layers
		expect(Object.keys(result!.policies.layers)).toEqual(["custom"]);
	});

	it("returns config with no domain for empty document", () => {
		const result = parseSpellKdl("");
		expect(result).toBeDefined();
		expect(result!.domain).toBeUndefined();
		expect(result!.policies).toEqual({ version: 1, layers: {}, policies: [] });
	});

	it("returns undefined for invalid KDL", () => {
		const result = parseSpellKdl('domain "broken" {');
		expect(result).toBeUndefined();
	});

	it("handles domain without imports or policies", () => {
		const result = parseSpellKdl('domain "growth"');
		expect(result).toBeDefined();
		expect(result!.domain).toBe("growth");
		expect(result!.policies.layers).toEqual({});
		expect(result!.policies.policies).toEqual([]);
	});
});

describe("loadSpellKdl", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-kdl-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined when spell.kdl does not exist", async () => {
		const result = await loadSpellKdl(tmpDir);
		expect(result).toBeUndefined();
	});

	it("loads and parses spell.kdl from project directory", async () => {
		await Bun.write(path.join(tmpDir, "spell.kdl"), `domain "coding"\nimport "spell.coding.typescript"\n`);
		const result = await loadSpellKdl(tmpDir);
		expect(result).toBeDefined();
		expect(result!.domain).toBe("coding");
		expect(Object.keys(result!.policies.layers).length).toBeGreaterThan(0);
	});

	it("returns undefined for invalid KDL file", async () => {
		await Bun.write(path.join(tmpDir, "spell.kdl"), "this is not { valid kdl");
		const result = await loadSpellKdl(tmpDir);
		expect(result).toBeUndefined();
	});
});
