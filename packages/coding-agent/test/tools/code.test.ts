import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspModule from "@oh-my-pi/pi-coding-agent/lsp";
import { _resetSupportedExtensionsForTest, CodeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

const TEST_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"rs",
	"py",
	"pyi",
	"typ",
	"md",
	"mdx",
	"markdown",
	"org",
	"ex",
	"exs",
]);

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: Awaited<ReturnType<CodeTool["execute"]>>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("coding-agent code tool wiring", () => {
	beforeEach(() => {
		_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	});

	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodeGraph") as any).mockRestore?.();
		} catch {}
		try {
			(spyOn(lspModule, "formatFileContent") as any).mockRestore?.();
		} catch {}
		_resetSupportedExtensionsForTest();
	});

	it("enforces mode guard for edit operations", async () => {
		const tool = new CodeTool(
			createSession({
				getActiveModeState: () => ({
					type: "user",
					name: "readonly",
					config: {} as any,
					enabled: true,
					readOnly: true,
				}),
			}),
		);

		await expect(tool.execute("tool", { command: "edit", file: "test.txt" })).rejects.toThrow(
			'Read-only mode "readonly": file modifications are not allowed.',
		);
	});

	it("enforces mode guard for save operations", async () => {
		const tool = new CodeTool(
			createSession({
				getActiveModeState: () => ({
					type: "user",
					name: "readonly",
					config: {} as any,
					enabled: true,
					readOnly: true,
				}),
			}),
		);

		await expect(tool.execute("tool", { command: "save", file: "test.txt" })).rejects.toThrow(
			'Read-only mode "readonly": file modifications are not allowed.',
		);
	});

	it("routes graph commands to the native graph backend", async () => {
		const executeSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "Code graph status\nCache: fresh\nSemantic: missing",
			cacheStatus: "fresh",
			rebuilt: false,
			fileCount: 12,
			symbolCount: 34,
			edgeCount: 56,
			semanticStatus: "missing",
		});
		const tool = new CodeTool(createSession({ cwd: "/tmp/project" }));
		const result = await tool.execute("graph", { command: "status" });

		expect(getText(result)).toBe("Code graph status\nCache: fresh\nSemantic: missing");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "graph",
				command: "status",
				cacheStatus: "fresh",
				rebuilt: false,
				semanticStatus: "missing",
				graph: true,
			}),
		);
		expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "status", root: "/tmp/project" }));
	});

	it("passes semantic search flags through to the native graph backend", async () => {
		const executeSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "Search\n- 0.90 src/foo.ts::foo",
			cacheStatus: "fresh",
			rebuilt: false,
			fileCount: 12,
			symbolCount: 34,
			edgeCount: 56,
			semanticStatus: "hybrid search using 8 cached vectors",
		});
		const tool = new CodeTool(createSession({ cwd: "/tmp/project" }));

		await tool.execute("graph", { command: "search", query: "foo", semantic: true });

		expect(executeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "search", query: "foo", semantic: true, root: "/tmp/project" }),
		);
	});

	it("routes symbol and file lookup commands to the native graph backend", async () => {
		const executeSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "Symbols\nQuery: CodeTool\nStatus: exact\n- src/tools/code.ts::CodeTool [class] src/tools/code.ts:1:1",
			cacheStatus: "fresh",
			rebuilt: false,
			fileCount: 12,
			symbolCount: 34,
			edgeCount: 56,
		});
		const tool = new CodeTool(createSession({ cwd: "/tmp/project" }));

		await tool.execute("graph", { command: "symbols", query: "CodeTool" });
		expect(executeSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({ command: "symbols", query: "CodeTool", root: "/tmp/project" }),
		);

		await tool.execute("graph", { command: "files", query: "code.ts" });
		expect(executeSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({ command: "files", query: "code.ts", root: "/tmp/project" }),
		);
	});

	it("routes file-local commands to executeCodeBuffer with compact summaries", async () => {
		const outlinePayload = [
			{
				name: "main",
				kind: "function",
				line: 1,
				end_line: 3,
				column: 0,
				exported: true,
				signature: "function main()",
				children: [],
			},
		];
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: outlinePayload,
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts" });

		expect(getText(result)).toContain("Outline src/main.ts (1 top, 1 total)");
		expect(getText(result)).toContain("function main L1-L3");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "outline",
				displayPath: "src/main.ts",
				rawOutput: outlinePayload,
			}),
		);
		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/main.ts" }),
		);
	});
	it("injects markdown hint only on first successful markdown use", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "# Installation", error: false });
		const tool = new CodeTool(createSession());

		const first = await tool.execute("tool", { command: "read", file: "/tmp/test/README.md" });
		expect(getText(first)).toContain("Markdown-specific code operations:");
		expect(getText(first)).toContain("replace-code-block");

		const second = await tool.execute("tool", { command: "read", file: "/tmp/test/guide.md" });
		expect(getText(second)).not.toContain("Markdown-specific code operations:");
	});

	it("injects hints independently per language", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());

		const markdown = await tool.execute("tool", { command: "read", file: "/tmp/test/README.md" });
		expect(getText(markdown)).toContain("Markdown-specific code operations:");

		const typst = await tool.execute("tool", { command: "read", file: "/tmp/test/doc.typ" });
		expect(getText(typst)).toContain("Typst-specific code operations:");
	});

	it("does not inject language hints on error results", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "missing file", error: true });
		const tool = new CodeTool(createSession());

		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/README.md" });
		expect(getText(result)).not.toContain("Markdown-specific code operations:");
		expect(getText(result)).toContain("missing file");
	});

	it("formats edited buffers before the final save when a formatter is available", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: "function main( ) {\nreturn 42;\n}\n", error: false })
			.mockReturnValueOnce({ output: { version: 3, diff: "@@ format @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 3 }, error: false });
		const formatSpy = spyOn(lspModule, "formatFileContent").mockResolvedValue({
			content: "function main() {\n  return 42;\n}\n",
			formatter: lspModule.FileFormatResult.FORMATTED,
			server: "biome",
		});
		const tool = new CodeTool(createSession());

		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "replace-body",
			content: ["{", "return 42;", "}"],
		});

		expect(formatSpy).toHaveBeenCalledWith(
			"/tmp/test/src/main.ts",
			"function main( ) {\nreturn 42;\n}\n",
			"/tmp/test",
			undefined,
		);
		expect(bufferSpy.mock.calls[2]?.[0]).toMatchObject({
			command: "replace_content",
			file: "/tmp/test/src/main.ts",
			content: "function main() {\n  return 42;\n}\n",
		});
		expect(bufferSpy.mock.calls[3]?.[0]).toMatchObject({ command: "save", file: "/tmp/test/src/main.ts" });
		expect(getText(result)).toContain("Formatting: formatted via biome");
	});

	it("joins array content for replace-body edits before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ replace-body @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession());

		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "replace-body",
			content: ["{", "  return 42;", "}"],
		});

		expect(bufferSpy.mock.calls[0]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace-body",
			content: "{\n  return 42;\n}",
		});
	});

	it("joins array patch text before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession());

		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "patch",
			patches: [
				{
					find: ["const x = 1;", "const y = 2;"],
					replace: ["const x = 10;", "const y = 20;"],
				},
			],
		});

		expect(bufferSpy.mock.calls[0]?.[0]).toMatchObject({
			command: "edit",
			patches: [
				{
					find: "const x = 1;\nconst y = 2;",
					replace: "const x = 10;\nconst y = 20;",
				},
			],
		});
	});

	it("preserves single-string content for rename edits", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ rename @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession());

		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "rename",
			content: "renamedMain",
		});

		expect(bufferSpy.mock.calls[0]?.[0]).toMatchObject({
			command: "edit",
			operation: "rename",
			content: "renamedMain",
		});
	});

	it("normalizes mixed-format batch edits before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ batch @@", editCount: 3 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession());

		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			edits: [
				{ symbol: "main", operation: "replace-body", content: ["{", "  return 42;", "}"] },
				{
					symbol: "main",
					operation: "patch",
					patches: [{ find: ["const x = 1;", "const y = 2;"], replace: ["const x = 10;", "const y = 20;"] }],
				},
				{ line: 1, operation: "insert-after", content: ["import { x } from './x';"] },
			],
		});

		expect(bufferSpy.mock.calls[0]?.[0]).toMatchObject({
			command: "edit",
			edits: [
				{ symbol: "main", operation: "replace-body", content: "{\n  return 42;\n}" },
				{
					symbol: "main",
					operation: "patch",
					patches: [{ find: "const x = 1;\nconst y = 2;", replace: "const x = 10;\nconst y = 20;" }],
				},
				{ line: 1, operation: "insert-after", content: "import { x } from './x';" },
			],
		});
	});

	it("bypasses extension check for non-file commands", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { languages: [] },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "languages" });

		expect(bufferSpy).toHaveBeenCalled();
	});

	it("refreshes supported extensions after cache reset", async () => {
		_resetSupportedExtensionsForTest();
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { languages: [{ extensions: ["foo"] }] }, error: false })
			.mockReturnValueOnce({ output: "content", error: false })
			.mockReturnValueOnce({ output: { languages: [{ extensions: ["bar"] }] }, error: false })
			.mockReturnValueOnce({ output: "content", error: false });

		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "read", file: "/tmp/test/example.foo" });
		_resetSupportedExtensionsForTest();
		await tool.execute("tool", { command: "read", file: "/tmp/test/example.bar" });

		expect(bufferSpy).toHaveBeenCalledTimes(4);
		expect(bufferSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ command: "languages" }));
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "read", file: "/tmp/test/example.foo" }),
		);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ command: "languages" }));
		expect(bufferSpy.mock.calls[3]?.[0]).toEqual(
			expect.objectContaining({ command: "read", file: "/tmp/test/example.bar" }),
		);
	});

	it("allows extensionless files through to NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "read", file: "/tmp/test/Makefile" });

		expect(bufferSpy).toHaveBeenCalled();
	});

	it("rejects unsupported file extensions before calling NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { languages: [{ extensions: ["ts"] }] },
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/doc.foo" });

		expect(getText(result)).toContain("Unsupported file type .foo");
		expect(getText(result)).toContain("supports TypeScript, Rust, Python, Typst, Markdown, Org, and Elixir");
		expect(getText(result)).toContain("read tool");
		expect(bufferSpy).not.toHaveBeenCalled();
	});

	it("allows supported file extensions through to NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "read", file: "/tmp/test/main.ts" });

		expect(bufferSpy).toHaveBeenCalled();
	});

	it("forwards mode for splice edit operations", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { version: 3, diff: "@@ top-level @@", editCount: 1 },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "splice",
			mode: "down",
			line: 8,
		});

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ operation: "splice", mode: "down", line: 8 }));
	});

	it("resolves relative file paths against session cwd", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/virtual/session/src/main.ts" }));
	});

	it("passes through absolute file paths unchanged", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "/opt/project/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/opt/project/src/main.ts" }));
	});

	it("does not forward file-local depth", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts", depth: 2 });

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/main.ts" }),
		);
		expect(bufferSpy.mock.calls[0]?.[0]).not.toHaveProperty("depth");
	});

	it("auto-saves to disk after successful edit", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@\n-old\n+new", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "fn",
			operation: "patch",
			patches: [{ find: "old", replace: "new" }],
		});

		expect(bufferSpy).toHaveBeenCalledTimes(2);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(getText(result)).toContain("Edited");
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("auto-saves to disk after successful undo", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 1, diff: "@@ undo @@" }, error: false })
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "undo", file: "/tmp/test/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledTimes(2);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("auto-saves to disk after successful redo", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 3, diff: "@@ redo @@" }, error: false })
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "redo", file: "/tmp/test/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledTimes(2);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("returns error when auto-save after edit fails", async () => {
		spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: "Permission denied", error: true });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "fn",
			operation: "patch",
			patches: [{ find: "old", replace: "new" }],
		});

		expect(getText(result)).toContain("Permission denied");
		expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
	});

	it("does not auto-save after non-mutating commands", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledTimes(1);
	});

	it("does not auto-save when edit fails", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "patch.find matched 0 locations",
			error: true,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "fn",
			operation: "patch",
			patches: [{ find: "old", replace: "new" }],
		});

		expect(bufferSpy).toHaveBeenCalledTimes(1);
		expect(getText(result)).toContain("patch.find matched 0 locations");
	});
});
