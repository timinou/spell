import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

		expect(getText(result)).toContain("Outline src/main.ts (1 top-level, 1 total symbols)");
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
		const result = await tool.execute("tool", { command: "read", file: "/tmp/test/doc.md" });

		expect(getText(result)).toContain("Unsupported file type .md");
		expect(getText(result)).toContain("supports TypeScript, Rust, Python, Typst, and Elixir");
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
		const tool = new CodeTool(createSession());
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
		const tool = new CodeTool(createSession());
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
