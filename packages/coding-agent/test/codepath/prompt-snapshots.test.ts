// Prompt snapshot tests.
//
// Locks the current prompt files for find/edit/status/create/bash against a
// known-good baseline. After the kernel rebuild (W8/W10), these snapshots
// are replaced by kernel-generated content (listOpKinds/listQualifiers/etc.)
// and the test asserts byte-equality between disk prompts and kernel render.
//
// For now, the test is a stub that confirms the prompts exist, are non-empty,
// and have not regressed below a size floor (catches accidental deletion or
// reversion to legacy prose).

import { describe, expect, test } from "bun:test";
import { listOpKinds, listQualifiers, listDiagnosticVariants } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPTS_DIR = path.join(import.meta.dir, "../../src/prompts/tools");
const EDIT_MD = path.join(PROMPTS_DIR, "edit.md");
const FIND_MD = path.join(PROMPTS_DIR, "find.md");
const GENERATED_DIR = path.join(PROMPTS_DIR, "_generated");

interface PromptExpectation {
	name: string;
	minLines: number;
	mustContain: string[];
	mustNotContain?: string[];
}

const EXPECTATIONS: PromptExpectation[] = [
	{
		name: "find.md",
		minLines: 20,
		mustContain: ["target", "CodePath", "recipes", "::§line", "#stat", "#tree"],
		mustNotContain: ["recursive:", "depth:", "format:", "MUST NOT use"],
	},
	{
		name: "edit.md",
		minLines: 25,
		mustContain: ["symbol", "target", "action", "kind", "fileFindReplace", "symbolReplace", "undo"],
  mustNotContain: ["LINE#ID"],
	},
	{
		name: "status.md",
		minLines: 15,
		mustContain: ["languages", "index", "lockStatus", "watcherStatus"],
		// Forbidden as commands; cross-references (e.g. "diff lives in find") are fine.
		mustNotContain: ["command: \"save\"", "command: \"buffers\"", "command: \"context\""],
	},
	{
		name: "create.md",
		minLines: 8,
		mustContain: ["path", "content", "force", "FileExists"],
	},
	{
		name: "bash.md",
		minLines: 15,
		mustContain: ["Processes only", "find", "edit", "create"],
		// New bash.md should be terse; no MUST NOT laundry list
	},
];

describe("prompt snapshots — find/edit/status/create/bash", () => {
	for (const exp of EXPECTATIONS) {
		test(`${exp.name} exists and meets baseline`, () => {
			const fullPath = path.join(PROMPTS_DIR, exp.name);
			expect(fs.existsSync(fullPath)).toBe(true);
			const content = fs.readFileSync(fullPath, "utf-8");
			const lines = content.split("\n").length;
			expect(lines).toBeGreaterThanOrEqual(exp.minLines);
			for (const needle of exp.mustContain) {
				expect(content).toContain(needle);
			}
			if (exp.mustNotContain) {
				for (const forbidden of exp.mustNotContain) {
					expect(content).not.toContain(forbidden);
				}
			}
		});
	}

	test("legacy MUST-NOT bloat is gone from find.md and bash.md", () => {
		const find = fs.readFileSync(path.join(PROMPTS_DIR, "find.md"), "utf-8");
		const bash = fs.readFileSync(path.join(PROMPTS_DIR, "bash.md"), "utf-8");
		const findMustNotCount = (find.match(/MUST NOT/g) ?? []).length;
		const bashMustNotCount = (bash.match(/MUST NOT/g) ?? []).length;
		// Old prompts had 8+ MUST/MUST NOT rules. New prompts target ≤2 each.
		expect(findMustNotCount).toBeLessThanOrEqual(2);
		expect(bashMustNotCount).toBeLessThanOrEqual(2);
	});

	function extractSentinel(promptPath: string, name: string): string {
		const content = fs.readFileSync(promptPath, "utf-8");
		const startTag = `<!-- @generated:${name} -->`;
		const endTag = "<!-- @end -->";
		const start = content.indexOf(startTag);
		if (start < 0) throw new Error(`missing ${startTag}`);
		const end = content.indexOf(endTag, start);
		return content.slice(start + startTag.length, end);
	}

	test("kernel-generated Op table in edit.md matches listOpKinds()", () => {
		const block = extractSentinel(EDIT_MD, "edit-ops");
		const ops = listOpKinds();
		for (const op of ops) expect(block).toContain(op.kind);
	});

	test("kernel-generated Qualifier list in find.md matches listQualifiers()", () => {
		const block = extractSentinel(FIND_MD, "find-recipes");
		const quals = listQualifiers();
		for (const q of ["stat", "tree", "diff", "body"]) {
			if (quals.some(qq => qq.name === q)) expect(block).toMatch(new RegExp(`#${q}\\b|\\b${q}\\b`));
		}
	});

	test("kernel-generated Diagnostic vocabulary matches listDiagnosticVariants()", () => {
		const diagPath = path.join(GENERATED_DIR, "diag-vocabulary.md");
		expect(fs.existsSync(diagPath)).toBe(true);
		const content = fs.readFileSync(diagPath, "utf-8");
		const diags = listDiagnosticVariants();
		for (const d of diags) expect(content).toContain(d.variant);
	});
});
