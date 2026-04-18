import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import { logger } from "@oh-my-pi/pi-utils";

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
});

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

	it("routes file-local symbols through outline machinery even when query is present", async () => {
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: [
				{
					name: "alpha",
					kind: "function",
					line: 1,
					endLine: 3,
					children: [{ name: "beta", kind: "function", line: 2, endLine: 2, children: [] }],
				},
			],
			error: false,
		});
		const graphSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "unused",
			cacheStatus: "hit",
			rebuilt: false,
			fileCount: 0,
			symbolCount: 0,
			edgeCount: 0,
			semanticStatus: undefined,
		});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "symbols",
			file: "src/example.ts",
			query: "ignored",
		});
		expect(bufferSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/example.ts" }),
		);
		expect(graphSpy).not.toHaveBeenCalled();
		expect(getText(result)).toContain("Symbols src/example.ts (1 top, 2 total)");
	});

	it("routes workspace symbols to the native graph backend", async () => {
		const graphSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output: "Symbols\nQuery: rateLimit\nStatus: exact\n- src/rate_limit.ts::rateLimit",
			cacheStatus: "hit",
			rebuilt: false,
			fileCount: 1,
			symbolCount: 2,
			edgeCount: 3,
			semanticStatus: "ready",
		});
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "symbols", query: "rateLimit" });
		expect(graphSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "symbols", query: "rateLimit", root: "/tmp/test" }),
		);
		expect(bufferSpy).not.toHaveBeenCalled();
		expect(getText(result)).toContain("Status: exact");
	});

	it("routes bare symbols to the native graph backend for workspace summary", async () => {
		const graphSpy = spyOn(nativesModule, "executeCodeGraph").mockResolvedValue({
			output:
				"Symbols summary\nQuery: (all symbols)\nStatus: summary\n- src/rate_limit.ts::rateLimit\nNext: add a symbol name or qualified path to narrow results",
			cacheStatus: "hit",
			rebuilt: false,
			fileCount: 1,
			symbolCount: 2,
			edgeCount: 3,
			semanticStatus: undefined,
		});
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", { command: "symbols" });
		expect(graphSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "symbols", query: undefined, root: "/tmp/test" }),
		);
		expect(bufferSpy).not.toHaveBeenCalled();
		expect(getText(result)).toContain("Status: summary");
	});

	it("redirects removed repo-local files and search commands to grep", async () => {
		const tool = new CodeTool(createSession());
		const filesResult = await tool.execute("tool", { command: "files", query: "rate_limit.ts" });
		expect(getText(filesResult)).toContain("Repo-local files moved to grep");
		expect(getText(filesResult)).toContain(`mode: "semantic"`);
		expect(getText(filesResult)).toContain(`mode: "rawText"`);

		const searchResult = await tool.execute("tool", { command: "search", query: "rateLimit" });
		expect(getText(searchResult)).toContain("Repo-local search moved to grep");
		expect(getText(searchResult)).toContain(`mode: "semantic"`);
		expect(getText(searchResult)).toContain(`mode: "rawText"`);
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

	it("routes existing-file edit through freshness diff before save", async () => {
		const targetFile = path.join(process.cwd(), "packages/coding-agent/test/tools/code.test.ts");
		const operations = [
			{
				targetId: "packages/coding-agent/test/tools/code.test.ts",
				actions: [{ kind: "write", content: "export const touched = true;\n" }],
			},
		];
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					version: 1,
					diff: "@@ file @@\n-old\n+new",
					editCount: 1,
					created: false,
					targets: [{ targetId: "packages/coding-agent/test/tools/code.test.ts", actions: ["write"] }],
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(
			createSession({
				cwd: process.cwd(),
				settings: Settings.isolated({ "lsp.enabled": false }),
			}),
		);

		await tool.execute("tool", {
			command: "edit",
			operations,
		});

		expect(bufferSpy.mock.calls.map(([call]) => call.command)).toEqual(["diff", "edit", "save"]);
		expect(bufferSpy.mock.calls[0]?.[0]).toEqual({ command: "diff", file: targetFile });
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				command: "edit",
				root: process.cwd(),
				operations,
			}),
		);
		expect(bufferSpy.mock.calls[2]?.[0]).toEqual({ command: "save", file: targetFile });
	});

	it("routes strict-target create through list then save without diff", async () => {
		const operations = [
			{ targetId: "definitely-missing.ts", actions: [{ kind: "write", content: "export const created = true;\n" }] },
		];
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					version: 1,
					diff: "@@ file @@\n+export const created = true;",
					editCount: 1,
					created: true,
					targets: [{ targetId: "definitely-missing.ts", actions: ["write"] }],
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true }, error: false });
		const tool = new CodeTool(
			createSession({
				settings: Settings.isolated({ "lsp.enabled": false }),
			}),
		);

		await tool.execute("tool", {
			command: "edit",
			operations,
		});

		expect(bufferSpy.mock.calls.map(([call]) => call.command)).toEqual(["list", "edit", "save"]);
		expect(bufferSpy.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				command: "edit",
				root: "/tmp/test",
				operations,
			}),
		);
		expect(bufferSpy.mock.calls.some(([call]) => call.command === "diff")).toBe(false);
	});

	it("refuses stale managed-missing buffers before edit", async () => {
		const stalePath = path.join("/tmp/test", "missing.ts");
		const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockImplementation(({ command }) => {
			if (command === "list") {
				return { output: [{ path: stalePath, dirty: true, version: 1 }], error: false } as any;
			}
			return { output: { success: true }, error: false } as any;
		});
		const tool = new CodeTool(
			createSession({
				settings: Settings.isolated({ "lsp.enabled": false }),
			}),
		);
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [
				{ targetId: "missing.ts", actions: [{ kind: "write", content: "export const touched = true;\n" }] },
			],
		});

		expect(getText(result)).toContain("managed buffer exists for a file that is now missing on disk");
		expect(bufferSpy.mock.calls.map(([call]) => call.command)).toEqual(["list"]);
	});

	it("routes other tool commands intact", async () => {
		const tools = await createTools(createSession());
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.some(tool => tool.name === "code")).toBe(true);
		expect(PendingActionStore).toBeDefined();
	});
});

