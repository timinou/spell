import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
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
		expect(() =>
			executeCodeBuffer({
				command: "read",
				file: "/tmp/example.go",
			}),
		).toThrow(/No such file or directory/);
	});

	it("returns the missing command error envelope", () => {
		expect(() => executeCodeBuffer({ file: "/tmp/example.ts" })).toThrow(/Missing required field: command/);
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

	it("detects native-extension drift", () => {
		const result = executeCodeBuffer({
			command: "languages",
		});

		expect(result.error).toBe(false);
		const output = result.output as { languages: Array<{ id: string }> };
		expect(output.languages.map(language => language.id).sort()).toEqual(
			["elixir", "python", "rust", "typst", "typescript"].sort(),
		);
	});
});
