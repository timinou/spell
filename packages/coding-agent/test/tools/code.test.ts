import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspModule from "@oh-my-pi/pi-coding-agent/lsp";
import {
	_resetSupportedExtensionsForTest,
	CodeTool,
	createTools,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";
import { PendingActionStore } from "@oh-my-pi/pi-coding-agent/tools/pending-action";
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

	it("enforces mode guard for undo operations", async () => {
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

		await expect(tool.execute("tool", { command: "undo", file: "test.txt" })).rejects.toThrow(
			'Read-only mode "readonly": file modifications are not allowed.',
		);
	});

	it("enforces mode guard for redo operations", async () => {
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

		await expect(tool.execute("tool", { command: "redo", file: "test.txt" })).rejects.toThrow(
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
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@\n-old\n+new", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: "function main( ) {\nreturn 42;\n}\n", error: false })
			.mockReturnValueOnce({ output: { version: 3, diff: "@@ format @@", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 3 }, error: false });
		const formatSpy = spyOn(lspModule, "formatFileContent").mockResolvedValue({
			content: "function main() {\n  return 42;\n}\n",
			formatter: lspModule.FileFormatResult.FORMATTED,
			server: "biome",
		});
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": true }) }));

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
		expect(bufferSpy.mock.calls[3]?.[0]).toMatchObject({
			command: "replace_content",
			file: "/tmp/test/src/main.ts",
			content: "function main() {\n  return 42;\n}\n",
		});
		expect(bufferSpy.mock.calls[4]?.[0]).toMatchObject({ command: "save", file: "/tmp/test/src/main.ts" });
		expect(getText(result)).toContain("Formatting: formatted via biome");
	});

	it("creates missing supported files through edit create and auto-saves", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({
				output: { version: 1, diff: "@@ top-level @@\n+export const created = 1;", editCount: 1, created: true },
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 1 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			content: ["export const created = 1;"],
		});
		expect(bufferSpy.mock.calls[0]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			content: "export const created = 1;",
		});
		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({ command: "save", file: "/tmp/test/src/new-module.ts" });
		expect(getText(result)).toContain("Created src/new-module.ts");
	});

	it("replaces an existing file when replace omits symbol and line", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					version: 2,
					diff: "@@ top-level @@\n-export const original = 1;\n+export const replaced = 2;",
					editCount: 1,
					created: false,
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace",
			content: ["export const replaced = 2;"],
		});
		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace",
			content: "export const replaced = 2;",
		});
		expect(bufferSpy.mock.calls[2]?.[0]).toMatchObject({ command: "save", file: "/tmp/test/src/main.ts" });
		expect(getText(result)).toContain("Edited src/main.ts");
	});

	it("rejects invalid create payloads before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			symbol: "main",
			content: ["export const created = 1;"],
		});
		expect(getText(result)).toContain("operation 'create' does not accept symbol");
		expect(bufferSpy).not.toHaveBeenCalled();
	});

	it("accepts create payloads with empty transport defaults", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({
				output: { version: 1, diff: "@@ top-level @@\n+export const created = 1;", editCount: 1, created: true },
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 1 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			content: ["export const created = 1;"],
			symbol: "",
			patches: [],
			edits: [],
			resolution: 0,
			offset: 0,
			limit: 0,
			depth: 0,
			line: 0,
			column: 0,
			mode: "",
			action: "",
		});

		expect(getText(result)).toContain("Created src/new-module.ts");
		const editCall = bufferSpy.mock.calls[0]?.[0];
		expect(editCall).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			content: "export const created = 1;",
		});
		expect(editCall).not.toHaveProperty("symbol");
		expect(editCall).not.toHaveProperty("patches");
		expect(editCall).not.toHaveProperty("edits");
		expect(editCall).not.toHaveProperty("resolution");
		expect(editCall).not.toHaveProperty("offset");
		expect(editCall).not.toHaveProperty("limit");
		expect(editCall).not.toHaveProperty("line");
		expect(editCall).not.toHaveProperty("column");
		expect(editCall).not.toHaveProperty("mode");
		expect(editCall).not.toHaveProperty("action");
	});

	it("routes top-level patch edits when transport sends edits as an empty array", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@\n-old\n+new", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "patch",
			patches: [{ find: "old", replace: "new" }],
			edits: [],
		});

		expect(getText(result)).toContain("Edited src/main.ts");
		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "main",
			operation: "patch",
			patches: [{ find: "old", replace: "new" }],
		});
		expect(bufferSpy.mock.calls[1]?.[0]).not.toHaveProperty("edits");
	});

	it("forwards fully qualified Elixir module symbols unchanged", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					version: 2,
					diff: "@@ Agentmaker.AgentConfig.TestChat @@\n-old\n+new",
					editCount: 1,
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/lib/test_chat.ex",
			symbol: "Agentmaker.AgentConfig.TestChat",
			operation: "replace",
			content: ["defmodule Agentmaker.AgentConfig.TestChat do", "  def render(), do: :updated", "end"],
		});

		expect(getText(result)).toContain("Edited lib/test_chat.ex");
		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/lib/test_chat.ex",
			symbol: "Agentmaker.AgentConfig.TestChat",
			operation: "replace",
		});
	});
	it("routes whole-file replace edits when transport sends edits as an empty array", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ replace @@\n-old\n+new", editCount: 1 }, error: false })
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false });
		const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace",
			content: ["export const replaced = 2;"],
			edits: [],
		});

		expect(getText(result)).toContain("Edited src/main.ts");
		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace",
			content: "export const replaced = 2;",
		});
		expect(bufferSpy.mock.calls[1]?.[0]).not.toHaveProperty("edits");
	});

	it("still rejects create payloads with meaningful edits", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/new-module.ts",
			operation: "create",
			content: ["export const created = 1;"],
			edits: [{ line: 1, operation: "insert-after", content: ["export const created = 1;"] }],
		});

		expect(getText(result)).toContain("operation 'create' does not accept edits");
		expect(bufferSpy).not.toHaveBeenCalled();
	});

	it("joins array content for replace-body edits before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
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

		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "replace-body",
			content: "{\n  return 42;\n}",
		});
	});

	it("joins array patch text before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
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

		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
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
			.mockReturnValueOnce({ output: [], error: false })
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

		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
			command: "edit",
			operation: "rename",
			content: "renamedMain",
		});
	});

	it("normalizes mixed-format batch edits before invoking NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
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

		expect(bufferSpy.mock.calls[1]?.[0]).toMatchObject({
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

	it("allows extensionless files through to NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "read", file: "/tmp/test/Makefile" });

		expect(bufferSpy).toHaveBeenCalled();
	});

	it("allows unsupported text-like extensions through to NAPI fallback", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/doc.foo" });

		expect(getText(result)).toContain("content");
		expect(getText(result)).toContain("Fallback text mode is active here:");
		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "read", file: "/tmp/test/doc.foo" }));
	});

	it("surfaces binary rejection from native fallback", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "binary file rejected: /tmp/test/blob.bin",
			error: true,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/blob.bin" });

		expect(getText(result)).toContain("binary file rejected");
		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "read", file: "/tmp/test/blob.bin" }));
		expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
	});

	it("allows supported file extensions through to NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "read", file: "/tmp/test/main.ts" });

		expect(bufferSpy).toHaveBeenCalled();
	});

	it("injects semantic follow-up hints for semantic-capable files", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: "content", error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/main.ts" });

		expect(getText(result)).toContain("Semantic follow-ups available here:");
		expect(getText(result)).not.toContain("Fallback text mode is active here:");
		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "read", file: "/tmp/test/main.ts" }));
	});

	it("injects fallback lifecycle hints without semantic hints for text fallback files", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "text content",
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/notes.foo" });

		expect(getText(result)).toContain("Fallback text mode is active here:");
		expect(getText(result)).not.toContain("Semantic follow-ups available here:");
		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "read", file: "/tmp/test/notes.foo" }));
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
			.mockReturnValueOnce({ output: [], error: false })
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

		expect(bufferSpy).toHaveBeenCalledTimes(3);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(getText(result)).toContain("Edited");
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("auto-saves to disk after successful undo", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 1, diff: "@@ undo @@" }, error: false })
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "undo", file: "/tmp/test/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledTimes(3);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("auto-saves to disk after successful redo", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 3, diff: "@@ redo @@" }, error: false })
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "redo", file: "/tmp/test/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledTimes(3);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("returns error when auto-save after edit fails", async () => {
		spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({ output: { version: 2, diff: "@@ patch @@\n-old\n+new", editCount: 1 }, error: false })
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
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
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

		expect(bufferSpy).toHaveBeenCalledTimes(3);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({ command: "close", file: "/tmp/test/src/main.ts" }),
		);
		expect(getText(result)).toContain("patch.find matched 0 locations");
	});
});