it("accepts new structural edit fields in the schema and passes them through", async () => {
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
		.mockReturnValueOnce({ output: [], error: false })
		.mockReturnValueOnce({
			output: {
				version: 1,
				diff: "@@ file @@\n-a\n+b",
				editCount: 1,
				created: false,
				targets: [{ targetId: "src/example.ts", actions: ["delete"] }],
			},
			error: false,
		})
		.mockReturnValueOnce({ output: { success: true }, error: false })
		.mockReturnValue({ output: { success: true }, error: false });
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", {
		command: "edit",
		operations: [
			{
				targetId: "src/example.ts",
				actions: [{ kind: "delete", allowSiblingDelete: true, occurrence: 1 }],
			},
		],
	});

	expect(bufferSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			command: "edit",
			root: "/tmp/test",
			operations: expect.arrayContaining([
				expect.objectContaining({
					targetId: "src/example.ts",
					actions: expect.arrayContaining([expect.objectContaining({ allowSiblingDelete: true, occurrence: 1 })]),
				}),
			]),
		}),
	);
	expect(getText(result)).toContain("Target: src/example.ts");
});

it("preserves findAndReplace occurrence through normalization", async () => {
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
		.mockReturnValueOnce({ output: [], error: false })
		.mockReturnValueOnce({
			output: {
				version: 1,
				diff: "@@ main @@\n-const value = 1;\n+const picked = 2;",
				editCount: 1,
				created: false,
				targets: [{ targetId: "src/example.ts::main", actions: ["findAndReplace"] }],
			},
			error: false,
		})
		.mockReturnValueOnce({ output: "export function main() {\n  const picked = 2;\n}\n", error: false })
		.mockReturnValue({ output: { success: true }, error: false });
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", {
		command: "edit",
		operations: [
			{
				targetId: "src/example.ts::main",
				actions: [
					{
						kind: "findAndReplace",
						find: ["const value = 1;"],
						content: ["const picked = 2;"],
						occurrence: "last",
					},
				],
			},
		],
	});

	expect(bufferSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			command: "edit",
			root: "/tmp/test",
			operations: expect.arrayContaining([
				expect.objectContaining({
					targetId: "src/example.ts::main",
					actions: expect.arrayContaining([
						expect.objectContaining({
							kind: "findAndReplace",
							find: "const value = 1;",
							content: "const picked = 2;",
							occurrence: "last",
						}),
					]),
				}),
			]),
		}),
	);
	expect(getText(result)).toContain("Target: src/example.ts::main [findAndReplace]");
});

