import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadSpellKdl, parseSpellKdl } from "../../src/config/spell-kdl";

async function makeTempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("parseSpellKdl", () => {
	it("parses domain node", async () => {
		const result = await parseSpellKdl('domain "coding"');
		expect(result.domain).toBe("coding");
		expect(result.policies.policies).toEqual([]);
	});

	it("parses layers and policies directly", async () => {
		const result = await parseSpellKdl(`
layer "api" description="API endpoints"

policy "api-quality" layer="api" {
    gate-commit #true
    gate-cmd "bun test"
}
`);
		expect(result.policies.layers).toEqual({ api: { description: "API endpoints" } });
		expect(result.policies.policies).toHaveLength(1);
		expect(result.policies.policies[0].name).toBe("api-quality");
		expect(result.policies.policies[0].gates.gateCommit).toBe(true);
		expect(result.policies.policies[0].gates.gateCmd).toBe("bun test");
	});

	it("parses appearance settings", async () => {
		const result = await parseSpellKdl(`
appearance {
	theme dark="titanium" light="light"
	symbols "unicode"
	color-blind #false
}
`);
		expect(result.settings).toMatchObject({
			theme: { dark: "titanium", light: "light" },
			symbolPreset: "unicode",
			colorBlindMode: false,
		});
	});

	it("parses providers block", async () => {
		const result = await parseSpellKdl(`
providers {
	web-search "auto"
	code-search "grep"
	image "auto"
	provider "anthropic" {
		api-key "$ANTHROPIC_API_KEY"
	}
}
`);
		expect(result.providers).toEqual({
			providers: {
				anthropic: { apiKey: "$ANTHROPIC_API_KEY" },
			},
			webSearch: "auto",
			codeSearch: "grep",
			image: "auto",
		});
	});

	it("parses keybindings block", async () => {
		const result = await parseSpellKdl(`
keybindings {
	interrupt "escape"
	clear "ctrl+c"
	exit "ctrl+d"
}
`);
		expect(result.keybindings).toEqual({
			interrupt: "escape",
			clear: "ctrl+c",
			exit: "ctrl+d",
		});
	});

	it("parses mode blocks with inline prose sections", async () => {
		const result = await parseSpellKdl(`
mode "plan" extends="base" {
	command "/plan"
	read-only #true
	context """
	Plan context
	"""
	instructions """
	Plan instructions
	"""
}
`);
		expect(result.modes).toEqual([
			{
				name: "plan",
				config: {
					extends: "base",
					command: "/plan",
					readOnly: true,
				},
				sections: {
					context: "Plan context",
					instructions: "Plan instructions",
					custom: {},
				},
			},
		]);
	});

	it("resolves file-relative imports and applies local overrides", async () => {
		const tmpDir = await makeTempDir("spell-kdl-import-");
		try {
			await Bun.write(
				path.join(tmpDir, "shared.kdl"),
				`domain "shared"
layer "shared" description="Shared layer"
keybindings { interrupt "escape" }
`,
			);
			const result = await parseSpellKdl(
				`import "./shared.kdl"
domain "local"
layer "local" description="Local layer"
`,
				tmpDir,
			);
			expect(result.domain).toBe("local");
			expect(result.policies.layers.shared).toEqual({ description: "Shared layer" });
			expect(result.policies.layers.local).toEqual({ description: "Local layer" });
			expect(result.keybindings).toEqual({ interrupt: "escape" });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("stops on import cycles", async () => {
		const tmpDir = await makeTempDir("spell-kdl-cycle-");
		try {
			await Bun.write(path.join(tmpDir, "a.kdl"), `import "./b.kdl"\nlayer "a" description="A"\n`);
			await Bun.write(path.join(tmpDir, "b.kdl"), `import "./a.kdl"\nlayer "b" description="B"\n`);
			const result = await parseSpellKdl(`import "./a.kdl"\n`, tmpDir);
			expect(result.policies.layers.a).toEqual({ description: "A" });
			expect(result.policies.layers.b).toEqual({ description: "B" });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns config with no domain for empty document", async () => {
		const result = await parseSpellKdl("");
		expect(result.domain).toBeUndefined();
		expect(result.settings).toEqual({});
		expect(result.policies).toEqual({ version: 1, layers: {}, policies: [] });
	});

	it("returns empty config for invalid KDL", async () => {
		const result = await parseSpellKdl('domain "broken" {');
		expect(result.domain).toBeUndefined();
		expect(result.settings).toEqual({});
		expect(result.policies).toEqual({ version: 1, layers: {}, policies: [] });
	});

	it("handles domain without imports or policies", async () => {
		const result = await parseSpellKdl('domain "growth"');
		expect(result.domain).toBe("growth");
		expect(result.policies.layers).toEqual({});
		expect(result.policies.policies).toEqual([]);
	});

	it("loads built-in imports", async () => {
		const result = await parseSpellKdl(`
domain "coding"
import "spell.coding.typescript"
`);
		expect(result.domain).toBe("coding");
		expect(Object.keys(result.policies.layers)).toEqual(expect.arrayContaining(["core", "api"]));
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

	it("returns empty config for invalid KDL file", async () => {
		await Bun.write(path.join(tmpDir, "spell.kdl"), "this is not { valid kdl");
		const result = await loadSpellKdl(tmpDir);
		expect(result).toBeDefined();
		expect(result!.domain).toBeUndefined();
		expect(result!.settings).toEqual({});
		expect(result!.policies).toEqual({ version: 1, layers: {}, policies: [] });
	});
});
