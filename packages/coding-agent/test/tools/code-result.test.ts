import { describe, expect, it } from "bun:test";
import {
	createCodeGraphDetails,
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
		expect(details.displayPath).toBe("packages/coding-agent/src/tools/code.ts");
		expect(details.data.totalSymbols).toBe(3);
		expect(details.data.entries[0]?.children[0]?.endLine).toBe(212);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Outline packages/coding-agent/src/tools/code.ts (2 top-level, 3 total symbols)");
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
		expect(details.rawOutput).toEqual(rawOutput);
		expect(details.data.referenceCount).toBe(2);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Navigate node-at docs/theme.typ: let teal-primary L7:C1");
		expect(content).toContain("related items: 1");
		expect(content).toContain("references: 2");
		expect(content).not.toContain('"editableScopeNodeType"');
	});

	it("formats edit payloads as semantic diffs instead of raw JSON", () => {
		const details = normalizeCodeBufferSuccess({
			command: "edit",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: {
				version: 2,
				diff: "@@ add @@\n-return a + b;\n+return a * b;",
				editCount: 1,
			},
		});

		const content = formatCodeToolContent(details);
		expect(content).toContain("Edited src/main.ts (1 operation, buffer version 2)");
		expect(content).toContain("@@ add @@");
		expect(content).not.toMatch(/^\s*\{/);
	});

	it("summarizes undo history without dropping low-level edit primitives", () => {
		const details = normalizeCodeBufferSuccess({
			command: "undo",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			output: [
				{
					version: 4,
					changedRanges: [
						{
							start: { line: 10, column: 2 },
							end: { line: 12, column: 0 },
						},
					],
					inputEdit: { startByte: 120, oldEndByte: 145, newText: "return a + b;" },
				},
			],
		});

		expect(details.data.applied).toBe(true);
		expect(details.data.entries?.[0]?.inputEdit?.startByte).toBe(120);

		const content = formatCodeToolContent(details);
		expect(content).toContain("Undo src/main.ts applied 1 history entry.");
		expect(content).toContain("v4");
		expect(content).toContain("inserted 13 chars");
	});

	it("keeps graph output compact and error output plain text", () => {
		const graph = createCodeGraphDetails({
			command: "status",
			output: "Code graph status\nCache: fresh\nSemantic: missing",
			cacheStatus: "fresh",
			rebuilt: false,
			semanticStatus: "missing",
		});
		expect(formatCodeToolContent(graph)).toBe("Code graph status\nCache: fresh\nSemantic: missing");

		const error = createCodeToolError({
			command: "outline",
			file: "/repo/src/main.ts",
			cwd: "/repo",
			message: "Language profile not found",
			output: "Language profile not found",
		});
		expect(error.displayPath).toBe("src/main.ts");
		expect(formatCodeToolContent(error)).toBe("Error: Language profile not found");
	});
});
