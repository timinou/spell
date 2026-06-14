import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "@bgotink/kdl";

import { parseModeBlocks } from "../../src/config/kdl-modes";
import { parseSpellKdl, spellKdlModesToModeConfigs } from "../../src/config/spell-kdl";

describe("parseModeBlocks", () => {
	it("parses a single mode with all fields and inline prose sections", () => {
		const doc = parse(`
mode "plan" extends="base" {
	command "/plan"
	description "Plan mode"
	read-only #true
	context-policy "fresh"
	context """
	Plan context
	"""
	instructions """
	Plan instructions
	"""
	focus-areas """
	Plan focus
	"""
	tools {
		allow "read" "grep"
		deny "write"
	}
}
`);

		expect(parseModeBlocks(doc)).toEqual([
			{
				name: "plan",
				config: {
					extends: "base",
					command: "/plan",
					description: "Plan mode",
					readOnly: true,
					contextPolicy: "fresh",
					tools: { allow: ["read", "grep"], deny: ["write"] },
				},
				sections: {
					context: "Plan context",
					instructions: "Plan instructions",
					focusAreas: "Plan focus",
					custom: {},
				},
			},
		]);
	});

	it("parses a minimal mode", () => {
		const doc = parse('mode "base"');
		expect(parseModeBlocks(doc)).toEqual([{ name: "base", config: {}, sections: { custom: {} } }]);
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

	it("adapts spell.kdl mode blocks into runtime mode configs with inline prose sections", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-kdl-modes-"));
		try {
			const parsed = await parseSpellKdl(
				`mode "plan" extends="base" {
	command "/plan"
	description "Inline plan"
	read-only #true
	tools {
		allow "read" "grep"
	}
	context """
	Project plan context
	"""
	instructions """
	Project plan instructions
	"""
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
					description: "Inline plan",
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