it("fails non-idempotent no-op edits before save", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	try {
		(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
	} catch {}
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
		.mockReturnValueOnce({ output: [], error: false })
		.mockReturnValueOnce({ output: { version: 2, diff: "", editCount: 1 }, error: false });
	const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

	const result = await tool.execute("tool", {
		command: "edit",
		file: "/tmp/test/src/main.ts",
		symbol: "fn",
		operation: "patch",
		patches: [{ find: "old", replace: "old" }],
	});

	expect(getText(result)).toContain("Edit produced no semantic changes");
	expect(bufferSpy).toHaveBeenCalledTimes(2);
	expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
});

it("renders idempotent no-op edits truthfully", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	try {
		(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
	} catch {}
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
		.mockReturnValueOnce({ output: [], error: false })
		.mockReturnValueOnce({ output: { version: 2, diff: "", editCount: 1 }, error: false });
	const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

	const result = await tool.execute("tool", {
		command: "edit",
		file: "/tmp/test/src/main.ts",
		symbol: "fn",
		operation: "patch",
		patches: [{ find: "old", replace: "old" }],
		idempotent: true,
	});

	expect(getText(result)).toContain("No-op edit src/main.ts (idempotent)");
	expect(getText(result)).toContain("No semantic changes applied.");
	expect(getText(result)).not.toContain("Changes: +0 -0");
	expect(bufferSpy).toHaveBeenCalledTimes(2);
	expect(result.details).toEqual(expect.objectContaining({ kind: "file", command: "edit" }));
});