it("classifies native object payload failures", async () => {
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValueOnce({
		output: { code: "LOCK_TIMEOUT", message: "Timed out while waiting for lock" },
		error: true,
	});
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", {
		command: "edit",
		operations: [{ targetId: "src/example.ts", actions: [{ kind: "write", content: "x" }] }],
	});

	expect(getText(result)).toContain("Timed out while waiting for lock");
	expect(getText(result)).toContain("[lock_timeout]");
	expect(getText(result)).toContain("inspect lockStatus");
	expect(bufferSpy).toHaveBeenCalled();
});

it("surfaces new lock and scope failure codes", async () => {
	const bufferSpy = spyOn(nativesModule, "executeCodeBuffer")
		.mockReturnValueOnce({ output: { code: "UNSAFE_SCOPE_WRITE", message: "Outside scope" }, error: true })
		.mockReturnValueOnce({ output: { code: "LINE_OUT_OF_TARGET_SCOPE", message: "Wrong line" }, error: true })
		.mockReturnValueOnce({ output: { code: "LOCK_ERROR", message: "Lock failed" }, error: true })
		.mockReturnValueOnce({
			output: { code: "EXTERNAL_MODIFICATION", message: "File changed", targetId: "src/example.ts" },
			error: true,
		});
	const tool = new CodeTool(createSession());
	for (const expected of ["unsafe_scope_write", "line_out_of_target_scope", "lock_error", "external_modification"]) {
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: "src/example.ts", actions: [{ kind: "write", content: "x" }] }],
		});
		expect(getText(result)).toContain(`[${expected}]`);
	}
	expect(bufferSpy).toHaveBeenCalledTimes(4);
});

it("surfaces a stale-module diagnostic when execute() throws ReferenceError", async () => {
	spyOn(nativesModule, "executeCodeBuffer").mockImplementation(() => {
		throw new ReferenceError("editFile is not defined");
	});
	const warnSpy = spyOn(logger, "warn");
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", { command: "languages" });
	const text = getText(result);
	expect(text).toContain("Stale module detected");
	expect(text).toContain("Restart the session");
	expect(text).toContain("editFile is not defined");
	expect(text).toContain("ReferenceError");
	expect(result.details).toEqual(expect.objectContaining({ kind: "error", error: true }));
	expect(warnSpy).toHaveBeenCalledWith(
		"code tool stale module",
		expect.objectContaining({ errorName: "ReferenceError", command: "languages" }),
	);
});

it("treats TypeError 'is not a function' as stale module", async () => {
	spyOn(nativesModule, "executeCodeBuffer").mockImplementation(() => {
		throw new TypeError("editHasManagedMissingBuffer is not a function");
	});
	const warnSpy = spyOn(logger, "warn");
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", { command: "languages" });
	expect(getText(result)).toContain("Stale module detected");
	expect(warnSpy).toHaveBeenCalledWith(
		"code tool stale module",
		expect.objectContaining({ errorName: "TypeError", command: "languages" }),
	);
});

it("leaves non-stale Error messages unchanged (regression guard)", async () => {
	spyOn(nativesModule, "executeCodeBuffer").mockImplementation(() => {
		throw new Error("boom: native failure");
	});
	const warnSpy = spyOn(logger, "warn");
	const tool = new CodeTool(createSession());
	const result = await tool.execute("tool", { command: "languages" });
	const text = getText(result);
	expect(text).toContain("boom: native failure");
	expect(text).not.toContain("Stale module detected");
	const staleWarns = warnSpy.mock.calls.filter(([msg]) => msg === "code tool stale module");
	expect(staleWarns).toHaveLength(0);
});
