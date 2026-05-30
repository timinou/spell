import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RenderResultOptions } from "@spell/pi-agent-core";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import * as lspClientModule from "@spell/pi-coding-agent/lsp/client";
import * as lspConfigModule from "@spell/pi-coding-agent/lsp/config";
import { LspTool } from "@spell/pi-coding-agent/lsp/index";
import * as lspmuxModule from "@spell/pi-coding-agent/lsp/lspmux";
import { renderCall, renderResult } from "@spell/pi-coding-agent/lsp/render";
import type { CodeAction, SymbolInformation } from "@spell/pi-coding-agent/lsp/types";
import {
	applyCodeAction,
	collectGlobMatches,
	dedupeWorkspaceSymbols,
	filterWorkspaceSymbols,
	hasGlobPattern,
	resolveSymbolColumn,
} from "@spell/pi-coding-agent/lsp/utils";
import { getThemeByName } from "@spell/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@spell/pi-coding-agent/tools";
import { clampTimeout } from "@spell/pi-coding-agent/tools/tool-timeouts";
import { sanitizeText } from "@spell/pi-natives";
import { TempDir } from "@spell/pi-utils";

describe("lsp regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detects bracket-style glob patterns", () => {
		expect(hasGlobPattern("src/[ab].ts")).toBe(true);
		expect(hasGlobPattern("src/**/*.ts")).toBe(true);
		expect(hasGlobPattern("src/main.ts")).toBe(false);
	});

	it("clamps LSP timeout to configured bounds", () => {
		expect(clampTimeout("lsp")).toBe(20);
		expect(clampTimeout("lsp", 1)).toBe(5);
		expect(clampTimeout("lsp", 1000)).toBe(60);
	});

	it("limits glob collection to avoid large diagnostic stalls", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-glob-");
		try {
			await Promise.all([
				Bun.write(`${tempDir.path()}/a.ts`, "export const a = 1;\n"),
				Bun.write(`${tempDir.path()}/b.ts`, "export const b = 1;\n"),
				Bun.write(`${tempDir.path()}/c.ts`, "export const c = 1;\n"),
			]);
			const result = await collectGlobMatches("*.ts", tempDir.path(), 2);
			expect(result.matches).toHaveLength(2);
			expect(result.truncated).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves the requested symbol occurrence on a line", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-regression-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo(bar(foo));\n");

			expect(await resolveSymbolColumn(filePath, 1, "foo")).toBe(0);
			expect(await resolveSymbolColumn(filePath, 1, "foo", 2)).toBe(8);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when symbol does not exist on the target line", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-missing-symbol-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "winston.info('x');\n");

			await expect(resolveSymbolColumn(filePath, 1, "nonexistent_symbol")).rejects.toThrow(
				'Symbol "nonexistent_symbol" not found on line 1',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when occurrence is out of bounds", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-occurrence-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo();\n");

			await expect(resolveSymbolColumn(filePath, 1, "foo", 2)).rejects.toThrow(
				'Symbol "foo" occurrence 2 is out of bounds on line 1 (found 1)',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("filters and deduplicates workspace symbols by query", () => {
		const symbols: SymbolInformation[] = [
			{
				name: "DisallowOverwritingRegularFilesViaOutputRedirection",
				kind: 12,
				location: {
					uri: "file:///tmp/rust.rs",
					range: {
						start: { line: 10, character: 2 },
						end: { line: 10, character: 60 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
		];

		const filtered = filterWorkspaceSymbols(symbols, "logger");
		const unique = dedupeWorkspaceSymbols(filtered);

		expect(filtered).toHaveLength(2);
		expect(unique).toHaveLength(1);
		expect(unique[0]?.name).toBe("logger");
	});

	it("applies command-only code actions by executing workspace commands", async () => {
		const executedCommands: string[] = [];
		const result = await applyCodeAction(
			{ title: "Organize Imports", command: "source.organizeImports" },
			{
				applyWorkspaceEdit: async () => [],
				executeCommand: async command => {
					executedCommands.push(command.command);
				},
			},
		);

		expect(executedCommands).toEqual(["source.organizeImports"]);
		expect(result).toEqual({
			title: "Organize Imports",
			edits: [],
			executedCommands: ["source.organizeImports"],
		});
	});

	it("resolves code actions before applying edits", async () => {
		const unresolvedAction: CodeAction = { title: "Add import" };
		const appliedEdits: string[] = [];
		const result = await applyCodeAction(unresolvedAction, {
			resolveCodeAction: async action => ({
				...action,
				edit: {
					changes: {
						"file:///tmp/example.ts": [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "import x from 'y';\n",
							},
						],
					},
				},
			}),
			applyWorkspaceEdit: async () => {
				appliedEdits.push("example.ts: 1 edit");
				return ["example.ts: 1 edit"];
			},
			executeCommand: async () => {},
		});

		expect(appliedEdits).toEqual(["example.ts: 1 edit"]);
		expect(result).toEqual({
			title: "Add import",
			edits: ["example.ts: 1 edit"],
			executedCommands: [],
		});
	});

	it("sanitizes symbol metadata in renderer output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const call = renderCall(
			{ action: "definition", file: "src/example.ts", line: 10, symbol: "foo\tbar\nbaz" },
			renderOptions,
			uiTheme,
		);
		const callText = sanitizeText(call.render(120).join("\n"));
		const normalizedCallText = callText.replace(/\s+/g, " ");
		expect(normalizedCallText).toContain("foo bar baz");
		expect(callText).not.toContain("\t");
		const result = renderResult(
			{
				content: [{ type: "text", text: "No definition found" }],
				details: {
					action: "definition",
					success: true,
					request: {
						action: "definition",
						file: "src/example.ts",
						line: 10,
						symbol: "foo\tbar\nbaz",
						occurrence: 2,
					},
				},
			},
			renderOptions,
			uiTheme,
		);
		const resultText = sanitizeText(result.render(120).join("\n"));
		const normalizedResultText = resultText.replace(/\s+/g, " ");
		expect(normalizedResultText).toContain("symbol: foo bar baz");
		expect(normalizedResultText).toContain("occurrence: 2");
		expect(resultText).not.toContain("\t");
	});

	it("detects Typst via .git marker without typst.toml", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-typst-");
		const originalPath = Bun.env.PATH;
		try {
			await fs.mkdir(path.join(tempDir.path(), ".git"), { recursive: true });
			await Bun.write(path.join(tempDir.path(), "main.typ"), "= heading\n");
			await fs.mkdir(path.join(tempDir.path(), "bin"), { recursive: true });
			await Bun.write(path.join(tempDir.path(), "bin", "tinymist"), "#!/usr/bin/env sh\nexit 0\n");
			await fs.chmod(path.join(tempDir.path(), "bin", "tinymist"), 0o755);
			Bun.env.PATH = `${path.join(tempDir.path(), "bin")}:${originalPath ?? ""}`;

			const config = lspConfigModule.loadConfig(tempDir.path());
			const server = lspConfigModule.getServerForFile(config, path.join(tempDir.path(), "main.typ"));

			expect(config.servers.tinymist).toBeDefined();
			expect(server?.[0]).toBe("tinymist");
		} finally {
			Bun.env.PATH = originalPath;
			tempDir.removeSync();
		}
	});

	it("does not activate Typst without any root markers", async () => {
		const tempDir = TempDir.createSync("@spell-lsp-typst-missing-root-");
		const originalPath = Bun.env.PATH;
		try {
			await Bun.write(path.join(tempDir.path(), "main.typ"), "= heading\n");
			await fs.mkdir(path.join(tempDir.path(), "bin"), { recursive: true });
			await Bun.write(path.join(tempDir.path(), "bin", "tinymist"), "#!/usr/bin/env sh\nexit 0\n");
			await fs.chmod(path.join(tempDir.path(), "bin", "tinymist"), 0o755);
			Bun.env.PATH = `${path.join(tempDir.path(), "bin")}:${originalPath ?? ""}`;

			const config = lspConfigModule.loadConfig(tempDir.path());

			expect(config.servers.tinymist).toBeUndefined();
			expect(lspConfigModule.getServerForFile(config, path.join(tempDir.path(), "main.typ"))).toBeNull();
		} finally {
			Bun.env.PATH = originalPath;
			tempDir.removeSync();
		}
	});

	it("reports active and configured servers separately in status output", async () => {
		const cwd = `${path.join("/tmp", "lsp-status-test")}-${Date.now()}`;
		vi.spyOn(lspConfigModule, "loadConfig").mockReturnValue({
			servers: {
				tinymist: { command: "tinymist", fileTypes: [".typ"], rootMarkers: [".git"] } as never,
				biome: { command: "biome", fileTypes: [".ts"], rootMarkers: ["package.json"] } as never,
			},
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClientModule, "getActiveClients").mockReturnValue([
			{ name: "tinymist", status: "ready", fileTypes: [".typ"] },
		]);
		vi.spyOn(lspmuxModule, "detectLspmux").mockResolvedValue({
			available: false,
			running: false,
			binaryPath: null,
			config: null,
		} as never);

		const tool = new LspTool(createSession(cwd));
		const result = await tool.execute("status-test", { action: "status" } as never);
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("Active language servers: tinymist");
			expect(text.text).toContain("Configured but not started language servers: biome");
		}
	});

	it("does not call configured servers active when no clients are running", async () => {
		const cwd = `${path.join("/tmp", "lsp-status-empty-test")}-${Date.now()}`;
		vi.spyOn(lspConfigModule, "loadConfig").mockReturnValue({
			servers: {
				tinymist: { command: "tinymist", fileTypes: [".typ"], rootMarkers: [".git"] } as never,
			},
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClientModule, "getActiveClients").mockReturnValue([]);
		vi.spyOn(lspmuxModule, "detectLspmux").mockResolvedValue({
			available: false,
			running: false,
			binaryPath: null,
			config: null,
		} as never);

		const tool = new LspTool(createSession(cwd));
		const result = await tool.execute("status-test", { action: "status" } as never);
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).not.toContain("Active language servers:");
			expect(text.text).toContain("Configured but not started language servers: tinymist");
		}
	});
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}