it("blocks stale buffers before mutating", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	try {
		(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
	} catch {}
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValueOnce({
		output: [{ kind: "change", content: "@@ -1 +1 @@" }],
		error: false,
	});
	const tool = new CodeTool(createSession({ settings: Settings.isolated({ "lsp.enabled": false }) }));

	const result = await tool.execute("tool", {
		command: "edit",
		file: "/tmp/test/src/main.ts",
		symbol: "fn",
		operation: "patch",
		patches: [{ find: "old", replace: "new" }],
	});

	expect(getText(result)).toContain("Stale code buffer detected (1 hunk differ from disk)");
	expect(bufferSpy).toHaveBeenCalledTimes(1);
	expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
});

it("uses applied preview content for follow-up code edits", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-preview-followup-"));
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return legacyWrap(x, value);\n}\n");
		const pendingActionStore = new PendingActionStore();
		const tools = await createTools(
			createSession({
				cwd: tempDir,
				settings: Settings.isolated({ "lsp.enabled": false }),
				pendingActionStore,
			}),
		);
		const codeTool = tools.find(entry => entry.name === "code");
		const astEditTool = tools.find(entry => entry.name === "ast_edit");
		const resolveTool = tools.find(entry => entry.name === "resolve");
		expect(codeTool).toBeDefined();
		expect(astEditTool).toBeDefined();
		expect(resolveTool).toBeDefined();

		await codeTool!.execute("code-read-before", { command: "read", file: filePath, resolution: 3 });
		await astEditTool!.execute("ast-edit-preview", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			lang: "typescript",
			path: filePath,
		});
		await resolveTool!.execute("resolve-apply", { action: "apply", reason: "Preview is correct" });

		const readAfterApply = await codeTool!.execute("code-read-after", {
			command: "read",
			file: filePath,
			resolution: 3,
		});
		expect(getText(readAfterApply)).toContain("modernWrap(x, value)");

		const editAfterApply = await codeTool!.execute("code-edit-after", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return modernWrap(x, value);", replace: "return modernWrap(y, value);" }],
		});
		expect(getText(editAfterApply)).not.toContain("Stale code buffer detected");
		expect(await Bun.file(filePath).text()).toContain("modernWrap(y, value)");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("invalidates only files touched by applied previews", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-preview-invalidate-"));
	const executeSpy = spyOn(nativesModule, "executeCodeBuffer");
	try {
		const targetFile = path.join(tempDir, "target.ts");
		const untouchedFile = path.join(tempDir, "untouched.ts");
		await Bun.write(targetFile, "export function target() {\n  return legacyWrap(x, value);\n}\n");
		await Bun.write(untouchedFile, "export function untouched() {\n  return 2;\n}\n");
		const pendingActionStore = new PendingActionStore();
		const tools = await createTools(
			createSession({
				cwd: tempDir,
				settings: Settings.isolated({ "lsp.enabled": false }),
				pendingActionStore,
			}),
		);
		const codeTool = tools.find(entry => entry.name === "code");
		const astEditTool = tools.find(entry => entry.name === "ast_edit");
		const resolveTool = tools.find(entry => entry.name === "resolve");
		expect(codeTool).toBeDefined();
		expect(astEditTool).toBeDefined();
		expect(resolveTool).toBeDefined();
		await codeTool!.execute("read-target", { command: "read", file: targetFile, resolution: 3 });
		await codeTool!.execute("read-untouched", { command: "read", file: untouchedFile, resolution: 3 });
		await astEditTool!.execute("ast-edit-preview", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			lang: "typescript",
			path: targetFile,
		});
		await resolveTool!.execute("resolve-apply", { action: "apply", reason: "Preview is correct" });
		await codeTool!.execute("edit-untouched", {
			command: "edit",
			file: untouchedFile,
			symbol: "untouched",
			operation: "patch",
			patches: [{ find: "return 2;", replace: "return 3;" }],
		});
		const closeCalls = executeSpy.mock.calls
			.map(call => call[0])
			.filter(options => options.command === "close" && String(options.file).startsWith(tempDir))
			.map(options => String(options.file));
		expect(closeCalls).toEqual([targetFile]);
		expect(await Bun.file(targetFile).text()).toContain("modernWrap(x, value)");
		expect(await Bun.file(untouchedFile).text()).toContain("return 3;");
	} finally {
		executeSpy.mockRestore();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("routes unsupported text edits through the code buffer lifecycle", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-unsupported-text-lifecycle-"));
	const executeSpy = spyOn(nativesModule, "executeCodeBuffer");
	try {
		const filePath = path.join(tempDir, "notes.foo");
		await Bun.write(filePath, "first line\nsecond line\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));
		const editResult = await tool.execute("unsupported-edit", {
			command: "edit",
			file: filePath,
			operation: "replace",
			content: ["first line", "updated line", "second line"],
		});
		expect(getText(editResult)).toContain("Edited notes.foo");
		expect(getText(editResult)).toContain("updated line");
		expect(await Bun.file(filePath).text()).toContain("updated line");
		const readBack = await tool.execute("unsupported-read", { command: "read", file: filePath, resolution: 3 });
		expect(getText(readBack)).toContain("updated line");
		const undoResult = await tool.execute("unsupported-undo", { command: "undo", file: filePath });
		expect(getText(undoResult)).not.toContain("Stale code buffer detected");
		expect(getText(undoResult)).toContain("Undo");
		expect(await Bun.file(filePath).text()).toContain("second line");
		const redoResult = await tool.execute("unsupported-redo", { command: "redo", file: filePath });
		expect(getText(redoResult)).not.toContain("Stale code buffer detected");
		expect(getText(redoResult)).toContain("Redo");
		expect(await Bun.file(filePath).text()).toContain("updated line");
	} finally {
		executeSpy.mockRestore();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("keeps semantic-capable edits on the shared lifecycle", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-semantic-lifecycle-"));
	const executeSpy = spyOn(nativesModule, "executeCodeBuffer");
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return oldCall();\n}\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));
		const editResult = await tool.execute("semantic-edit", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return oldCall();", replace: "return newCall();" }],
		});
		expect(getText(editResult)).toContain("Edited main.ts");
		expect(await Bun.file(filePath).text()).toContain("return newCall();");
		const readBack = await tool.execute("semantic-read", { command: "read", file: filePath, resolution: 3 });
		expect(getText(readBack)).toContain("return newCall();");
		const undoResult = await tool.execute("semantic-undo", { command: "undo", file: filePath });
		expect(getText(undoResult)).not.toContain("Stale code buffer detected");
		expect(await Bun.file(filePath).text()).toContain("return oldCall();");
		const redoResult = await tool.execute("semantic-redo", { command: "redo", file: filePath });
		expect(getText(redoResult)).not.toContain("Stale code buffer detected");
		expect(await Bun.file(filePath).text()).toContain("return newCall();");
	} finally {
		executeSpy.mockRestore();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
it("invalidates managed buffers after hashline edits on code files", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-hashline-invalidate-"));
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return oldCall();\n}\n");
		const tools = await createTools(
			createSession({
				cwd: tempDir,
				settings: Settings.isolated({ "lsp.enabled": false, "edit.mode": "hashline" }),
			}),
		);
		const codeTool = tools.find(entry => entry.name === "code");
		const editTool = tools.find(entry => entry.name === "edit");
		expect(codeTool).toBeDefined();
		expect(editTool).toBeDefined();

		await codeTool!.execute("code-read-before", { command: "read", file: filePath, resolution: 3 });
		await editTool!.execute("hashline-edit", {
			path: filePath,
			edits: [
				{
					op: "replace",
					pos: "2#HM",
					lines: ["  return midCall();"],
				},
			],
		});

		const followUp = await codeTool!.execute("code-edit-after", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return midCall();", replace: "return finalCall();" }],
		});
		expect(getText(followUp)).not.toContain("Stale code buffer detected");
		expect(await Bun.file(filePath).text()).toContain("return finalCall();");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("keeps failed edits and clean saves distinguishable", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-save-distinction-"));
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return oldCall();\n}\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));

		const failed = await tool.execute("tool-fail", {
			command: "edit",
			file: filePath,
			symbol: "missing",
			operation: "patch",
			patches: [{ find: "return oldCall();", replace: "return newCall();" }],
		});
		expect(failed.details).toEqual(expect.objectContaining({ kind: "error", command: "edit", error: true }));
		expect(getText(failed)).toContain("Symbol 'missing' not found");

		const saved = await tool.execute("tool-save", { command: "save", file: filePath });
		expect(saved.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "save",
				data: expect.objectContaining({ success: true, version: 0 }),
			}),
		);
		expect(getText(saved)).toContain("Saved main.ts (buffer version 0).");
		expect(getText(saved)).not.toContain("Edited main.ts");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("persists missing supported files created through edit create", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-create-missing-"));
	try {
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));
		const filePath = path.join(tempDir, "src", "new-module.ts");

		const result = await tool.execute("tool", {
			command: "edit",
			file: filePath,
			operation: "create",
			content: ["export const created = 1;"],
		});

		expect(getText(result)).toContain("Created src/new-module.ts");
		expect(await Bun.file(filePath).text()).toBe("export const created = 1;");

		const readBack = await tool.execute("tool-read", { command: "read", file: filePath, resolution: 3 });
		expect(getText(readBack)).toContain("export const created = 1;");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
