import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const require_ = createRequire(import.meta.url);
const nativesDir = path.join(import.meta.dir, "..", "native");
const native = require_(path.join(nativesDir, "pi_natives.dev.node")) as {
	executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean };
};

function executeCodeBuffer(options: Record<string, unknown>): { output: unknown; error: boolean } {
	return native.executeCodeBuffer(options);
}

describe("executeCodeBuffer NAPI bridge", () => {
	it("returns the unsupported language error envelope", () => {
		expect(
			executeCodeBuffer({
				command: "read",
				file: "/tmp/example.go",
			}),
		).toEqual({
			error: true,
			output: expect.stringMatching(/No such file or directory/),
		});
	});

	it("returns the missing command error envelope", () => {
		expect(executeCodeBuffer({ file: "/tmp/example.ts" })).toEqual({
			error: true,
			output: "GenericFailure, Missing required field: command",
		});
	});

	it("returns supported languages for the languages command", () => {
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
				expect.objectContaining({ id: "typst", extensions: expect.arrayContaining(["typ"]) }),
			]),
		});
	});

	it("creates missing supported files through edit create", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-natives-create-${Date.now()}`);
		const file = path.join(tempDir, "new-module.ts");
		const edit = executeCodeBuffer({
			command: "edit",
			file,
			operation: "create",
			content: "export const created = 1;\n",
		});
		expect(edit.error).toBe(false);
		expect(edit.output).toEqual(expect.objectContaining({ created: true, editCount: 1 }));
		const save = executeCodeBuffer({ command: "save", file });
		expect(save.error).toBe(false);
		expect(await Bun.file(file).text()).toBe("export const created = 1;\n");
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
			output: `GenericFailure, operation 'create' only works for missing files. ${file} already exists; use 'replace' or 'replace-body' instead.`,
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
			file,
			operation: "replace",
			content: "export const replaced = 2;\n",
		});
		expect(edit.error).toBe(false);
		expect(edit.output).toEqual(expect.objectContaining({ editCount: 1, created: false }));
		const save = executeCodeBuffer({ command: "save", file });
		expect(save.error).toBe(false);
		expect(await Bun.file(file).text()).toBe("export const replaced = 2;\n");
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
			output: expect.stringContaining("No such file or directory"),
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
			["elixir", "markdown", "org", "python", "rust", "typst", "typescript"].sort(),
		);
	});
});
