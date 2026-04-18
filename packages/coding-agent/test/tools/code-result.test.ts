import { describe, expect, it } from "bun:test";
import {
	createCodeToolError,
	formatCodeToolContent,
	normalizeCodeBufferSuccess,
} from "@oh-my-pi/pi-coding-agent/tools/code-result";

describe("code tool result contract", () => {
	it("normalizes outline payloads into compact semantic summaries", () => {
		const details = normalizeCodeBufferSuccess({
			command: "outline",
			file: "/repo/packages/coding-agent/src/tools/code.ts",
			cwd: "/repo",
			output: [
				{
					name: "CodeTool",
					kind: "class",
					line: 119,
					end_line: 295,
					column: 0,
					exported: true,
					signature: "class CodeTool",
					children: [
						{
							name: "execute",
							kind: "method",
							line: 133,
							end_line: 212,
							column: 1,
							exported: false,
							signature: "execute()",
							children: [],
						},
					],
				},
				{
					name: "codeSchema",
					kind: "variable",
					line: 69,
					end_line: 111,
					column: 0,
					exported: false,
					signature: "const codeSchema = ...",
					children: [],
				},
			],
		});

		expect(details.command).toBe("outline");
		if (details.command !== "outline") throw new Error("Expected outline details");
		expect(details.displayPath).toBe("packages/coding-agent/src/tools/code.ts");
		expect(details.data.totalSymbols).toBe(3);
		expect(details.data.entries[0]?.children[0]?.endLine).toBe(212);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Outline packages/coding-agent/src/tools/code.ts (2 top, 3 total)");
		expect(content).toContain("class CodeTool L119-L295 (1 child)");
		expect(content).not.toContain('"end_line"');
	});

	it("preserves raw navigate metadata while presenting a compact summary", () => {
		const rawOutput = {
			nodeType: "let",
			text: 'let teal-primary = rgb("#008080")',
			line: 7,
			endLine: 7,
			column: 1,
			parentType: "code",
			name: "teal-primary",
			kind: "let",
			items: [{ nodeType: "string", text: 'rgb("#008080")', line: 7, endLine: 7 }],
			references: [{ line: 9 }, { line: 13 }],
			editableScopeNodeType: "code",
			editableScopeLine: 7,
			editableScopeEndLine: 7,
		};
		const details = normalizeCodeBufferSuccess({
			command: "navigate",
			file: "/repo/docs/theme.typ",
			cwd: "/repo",
			action: "node-at",
			output: rawOutput,
		});

		expect(details.command).toBe("navigate");
		if (details.command !== "navigate") throw new Error("Expected navigate details");
		expect(details.rawOutput).toEqual(rawOutput);
		expect(details.data.referenceCount).toBe(2);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Navigate node-at docs/theme.typ: let teal-primary L7:C1");
		expect(content).toContain('text: let teal-primary = rgb("#008080")');
		expect(content).toContain("parent: code | scope: code L7 | kind: let");
		expect(content).toContain("1 item, 2 refs");
		expect(content).toContain('  string rgb("#008080") L7');
		expect(content).not.toContain('"editableScopeNodeType"');
	});

	it("formats edit payloads as semantic diffs instead of raw JSON", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: { version: 2, diff: "@@ add @@\n-return a + b;\n+return a * b;", editCount: 1 },
			formatting: "formatted",
			formatterServer: "biome",
		});

		const content = formatCodeToolContent(details);
		expect(content).toContain("Edited src/main.ts");
		expect(content).toContain("Formatting: formatted via biome");
		expect(content).toContain("Changes: +1 -1");
		expect(content).toContain("Diff preview:");
		expect(content).toContain("@@ add @@");
		expect(content).not.toMatch(/^\s*\{/);
	});

	it("formats create payloads as creation summaries", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/new-module.ts",
			cwd: "/repo",
			output: { version: 1, diff: "@@ top-level @@\n+export const created = 1;", editCount: 1, created: true },
			formatting: "unchanged",
		});

		const content = formatCodeToolContent(details);
		expect(content).toContain("Created src/new-module.ts");
		expect(content).toContain("Formatting: unchanged");
		expect(content).toContain("Changes: +1 -0");
		expect(content).not.toContain("Edited src/new-module.ts");
	});

	it("formats idempotent no-op edits without edited success text", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: { version: 2, diff: "", editCount: 1 },
			noop: true,
			idempotent: true,
			formatting: "unchanged",
		});

		const content = formatCodeToolContent(details);
		expect(content).toContain("No-op edit src/main.ts (idempotent)");
		expect(content).toContain("No semantic changes applied.");
		expect(content).not.toContain("Edited src/main.ts");
		expect(content).not.toContain("Changes: +0 -0");
	});

	it("formats pending preview edits without edited success text", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: {
				version: 2,
				diff: "@@ add @@\n-return legacyWrap(x, value);\n+return modernWrap(x, value);",
				editCount: 1,
			},
			mutationState: "pending_preview",
			persisted: false,
		});

		if (details.command !== "edit") throw new Error("Expected edit details");
		expect(details.data.mutationState).toBe("pending_preview");
		expect(details.data.persisted).toBe(false);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Preview queued src/main.ts");
		expect(content).toContain("Resolve required before disk changes.");
		expect(content).not.toContain("Edited src/main.ts");
	});

	it("formats discarded preview edits without edited success text", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: {
				version: 2,
				diff: "@@ add @@\n-return legacyWrap(x, value);\n+return modernWrap(x, value);",
				editCount: 1,
			},
			mutationState: "discarded",
			persisted: false,
		});

		if (details.command !== "edit") throw new Error("Expected edit details");
		expect(details.data.mutationState).toBe("discarded");
		expect(details.data.persisted).toBe(false);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Preview discarded src/main.ts");
		expect(content).toContain("No mutation landed.");
		expect(content).not.toContain("Edited src/main.ts");
	});

	it("formats clean save results without edited success text", () => {
		const details = normalizeCodeBufferSuccess({
			command: "save",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: { success: true, version: 0 },
		});

		expect(details.command).toBe("save");
		if (details.command !== "save") throw new Error("Expected save details");
		expect(details.data.success).toBe(true);
		expect(details.data.version).toBe(0);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Saved src/main.ts (buffer version 0).");
		expect(content).not.toContain("Edited src/main.ts");
	});

	it("summarizes undo history without dropping low-level edit primitives", () => {
		const details = normalizeCodeBufferSuccess({
			command: "undo",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: [
				{
					version: 4,
					changedRanges: [{ start: { line: 10, column: 2 }, end: { line: 12, column: 0 } }],
					inputEdit: { startByte: 120, oldEndByte: 145, newText: "return a + b;" },
				},
			],
		});

		if (details.command !== "undo") throw new Error("Expected undo details");
		expect(details.data.applied).toBe(true);
		expect(details.data.entries?.[0]?.inputEdit?.startByte).toBe(120);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Undo src/main.ts (1 entry)");
		expect(content).toContain("v4 L10-12 +13 chars");
	});

	it("formats language payloads with capabilities and embedded guests", () => {
		const details = normalizeCodeBufferSuccess({
			command: "languages",
			output: {
				languages: [
					{
						id: "html",
						extensions: ["html", "htm"],
						semanticCapable: true,
						capabilities: ["outline", "read", "navigate", "resolve", "edit", "graph"],
						embeddedLanguages: ["css", "javascript"],
					},
					{
						id: "css",
						extensions: ["css"],
						semanticCapable: true,
						capabilities: ["outline", "read", "navigate", "resolve", "edit", "graph"],
						embeddedLanguages: [],
					},
				],
			},
		});

		expect(details.command).toBe("languages");
		if (details.command !== "languages") throw new Error("Expected language details");
		expect(details.data.languages[0]?.embeddedLanguages).toEqual(["css", "javascript"]);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Built-in languages (2)");
		expect(content).toContain(
			"html (html, htm) [outline, read, navigate, resolve, edit, graph] embeds css, javascript",
		);
		expect(content).toContain("css (css) [outline, read, navigate, resolve, edit, graph]");
	});

	it("formats open results with path, language, and line count", () => {
		const details = normalizeCodeBufferSuccess({
			command: "open",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: { success: true, language: "typescript", lines: ["export const a = 1;", "export const b = 2;"] },
		});

		expect(details.command).toBe("open");
		if (details.command !== "open") throw new Error("Expected open details");
		expect(details.data.success).toBe(true);
		expect(details.data.language).toBe("typescript");
		expect(details.data.lineCount).toBe(2);

		const content = formatCodeToolContent(details);
		expect(content).toBe("Opened src/main.ts [typescript] 2 lines");
	});

	it("formats close results with path", () => {
		const details = normalizeCodeBufferSuccess({
			command: "close",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: { success: true },
		});

		expect(details.command).toBe("close");
		if (details.command !== "close") throw new Error("Expected close details");
		expect(details.data.success).toBe(true);

		const content = formatCodeToolContent(details);
		expect(content).toBe("Closed src/main.ts");
	});

	it("preserves edit proof metadata and renders proof lines", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: {
				version: 3,
				diff: "@@ add @@\n+return next(value);",
				editCount: 1,
				targets: [{ targetId: "src/main.ts::main", actions: ["replaceNode"] }],
				proof: { basis: "hashline", reason: "target narrowed", confidence: "high", matches: 1 },
			},
		});
		if (details.command !== "edit") throw new Error("Expected edit details");
		expect(details.data.targets).toEqual([{ targetId: "src/main.ts::main", actions: ["replaceNode"], children: [] }]);
		expect(details.data.proof).toEqual({
			basis: "hashline",
			reason: "target narrowed",
			confidence: "high",
			matches: 1,
		});
		expect(formatCodeToolContent(details)).toContain("Proof: hashline | target narrowed | high | matches: 1");
	});

	it("preserves error proof metadata and renders proof lines", () => {
		const error = createCodeToolError({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: {
				version: 3,
				diff: "@@ add @@\n+return next(value);",
				editCount: 1,
				targets: [{ targetId: "src/main.ts::main", actions: ["replaceNode"] }],
				proof: { basis: "line-target", reason: "would cross block boundary", confidence: "medium", matches: 2 },
			},
			message: "would cross block boundary",
		});
		expect(error.proof).toEqual({
			basis: "line-target",
			reason: "would cross block boundary",
			confidence: "medium",
			matches: 2,
		});
		expect(formatCodeToolContent(error)).toContain(
			"Proof: line-target | would cross block boundary | medium | matches: 2",
		);
	});
});
