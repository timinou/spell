import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "@bgotink/kdl";

import { parseModeBlocks } from "../../src/config/kdl-modes";
import { parseSpellKdl, spellKdlModesToModeConfigs } from "../../src/config/spell-kdl";

describe("parseModeBlocks", () => {
	it("parses a single mode with all fields", () => {
		const doc = parse(`
mode "plan" extends="base" {
	command "/plan"
	read-only #true
	context-policy "fresh"
	instructions "./modes/plan/MODE.md"
	tools {
		allow "read" "grep"
		deny "write"
	}
	categories "features" "bugs"
	gates {
		decomposition #true
		allow-edits #false
	}
}
`);

		expect(parseModeBlocks(doc)).toEqual([
			{
				name: "plan",
				config: {
					extends: "base",
					command: "/plan",
					readOnly: true,
					contextPolicy: "fresh",
					instructions: "./modes/plan/MODE.md",
					tools: { allow: ["read", "grep"], deny: ["write"] },
					categories: ["features", "bugs"],
					gates: { decomposition: true, allowEdits: false },
				},
				instructionsPath: "./modes/plan/MODE.md",
			},
		]);
	});

	it("parses a minimal mode", () => {
		const doc = parse('mode "base"');
		expect(parseModeBlocks(doc)).toEqual([{ name: "base", config: {}, instructionsPath: undefined }]);
	});

	it("parses tools allow list", () => {
		const doc = parse(`
mode "plan" {
	tools {
		allow "read" "grep" "find"
	}
}
`);
		expect(parseModeBlocks(doc)[0].config).toEqual({ tools: { allow: ["read", "grep", "find"] } });
	});

	it("parses extends property", () => {
		const doc = parse('mode "plan" extends="base"');
		expect(parseModeBlocks(doc)[0].config).toEqual({ extends: "base" });
	});

	it("parses multiple modes", () => {
		const doc = parse(`
mode "plan" { command "/plan" }
mode "review" { command "/review" }
`);
		expect(parseModeBlocks(doc).map(mode => mode.name)).toEqual(["plan", "review"]);
	});

	it("returns empty array when no mode nodes exist", () => {
		const doc = parse('domain "coding"');
		expect(parseModeBlocks(doc)).toEqual([]);
	});

	it("adapts spell.kdl mode blocks into runtime mode configs with instruction file sections", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-kdl-modes-"));
		try {
			await Bun.write(
				path.join(projectDir, "plan.md"),
				`---kdl
name "ignored"
description "Loaded from instructions file"
---
## Context
Project plan context

## Instructions
Project plan instructions`,
			);
			const parsed = await parseSpellKdl(
				`mode "plan" extends="base" {
	command "/plan"
	read-only #true
	tools {
		allow "read" "grep"
	}
	instructions "./plan.md"
}`,
				projectDir,
			);

			const result = await spellKdlModesToModeConfigs(
				parsed.modes ?? [],
				path.join(projectDir, "spell.kdl"),
				projectDir,
				"test",
			);

			expect(result.warnings).toEqual([]);
			expect(result.items).toHaveLength(1);
			expect(result.items[0]).toMatchObject({
				name: "plan",
				frontmatter: {
					description: "Loaded from instructions file",
					extends: "base",
					command: "/plan",
					readOnly: true,
					tools: { allow: ["read", "grep"] },
				},
				sections: {
					context: "Project plan context",
					instructions: "Project plan instructions",
					custom: {},
				},
			});
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
