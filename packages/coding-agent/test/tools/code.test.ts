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
		const text = result.content.find(content => content.type === "text")?.text;

		expect(text).toBe("Code graph status\nCache: fresh\nSemantic: missing");
		expect(result.details).toEqual(
			expect.objectContaining({
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

	it("routes file-local commands to executeCodeBuffer", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { result: "outline data" },
			error: false,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts" });
		const text = result.content.find(c => c.type === "text")?.text ?? "";

		expect(JSON.parse(text)).toEqual({ result: "outline data" });
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
			},
			{
				name: "title",
				kind: "let",
				line: 2,
				end_line: 2,
				column: 1,
				exported: false,
				signature: "let title =",
			},
			{
				name: "heading.where(level: 1)",
				kind: "show",
				line: 3,
				end_line: 3,
				column: 1,
				exported: false,
				signature: "show heading.where(level: 1):",
			},
		];
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: outlinePayload,
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/tmp/test" }));
		const file = "/tmp/test/docs/report.typ";
		const result = await tool.execute("tool", { command: "outline", file });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		const parsed = JSON.parse(text);

		expect(parsed).toEqual(outlinePayload);
		expect(parsed.map((entry: { kind: string }) => entry.kind)).toEqual(["import", "let", "show"]);
		expect(parsed[2]).toEqual(expect.objectContaining({ name: "heading.where(level: 1)", kind: "show" }));
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

	it("does not override navigate line with zero-value target.line", async () => {
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
			target: { line: 0 },
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

	it("returns error for install_grammar command", async () => {
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "install_grammar" });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		const parsed = JSON.parse(text);

		expect(parsed.error).toBe(true);
		expect(parsed.message).toContain("install_grammar is no longer supported");
		expect(result.details).toEqual({ error: true, command: "install_grammar" });
	});

	it("passes through read params (resolution, offset, limit)", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "file content",
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "read",
			file: "/tmp/test/src/main.ts",
			resolution: 2,
			offset: 10,
			limit: 50,
		});

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

	it("flattens target into top-level fields for edit", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [{ version: 2 }],
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "kill",
			target: { line: 5, node_type: "function_declaration" },
		});

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				file: "/tmp/test/src/main.ts",
				operation: "kill",
				line: 5,
				node_type: "function_declaration",
			}),
		);
	});
	it("surfaces thrown native exceptions as tool error results", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockImplementation(() => {
			throw new Error("Language profile not found for /tmp/test/foo.go");
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "outline", file: "/tmp/test/foo.go" });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		const parsed = JSON.parse(text);

		expect(parsed.error).toBe(true);
		expect(parsed.message).toContain("Language profile not found");
		expect(result.details).toEqual({ error: true, command: "outline" });
	});

	it("surfaces native error envelopes from executeCodeBuffer response", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "Unknown command: bogus",
			error: true,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "bogus" });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		const parsed = JSON.parse(text);

		expect(parsed).toEqual(expect.objectContaining({ error: true, message: "Unknown command: bogus" }));
		expect(result.details).toEqual({ error: true, command: "bogus" });
	});

	it("forwards mode for splice edit operations", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [{ version: 3 }],
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			operation: "splice",
			mode: "down",
			target: { line: 8, node_type: "block" },
		});

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ operation: "splice", mode: "down" }));
	});

	it("resolves relative file paths against session cwd", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "relative content",
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/virtual/session/src/main.ts" }));
	});

	it("passes through absolute file paths unchanged", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "absolute content",
			error: false,
		});
		const tool = new CodeTool(createSession({ cwd: "/virtual/session" }));
		await tool.execute("tool", { command: "outline", file: "/opt/project/src/main.ts" });

		expect(bufferSpy).toHaveBeenCalledWith(expect.objectContaining({ file: "/opt/project/src/main.ts" }));
	});

	it("does not forward file-local depth", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "depth content",
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", { command: "outline", file: "/tmp/test/src/main.ts", depth: 2 });

		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/main.ts" }),
		);
		expect(bufferSpy.mock.calls[0]?.[0]).not.toHaveProperty("depth");
	});
});
