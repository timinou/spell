import { describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const require_ = createRequire(import.meta.url);
const nativesDir = path.join(import.meta.dir, "..", "native");
const addonPath = (() => {
	const devPath = path.join(nativesDir, "pi_natives.dev.node");
	if (nodeFs.existsSync(devPath)) return devPath;
	const preferred = nodeFs
		.readdirSync(nativesDir)
		.find(name => name.startsWith("pi_natives.") && name.endsWith(".node") && name !== "pi_natives.dev.node");
	return preferred ? path.join(nativesDir, preferred) : devPath;
})();
const native = require_(addonPath) as {
	executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean };
};

function executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean } {
	return native.executeCodeBuffer(options);
}

async function createRepoTempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(process.cwd(), `${prefix}-`));
}

describe("executeCodeBuffer NAPI bridge", () => {
	it("returns the missing command error envelope", () => {
		expect(executeCodeBuffer({ file: "/tmp/example.ts" })).toEqual({
			error: true,
			output: "GenericFailure, Missing required field: command",
		});
	});

	it("returns supported languages for the languages command without exposing text fallback", () => {
		const result = executeCodeBuffer({
			command: "languages",
		});

		expect(result.error).toBe(false);
		expect(result.output).toEqual({
			languages: expect.arrayContaining([
				expect.objectContaining({ id: "rust", extensions: expect.arrayContaining(["rs"]) }),
				expect.objectContaining({ id: "python", extensions: expect.arrayContaining(["py", "pyi"]) }),
				expect.objectContaining({
					id: "typescript",
					extensions: expect.arrayContaining(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]),
				}),
				expect.objectContaining({ id: "elixir", extensions: expect.arrayContaining(["ex", "exs"]) }),
				expect.objectContaining({ id: "html", extensions: expect.arrayContaining(["html", "htm"]) }),
				expect.objectContaining({ id: "css", extensions: expect.arrayContaining(["css"]) }),
				expect.objectContaining({ id: "typst", extensions: expect.arrayContaining(["typ"]) }),
			]),
		});
		const output = result.output as { languages: Array<{ id: string }> };
		expect(output.languages.map(language => language.id)).not.toContain("text");
	});

	it("creates missing supported files through edit create", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-create-${Date.now()}`);
		const file = path.join(tempDir, "new-module.ts");
		const edit = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const created = 1;\n" }] }],
		});
		expect(edit.error).toBe(false);
		expect(edit.output).toEqual(expect.objectContaining({ created: true, editCount: 1 }));
		const save = executeCodeBuffer({ command: "save", file });
		expect(save.error).toBe(false);
		expect(await Bun.file(file).text()).toBe("export const created = 1;\n");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("opens unknown text extensions in fallback text mode", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-text-open-${Date.now()}`);
		const file = path.join(tempDir, "notes.kdl");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, "line-one\nline-two\n");

		const opened = executeCodeBuffer({ command: "open", file });
		expect(opened.error).toBe(false);
		expect(opened.output).toEqual(
			expect.objectContaining({
				success: true,
				language: "text",
				semanticCapable: false,
				lines: ["line-one", "line-two"],
			}),
		);

		const read = executeCodeBuffer({ command: "read", file, resolution: 3 });
		expect(read).toEqual({ error: false, output: "line-one\nline-two\n" });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("creates unknown text extensions through replace_content and preserves undo redo history", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-text-history-${Date.now()}`);
		const file = path.join(tempDir, "notes.txt");
		await fs.mkdir(tempDir, { recursive: true });

		const replaceResult = executeCodeBuffer({ command: "replace_content", file, content: "alpha\nbeta\n" });
		expect(replaceResult.error).toBe(false);
		expect(replaceResult.output).toEqual(expect.objectContaining({ editCount: 1 }));
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toBe("alpha\nbeta\n");

		const secondReplace = executeCodeBuffer({ command: "replace_content", file, content: "gamma\ndelta\n" });
		expect(secondReplace.error).toBe(false);
		expect(executeCodeBuffer({ command: "undo", file })).toEqual({
			error: false,
			output: expect.arrayContaining([expect.objectContaining({ version: expect.any(Number) })]),
		});
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toBe("alpha\nbeta\n");

		expect(executeCodeBuffer({ command: "redo", file })).toEqual({
			error: false,
			output: expect.arrayContaining([expect.objectContaining({ version: expect.any(Number) })]),
		});
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toBe("gamma\ndelta\n");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("rejects semantic-only commands on fallback text buffers", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-text-outline-${Date.now()}`);
		const file = path.join(tempDir, "notes.toml");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, 'title = "hello"\n');

		const result = executeCodeBuffer({ command: "outline", file });
		expect(result).toEqual({
			error: true,
			output: expect.stringContaining("Semantic structure is unavailable for fallback text buffers"),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("rejects binary files explicitly", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-binary-${Date.now()}`);
		const file = path.join(tempDir, "blob.bin");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, new Uint8Array([0, 1, 2, 3]));

		const result = executeCodeBuffer({ command: "read", file });
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("binary file rejected") }),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("rejects edit create for existing files", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-existing-${Date.now()}`);
		const file = path.join(tempDir, "existing.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, "export const existing = true;\n");
		const result = executeCodeBuffer({
			command: "edit",
			file,
			operation: "create",
			content: "export const created = 1;\n",
		});
		expect(result).toEqual({
			error: true,
			output:
				"GenericFailure, Legacy code edit fields are not accepted for command 'edit': file, operation, content. Use only 'operations' with targetId/action nodes.",
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("replaces the full contents of an existing supported file", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-replace-${Date.now()}`);
		const file = path.join(tempDir, "module.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, "export const original = 1;\n");
		const edit = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const replaced = 2;\n" }] }],
		});
		expect(edit.error).toBe(false);
		expect(edit.output).toEqual(expect.objectContaining({ editCount: 1, created: false }));
		const save = executeCodeBuffer({ command: "save", file });
		expect(save.error).toBe(false);
		expect(await Bun.file(file).text()).toBe("export const replaced = 2;\n");
		await fs.rm(tempDir, { recursive: true, force: true });
	});
	it("replaces callable Typst lets by base binding name", async () => {
		const tempDir = await createRepoTempDir("pi-natives-typst-symbol");
		const file = path.join(tempDir, "report.typ");
		await Bun.write(
			file,
			'#let teal-primary = rgb("#008080")\n#let section-block(num, title) = {\n  [#num --- #title]\n}\n',
		);

		const edit = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: `${file}::section-block`,
					actions: [{ kind: "write", content: "let section-block(num, title) = [patched]\n" }],
				},
			],
		});
		expect(edit.error).toBe(false);
		expect(edit.output).toEqual(expect.objectContaining({ editCount: 1, created: false }));
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toBe(
			'#let teal-primary = rgb("#008080")\n#let section-block(num, title) = [patched]\n\n',
		);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("rejects full-file replace for missing supported files", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-missing-replace-${Date.now()}`);
		const file = path.join(tempDir, "missing.ts");
		await fs.mkdir(tempDir, { recursive: true });
		const result = executeCodeBuffer({
			command: "edit",
			file,
			operation: "replace",
			content: "export const created = 1;\n",
		});
		expect(result).toEqual({
			error: true,
			output: expect.stringContaining("Legacy code edit fields are not accepted"),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses generic html/css rename mutations with proof metadata", async () => {
		const tempDir = await createRepoTempDir("pi-natives-html-rename");
		const file = path.join(tempDir, "index.html");
		await Bun.write(file, '<div id="save"></div>\n');

		const result = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${file}::div#save`, actions: [{ kind: "rename", content: "saveButton" }] }],
		});

		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({
				message: expect.stringContaining("HTML/CSS rename is not yet supported safely"),
				action: "edit",
				proof: expect.objectContaining({ basis: "operation_scope", confidence: "low" }),
			}),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("renames exact html id tokens with proof metadata", async () => {
		const tempDir = await createRepoTempDir("pi-natives-html-id");
		const file = path.join(tempDir, "index.html");
		await Bun.write(file, '<button id="save"></button>\n<label for="save"></label>\n');

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{ targetId: `${file}::button#save`, actions: [{ kind: "renameIdToken", content: "saveButton" }] },
			],
		});

		expect(result.error).toBe(false);
		expect(result.output).toEqual(
			expect.objectContaining({
				created: false,
				targets: [{ targetId: `${file}::button#save`, actions: ["renameIdToken"] }],
				proof: expect.objectContaining({ basis: "file_local_exact_scan", confidence: "high" }),
			}),
		);
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toBe('<button id="saveButton"></button>\n<label for="save"></label>\n');
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses css selector-list class renames with proof metadata", async () => {
		const tempDir = await createRepoTempDir("pi-natives-css-class-refusal");
		const file = path.join(tempDir, "app.css");
		await Bun.write(file, ".btn, .link { color: red; }\n");

		const result = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${file}::.btn, .link`, actions: [{ kind: "renameClassToken", content: "cta" }] }],
		});

		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({
				message: expect.stringContaining("Selector-list rename refused"),
				action: "edit",
				proof: expect.objectContaining({ basis: "selector_list_ambiguity", confidence: "low" }),
			}),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("renames css custom properties with proof metadata", async () => {
		const tempDir = await createRepoTempDir("pi-natives-css-custom-prop");
		const file = path.join(tempDir, "app.css");
		await Bun.write(file, ":root { --accent: red; color: var(--accent); background: var(--accent, blue); }\n");

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{ targetId: `${file}:::root.--accent`, actions: [{ kind: "renameCustomProperty", content: "brand" }] },
			],
		});

		expect(result.error).toBe(false);
		expect(result.output).toEqual(
			expect.objectContaining({
				targets: [{ targetId: `${file}:::root.--accent`, actions: ["renameCustomProperty"] }],
				proof: expect.objectContaining({ basis: "file_local_exact_scan", confidence: "high" }),
			}),
		);
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toContain("--brand: red");
		expect(await Bun.file(file).text()).toContain("var(--brand)");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("removes dead css rules only when graph proof succeeds", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-dead-style-success-"));
		const cssFile = path.join(tempDir, "app.css");
		const htmlFile = path.join(tempDir, "index.html");
		await Bun.write(cssFile, ".unused { color: red; }\n.used { color: blue; }\n");
		await Bun.write(htmlFile, '<link rel="stylesheet" href="./app.css">\n<div class="used"></div>\n');

		const success = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${cssFile}::.unused`, actions: [{ kind: "removeDeadStyle" }] }],
		});
		expect(success.error).toBe(false);
		expect(success.output).toEqual(
			expect.objectContaining({
				targets: [{ targetId: `${cssFile}::.unused`, actions: ["removeDeadStyle"] }],
				proof: expect.objectContaining({ basis: "graph_dead_code" }),
			}),
		);
		expect(executeCodeBuffer({ command: "save", file: cssFile })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(cssFile).text()).not.toContain(".unused");

		const refusal = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${cssFile}::.used`, actions: [{ kind: "removeDeadStyle" }] }],
		});
		expect(refusal).toEqual({
			error: true,
			output: expect.objectContaining({
				message: expect.stringContaining("Dead-style removal refused"),
				action: "edit",
				proof: expect.objectContaining({ basis: "graph_dead_code", confidence: "low" }),
			}),
		});
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("detects native-extension drift", () => {
		const result = executeCodeBuffer({
			command: "languages",
		});

		expect(result.error).toBe(false);
		const output = result.output as { languages: Array<{ id: string }> };
		expect(output.languages.map(language => language.id).sort()).toEqual(
			["css", "elixir", "html", "markdown", "org", "python", "rust", "typst", "typescript"].sort(),
		);
	});

	it("rejects unsafe line-target import insertion before save", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-unsafe-import-${Date.now()}`);
		const file = path.join(tempDir, "main.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, 'import { a } from "./a";\nexport const value = a;\n');

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: file,
					actions: [
						{ kind: "insertAfter", line: 1, nodeType: "import_statement", content: 'import { b } from "./b";' },
					],
				},
			],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("must start with a newline") }),
		});
		expect(await Bun.file(file).text()).toBe('import { a } from "./a";\nexport const value = a;\n');
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("normalizes symbol-target insertBefore like safe line-target insertion", async () => {
		const source = 'export function beta() {\n  return "beta";\n}\n';
		const insert = 'export function alpha() {\n  return "alpha";\n}';
		const tempDir = path.join(os.tmpdir(), `pi-natives-symbol-before-${Date.now()}`);
		const symbolFile = path.join(tempDir, "symbol.ts");
		const lineFile = path.join(tempDir, "line.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(symbolFile, source);
		await Bun.write(lineFile, source);

		const symbolResult = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${symbolFile}::beta`, actions: [{ kind: "insertBefore", content: insert }] }],
		});
		expect(symbolResult.error).toBe(false);
		const lineResult = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: lineFile,
					actions: [{ kind: "insertBefore", line: 1, nodeType: "export_statement", content: `${insert}\n` }],
				},
			],
		});
		expect(lineResult.error).toBe(false);
		expect(executeCodeBuffer({ command: "save", file: symbolFile })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(executeCodeBuffer({ command: "save", file: lineFile })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		const symbolText = await Bun.file(symbolFile).text();
		const lineText = await Bun.file(lineFile).text();
		expect(symbolText).toBe(lineText);
		expect(symbolText).toBe(
			'export function alpha() {\n  return "alpha";\n}\nexport function beta() {\n  return "beta";\n}\n',
		);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("normalizes symbol-target insertAfter like safe line-target insertion", async () => {
		const source =
			'export function alpha() {\n  return "alpha";\n}\nexport function gamma() {\n  return "gamma";\n}\n';
		const insert = 'export function beta() {\n  return "beta";\n}';
		const tempDir = path.join(os.tmpdir(), `pi-natives-symbol-after-${Date.now()}`);
		const symbolFile = path.join(tempDir, "symbol.ts");
		const lineFile = path.join(tempDir, "line.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(symbolFile, source);
		await Bun.write(lineFile, source);

		const symbolResult = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: `${symbolFile}::alpha`, actions: [{ kind: "insertAfter", content: insert }] }],
		});
		expect(symbolResult.error).toBe(false);
		const lineResult = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: lineFile,
					actions: [{ kind: "insertAfter", line: 1, nodeType: "export_statement", content: `\n${insert}` }],
				},
			],
		});
		expect(lineResult.error).toBe(false);
		expect(executeCodeBuffer({ command: "save", file: symbolFile })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(executeCodeBuffer({ command: "save", file: lineFile })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		const symbolText = await Bun.file(symbolFile).text();
		const lineText = await Bun.file(lineFile).text();
		expect(symbolText).toBe(lineText);
		expect(symbolText).toBe(
			'export function alpha() {\n  return "alpha";\n}\nexport function beta() {\n  return "beta";\n}\nexport function gamma() {\n  return "gamma";\n}\n',
		);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses shared-boundary symbol-target insertion without mutating the file", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-symbol-shared-boundary-${Date.now()}`);
		const file = path.join(tempDir, "inline.ts");
		const source = "class Foo { bar() { return 1; } baz() { return 2; } }\n";
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, source);

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{ targetId: `${file}::Foo.bar`, actions: [{ kind: "insertAfter", content: "qux() { return 3; }" }] },
			],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("Unsafe symbol-target insert-after") }),
		});
		expect(await Bun.file(file).text()).toBe(source);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("rejects structurally invalid supported-file edits before save", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-invalid-structure-${Date.now()}`);
		const file = path.join(tempDir, "module.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, "export const value = 1;\n");

		const result = executeCodeBuffer({
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const = ;\n" }] }],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("structurally invalid") }),
		});
		expect(await Bun.file(file).text()).toBe("export const value = 1;\n");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("requires occurrence for duplicate scoped findAndReplace matches", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-occurrence-ambiguous-${Date.now()}`);
		const file = path.join(tempDir, "main.ts");
		const source = "export function main() {\n  const value = 1;\n  const value = 1;\n  return value;\n}\n";
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, source);

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: `${file}::main`,
					actions: [{ kind: "findAndReplace", find: "const value = 1;", content: "const picked = 2;" }],
				},
			],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("multiple matches; pass occurrence") }),
		});
		expect(await Bun.file(file).text()).toBe(source);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("applies public occurrence selectors for scoped findAndReplace", async () => {
		const source =
			"export function main() {\n  const value = 1;\n  const value = 1;\n  const value = 1;\n  return value;\n}\n";
		const cases = [
			{
				label: "first",
				occurrence: "first",
				expected:
					"export function main() {\n  const picked = 2;\n  const value = 1;\n  const value = 1;\n  return value;\n}\n",
			},
			{
				label: "last",
				occurrence: "last",
				expected:
					"export function main() {\n  const value = 1;\n  const value = 1;\n  const picked = 2;\n  return value;\n}\n",
			},
			{
				label: "second",
				occurrence: 2,
				expected:
					"export function main() {\n  const value = 1;\n  const picked = 2;\n  const value = 1;\n  return value;\n}\n",
			},
			{
				label: "all",
				occurrence: "all",
				expected:
					"export function main() {\n  const picked = 2;\n  const picked = 2;\n  const picked = 2;\n  return value;\n}\n",
			},
		] satisfies Array<{ label: string; occurrence: "first" | "last" | "all" | number; expected: string }>;

		for (const testCase of cases) {
			const tempDir = path.join(os.tmpdir(), `pi-natives-occurrence-${testCase.label}-${Date.now()}`);
			const file = path.join(tempDir, "main.ts");
			await fs.mkdir(tempDir, { recursive: true });
			await Bun.write(file, source);

			const result = executeCodeBuffer({
				command: "edit",
				operations: [
					{
						targetId: `${file}::main`,
						actions: [
							{
								kind: "findAndReplace",
								find: "const value = 1;",
								content: "const picked = 2;",
								occurrence: testCase.occurrence,
							},
						],
					},
				],
			});
			expect(result.error).toBe(false);
			expect(executeCodeBuffer({ command: "save", file })).toEqual({
				error: false,
				output: expect.objectContaining({ success: true }),
			});
			expect(await Bun.file(file).text()).toBe(testCase.expected);
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects out-of-range scoped findAndReplace occurrence", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-occurrence-range-${Date.now()}`);
		const file = path.join(tempDir, "main.ts");
		const source =
			"export function main() {\n  const value = 1;\n  const value = 1;\n  const value = 1;\n  return value;\n}\n";
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, source);

		const result = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: `${file}::main`,
					actions: [
						{ kind: "findAndReplace", find: "const value = 1;", content: "const picked = 2;", occurrence: 5 },
					],
				},
			],
		});
		expect(result).toEqual({
			error: true,
			output: expect.objectContaining({ message: expect.stringContaining("occurrence 5 out of range 1..=3") }),
		});
		expect(await Bun.file(file).text()).toBe(source);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("keeps failed batch edits atomic for follow-up edits", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-batch-atomic-${Date.now()}`);
		const file = path.join(tempDir, "main.ts");
		await fs.mkdir(tempDir, { recursive: true });
		await Bun.write(file, "export function main() {\n  return oldCall();\n}\n");

		const failed = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: `${file}::main`,
					actions: [{ kind: "findAndReplace", find: "return oldCall();", content: "return newCall();" }],
					children: [
						{
							targetId: `${file}::missing`,
							actions: [
								{ kind: "findAndReplace", find: "return oldCall();", content: "return shouldNotApply();" },
							],
						},
					],
				},
			],
		});
		expect(failed.error).toBe(true);

		const followUp = executeCodeBuffer({
			command: "edit",
			operations: [
				{
					targetId: `${file}::main`,
					actions: [{ kind: "findAndReplace", find: "return oldCall();", content: "return finalCall();" }],
				},
			],
		});
		expect(followUp.error).toBe(false);
		expect(executeCodeBuffer({ command: "save", file })).toEqual({
			error: false,
			output: expect.objectContaining({ success: true }),
		});
		expect(await Bun.file(file).text()).toContain("return finalCall();");
		await fs.rm(tempDir, { recursive: true, force: true });
	});
});