it("does not leave stale buffers after a failed multi-edit", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-stale-rollback-"));
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return oldCall();\n}\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));

		const failed = await tool.execute("tool-fail", {
			command: "edit",
			file: filePath,
			edits: [
				{
					symbol: "main",
					operation: "patch",
					patches: [{ find: "return oldCall();", replace: "return newCall();" }],
				},
				{
					symbol: "missing",
					operation: "patch",
					patches: [{ find: "return oldCall();", replace: "return shouldNotApply();" }],
				},
			],
		});
		expect(failed.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
		expect(await Bun.file(filePath).text()).toContain("return oldCall();");

		const followUp = await tool.execute("tool-follow", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return oldCall();", replace: "return finalCall();" }],
		});
		expect(getText(followUp)).not.toContain("Stale code buffer detected");
		expect(await Bun.file(filePath).text()).toContain("return finalCall();");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("routes unsupported text-like edit lifecycle through code buffers", async () => {
	_resetSupportedExtensionsForTest(new Set(["ts"]));
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-edit-text-fallback-"));
	const executeSpy = spyOn(nativesModule, "executeCodeBuffer");
	try {
		const filePath = path.join(tempDir, "notes.txt");
		await Bun.write(filePath, "alpha\nbeta\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));

		const result = await tool.execute("tool-edit", {
			command: "edit",
			file: filePath,
			operation: "replace",
			content: "alpha\ngamma\n",
		});

		expect(getText(result)).toContain("Edited notes.txt");
		expect(await Bun.file(filePath).text()).toContain("gamma");
		expect(executeSpy.mock.calls.some(call => call[0].command === "diff" && call[0].file === filePath)).toBe(true);

		const readBack = await tool.execute("tool-read", { command: "read", file: filePath, resolution: 3 });
		expect(getText(readBack)).toContain("gamma");

		const undo = await tool.execute("tool-undo", { command: "undo", file: filePath });
		expect(getText(undo)).toContain("Undo");
		const redo = await tool.execute("tool-redo", { command: "redo", file: filePath });
		expect(getText(redo)).toContain("Redo");
	} finally {
		executeSpy.mockRestore();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

it("still preserves semantic-capable edit lifecycle", async () => {
	_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-edit-ts-lifecycle-"));
	try {
		const filePath = path.join(tempDir, "main.ts");
		await Bun.write(filePath, "export function main() {\n  return oldCall();\n}\n");
		const tool = new CodeTool(createSession({ cwd: tempDir, settings: Settings.isolated({ "lsp.enabled": false }) }));

		const result = await tool.execute("tool-edit", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return oldCall();", replace: "return newCall();" }],
		});

		expect(getText(result)).toContain("Edited main.ts");
		expect(await Bun.file(filePath).text()).toContain("return newCall();");

		const followUp = await tool.execute("tool-follow", {
			command: "edit",
			file: filePath,
			symbol: "main",
			operation: "patch",
			patches: [{ find: "return newCall();", replace: "return finalCall();" }],
		});
		expect(getText(followUp)).not.toContain("Stale code buffer detected");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
