import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

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
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodeBuffer") as any).mockRestore?.();
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodeGraph") as any).mockRestore?.();
		} catch {}
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
		expect(executeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "status",
				root: "/tmp/project",
			}),
		);
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
			expect.objectContaining({
				command: "search",
				query: "foo",
				semantic: true,
				root: "/tmp/project",
			}),
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
			expect.objectContaining({
				command: "outline",
				file: "/tmp/test/src/main.ts",
			}),
		);
	});

	it("smoke-tests Typst outline wiring for .typ files", async () => {
		const outlinePayload = [
			{
				name: '"theme.typ"',
				kind: "import",
				line: 1,
				end_line: 1,
				column: 1,
				exported: false,
				signature: 'import "theme.typ": *',
				children: [],
			},
			{
				name: "title",
				kind: "let",
				line: 2,
				end_line: 2,
				column: 1,
				exported: false,
				signature: "let title =",
				children: [],
			},
			{
				name: "heading.where(level: 1)",
				kind: "show",
				line: 3,
				end_line: 3,
				column: 1,
				exported: false,
				signature: "show heading.where(level: 1):",
				children: [],
			},
		];
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: outlinePayload,
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/tmp/test" }));
		const file = "/tmp/test/docs/report.typ";
		const result = await tool.execute("tool", { command: "outline", file });

		expect(getText(result)).toContain("Outline docs/report.typ (3 top-level, 3 total symbols)");
		expect(getText(result)).toContain('import "theme.typ" L1');
		expect(getText(result)).toContain("show heading.where(level: 1) L3");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "outline",
				rawOutput: outlinePayload,
			}),
		);
		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "outline",
				file,
			}),
		);
	});

	it("maps 'buffers' command to 'list' for NAPI", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [{ path: "src/main.ts", dirty: false }],
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "buffers" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "list" }));
	});

	it("maps 'references-local' navigate action to 'references'", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { references: [] },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "navigate",
			file: "/tmp/test/src/main.ts",
			action: "references-local",
			line: 10,
		});

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "navigate",
				action: "references",
				file: "/tmp/test/src/main.ts",
				line: 10,
			}),
		);
	});

	it("passes navigate line unchanged", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { node_type: "identifier", text: "foo", line: 10, end_line: 10 },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "navigate",
			file: "/tmp/test/src/main.ts",
			action: "node-at",
			line: 10,
		});

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "navigate",
				action: "node-at",
				file: "/tmp/test/src/main.ts",
				line: 10,
			}),
		);
	});

	it("preserves additive editable-scope metadata for navigate output", async () => {
		const rawOutput = {
			nodeType: "let",
			text: 'let teal-primary = rgb("#008080")',
			line: 7,
			endLine: 7,
			editableScopeNodeType: "code",
			editableScopeLine: 7,
			editableScopeEndLine: 7,
			editableScopeColumn: 0,
		};
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: rawOutput,
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "navigate",
			file: "/tmp/test/src/main.typ",
			action: "node-at",
			line: 7,
		});

		expect(getText(result)).toContain("Navigate node-at src/main.typ: let L7");
		expect(getText(result)).toContain("editable scope: code L7");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "navigate",
				rawOutput,
				data: expect.objectContaining({
					nodeType: "let",
					editableScopeNodeType: "code",
					editableScopeLine: 7,
					editableScopeEndLine: 7,
					editableScopeColumn: 0,
				}),
			}),
		);
	});

	it("returns plain-text error for install_grammar command", async () => {
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "install_grammar" });

		expect(getText(result)).toBe(
			"Error: install_grammar is no longer supported. Grammars for TypeScript, Rust, Python, and Elixir are built-in.",
		);
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "error",
				error: true,
				command: "install_grammar",
			}),
		);
	});

	it("passes through read params (resolution, offset, limit)", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "file content",
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "read",
			file: "/tmp/test/src/main.ts",
			resolution: 2,
			offset: 10,
			limit: 50,
		});

		expect(getText(result)).toBe("file content");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "read",
				data: expect.objectContaining({ resolution: 2, offset: 10, limit: 50 }),
			}),
		);
		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "read",
				file: "/tmp/test/src/main.ts",
				resolution: 2,
				offset: 10,
				limit: 50,
			}),
		);
	});

	it("formats edit results as compact diffs instead of raw JSON dumps", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { version: 2, diff: "@@ add @@\n-return a + b;\n+return a * b;", editCount: 1 },
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "add",
			operation: "patch",
			patches: [{ find: "return a + b;", replace: "return a * b;" }],
		});

		expect(getText(result)).toContain("Edited src/main.ts (1 operation, buffer version 2)");
		expect(getText(result)).toContain("@@ add @@");
		expect(getText(result)).not.toMatch(/^\s*\{/);
		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				file: "/tmp/test/src/main.ts",
				symbol: "add",
				operation: "patch",
				patches: [{ find: "return a + b;", replace: "return a * b;" }],
			}),
		);
	});

	it("forwards edit batches", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { version: 3, diff: "@@ add @@", editCount: 2 },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			edits: [
				{ symbol: "add", operation: "rename", content: "sum" },
				{ line: 8, operation: "splice", mode: "down" },
			],
		});

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				file: "/tmp/test/src/main.ts",
				edits: [
					{ symbol: "add", operation: "rename", content: "sum" },
					{ line: 8, operation: "splice", mode: "down" },
				],
			}),
		);
	});

	it("surfaces thrown native exceptions as plain-text tool errors", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockImplementation(() => {
			throw new Error("Language profile not found for /tmp/test/foo.go");
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "outline", file: "/tmp/test/foo.go" });

		expect(getText(result)).toBe("Error: Language profile not found for /tmp/test/foo.go");
		expect(result.details).toEqual(
			expect.objectContaining({ kind: "error", error: true, command: "outline", displayPath: "foo.go" }),
		);
	});

	it("surfaces native error envelopes from executeCodeBuffer response", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "Unknown command: bogus",
			error: true,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "bogus" });

		expect(getText(result)).toBe("Error: Unknown command: bogus");
		expect(result.details).toEqual(
			expect.objectContaining({ kind: "error", error: true, command: "bogus", message: "Unknown command: bogus" }),
		);
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
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [],
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/virtual/session/src/main.ts" }));
	});

	it("passes through absolute file paths unchanged", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [],
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "/opt/project/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/opt/project/src/main.ts" }));
	});

	it("does not forward file-local depth", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [],
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts", depth: 2 });

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/main.ts" }),
		);
		expect(bufferSpy.mock.calls[0]?.[0]).not.toHaveProperty("depth");
	});
	it("auto-saves to disk after successful edit", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({
				output: { version: 2, diff: "@@ patch @@\n-old\n+new", editCount: 1 },
				error: false,
			})
			.mockReturnValueOnce({
				output: { success: true, version: 2 },
				error: false,
			});
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
			.mockReturnValueOnce({
				output: { version: 1, diff: "@@ undo @@" },
				error: false,
			})
			.mockReturnValueOnce({
				output: { success: true },
				error: false,
			});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "undo",
			file: "/tmp/test/src/main.ts",
		});

		expect(bufferSpy).toHaveBeenCalledTimes(2);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("auto-saves to disk after successful redo", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({
				output: { version: 3, diff: "@@ redo @@" },
				error: false,
			})
			.mockReturnValueOnce({
				output: { success: true },
				error: false,
			});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "redo",
			file: "/tmp/test/src/main.ts",
		});

		expect(bufferSpy).toHaveBeenCalledTimes(2);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({ command: "save", file: "/tmp/test/src/main.ts" }),
		);
		expect(result.details).toEqual(expect.objectContaining({ kind: "file" }));
	});

	it("returns error when auto-save after edit fails", async () => {
		spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({
				output: { version: 2, diff: "@@ patch @@", editCount: 1 },
				error: false,
			})
			.mockReturnValueOnce({
				output: "Permission denied",
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

		expect(getText(result)).toContain("save to disk failed");
		expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
	});

	it("does not auto-save after non-mutating commands", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [],
			error: false,
		});
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
