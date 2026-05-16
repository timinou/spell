// Prompt snapshot tests.
//
// Locks the current prompt files for find/edit/status/create/bash against a
// known-good baseline. After the kernel rebuild (W8/W10), these snapshots
// are replaced by kernel-generated content (listOps/listQualifiers/etc.)
// and the test asserts byte-equality between disk prompts and kernel render.
//
// For now, the test is a stub that confirms the prompts exist, are non-empty,
// and have not regressed below a size floor (catches accidental deletion or
// reversion to legacy prose).

import { describe, expect, test } from "bun:test";
import { listEdgeKinds, listOps, listQualifiers, listDiagnosticVariants } from "@oh-my-pi/pi-natives";
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
 // LINE#ID now appears in richer-generated field descriptions (kernel-derived)
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

	// ── Kernel-parity tests ──
	// These check that the prompts surface every kernel-known entity. The check
	// is honest — it scans the *whole* prompt file (not just sentinel blocks)
	// because the sentinel-wrapping is currently a partial integration: some
	// kernel content lives outside sentinels (e.g. find.md's recipe table
	// mentions qualifiers in tutorial form, not as a generated reference table).
	// Stronger byte-equality between generator output and sentinel content is
	// tracked under W10.2 follow-up; this tier is the floor.

	test("edit.md mentions every Op kind from listOps()", () => {
		const content = fs.readFileSync(EDIT_MD, "utf-8");
		const ops = listOps();
		for (const op of ops) expect(content).toContain(op.kind);
	});

	test("find.md mentions every qualifier from listQualifiers()", () => {
		const content = fs.readFileSync(FIND_MD, "utf-8");
		const quals = listQualifiers();
		for (const q of quals) {
			expect(content).toContain(q.name);
		}
	});

	test("find.md mentions every edge symbol from listEdgeKinds()", () => {
		const content = fs.readFileSync(FIND_MD, "utf-8");
		const edges = listEdgeKinds();
		for (const e of edges) {
			expect(content).toContain(e.symbol);
		}
	});

	test("diag-vocabulary.md covers every DiagnosticVariant", () => {
		const diagPath = path.join(GENERATED_DIR, "diag-vocabulary.md");
		expect(fs.existsSync(diagPath)).toBe(true);
		const content = fs.readFileSync(diagPath, "utf-8");
		const diags = listDiagnosticVariants();
		for (const d of diags) expect(content).toContain(d.variant);
	});

	test("sentinel blocks exist for kernel-derived content", () => {
		const edit = fs.readFileSync(EDIT_MD, "utf-8");
		const find = fs.readFileSync(FIND_MD, "utf-8");
		expect(edit).toContain("<!-- @generated:edit-ops -->");
		expect(edit).toContain("<!-- @end -->");
		expect(find).toContain("<!-- @generated:find-recipes -->");
		expect(find).toContain("<!-- @end -->");
	});

	// ── Byte-equality tests ──
	// The honest contract: content between sentinels in find.md / edit.md is
	// byte-equal to the corresponding generated fragment. Prompts can't drift
	// from kernel because regenerating overwrites the sentinel block. Tests
	// fail if anyone hand-edits the inside-sentinel content without also
	// regenerating.

	function sentinelContent(filePath: string, name: string): string {
		const raw = fs.readFileSync(filePath, "utf-8");
		const startTag = `<!-- @generated:${name} -->`;
		const endTag = "<!-- @end -->";
		const start = raw.indexOf(startTag);
		const end = raw.indexOf(endTag, start);
		if (start < 0 || end < 0) throw new Error(`missing sentinel ${name} in ${filePath}`);
		return raw.slice(start + startTag.length, end);
	}

	test("find.md sentinel content is byte-equal to _generated/find-recipes.md", () => {
		const inside = sentinelContent(FIND_MD, "find-recipes").trim();
		const generated = fs.readFileSync(path.join(GENERATED_DIR, "find-recipes.md"), "utf-8").trim();
		expect(inside).toBe(generated);
	});

	test("edit.md sentinel content is byte-equal to _generated/edit-ops.md", () => {
		const inside = sentinelContent(EDIT_MD, "edit-ops").trim();
		const generated = fs.readFileSync(path.join(GENERATED_DIR, "edit-ops.md"), "utf-8").trim();
		expect(inside).toBe(generated);
	});
});
