import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
	"html",
	"htm",
	"css",
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

	it("surfaces conservative html rename refusals from native edit handling", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					message:
						"HTML/CSS rename is not yet supported safely. Use rename-class-token, rename-id-token, or rename-custom-property only when the target is a provable literal token.",
					operation: "rename",
					proof: {
						basis: "operation_scope",
						confidence: "low",
						reason: "generic rename does not preserve proof for HTML/CSS token semantics",
					},
				},
				error: true,
			});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: "index.html::div#save", actions: [{ kind: "rename", content: "saveButton" }] }],
		});

		expect(getText(result)).toContain("HTML/CSS rename is not yet supported safely");
		expect(getText(result)).toContain("Proof: operation_scope");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "error",
				error: true,
				proof: expect.objectContaining({ basis: "operation_scope", confidence: "low" }),
			}),
		);
		expect(bufferSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				root: "/tmp/test",
				operations: expect.arrayContaining([
					expect.objectContaining({
						targetId: "index.html::div#save",
						actions: expect.arrayContaining([expect.objectContaining({ kind: "rename", content: "saveButton" })]),
					}),
				]),
			}),
		);
	});

	it("surfaces successful html/css proof-backed edit metadata", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					version: 2,
					diff: '@@ button#save @@\n-<button id="save"></button>\n+<button id="saveButton"></button>',
					editCount: 1,
					created: false,
					targets: [{ targetId: "index.html::button#save", actions: ["renameIdToken"] }],
					proof: {
						basis: "file_local_exact_scan",
						confidence: "high",
						reason: "renamed literal id attributes in the current HTML buffer",
						matches: 1,
					},
				},
				error: false,
			})
			.mockReturnValueOnce({ output: '<button id="saveButton"></button>\n', error: false })
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [
				{ targetId: "index.html::button#save", actions: [{ kind: "renameIdToken", content: "saveButton" }] },
			],
		});

		expect(getText(result)).toContain("Target: index.html::button#save [renameIdToken]");
		expect(getText(result)).toContain("Proof: file_local_exact_scan");
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "file",
				command: "edit",
				data: expect.objectContaining({
					targets: expect.arrayContaining([
						expect.objectContaining({ targetId: "index.html::button#save", actions: ["renameIdToken"] }),
					]),
					proof: expect.objectContaining({ basis: "file_local_exact_scan", confidence: "high", matches: 1 }),
				}),
			}),
		);
		expect(bufferSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				root: "/tmp/test",
				operations: expect.arrayContaining([
					expect.objectContaining({
						targetId: "index.html::button#save",
						actions: expect.arrayContaining([
							expect.objectContaining({ kind: "renameIdToken", content: "saveButton" }),
						]),
					}),
				]),
			}),
		);
		void bufferSpy;
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

		await expect(
			tool.execute("tool", {
				command: "edit",
				operations: [{ targetId: "test.txt", actions: [{ kind: "write", content: "x" }] }],
			}),
		).rejects.toThrow('Read-only mode "readonly": file modifications are not allowed.');
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
		const graphSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "graph output",
			cacheStatus: "hit",
			rebuilt: false,
			fileCount: 1,
			symbolCount: 2,
			edgeCount: 3,
			semanticStatus: "ready",
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "status",
		});
		expect(graphSpy).toHaveBeenCalled();
	});

	it("routes edit operations to native buffer backend", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { success: true },
			error: false,
		});
		const tool = new CodeTool(createSession());
		await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: "main.ts::main", actions: [{ kind: "write", scope: "body", content: "return 1;" }] }],
		});
		expect(bufferSpy).toHaveBeenCalled();
	});

	it("routes other tool commands intact", async () => {
		const tools = await createTools(createSession());
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.some(tool => tool.name === "code")).toBe(true);
		expect(PendingActionStore).toBeDefined();
	});
});
