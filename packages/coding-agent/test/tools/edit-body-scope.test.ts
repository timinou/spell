import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@spell/pi-coding-agent/tools";

/**
 * Regression: `symbolReplace { scope: "body" }` / `#body` must replace exactly
 * the declaration's body span — including block delimiters — and never write
 * syntactically invalid output.
 *
 * Origin: a body replace on an Elixir `def … do … end` dropped the `do`
 * keyword and spliced the body inline (`def f(args)  {_ast,…} =`), orphaning
 * the trailing `end` and emitting a SyntaxError. Root causes:
 *  1. the `scope` field was silently dropped by the CodePath mutation
 *     resolver, degrading every body replace to a whole-declaration replace;
 *  2. the post-edit parse gate scoped its validity check to the edit
 *     neighbourhood, letting tree-sitter-relocated errors slip through.
 *
 * Decision A (delimiter-inclusive): body content carries `{ … }` / `do … end`.
 */

let tmpDir: string;

function makeTool(): CodepathEditTool {
	const session: ToolSession = {
		cwd: tmpDir,
		sandboxPolicy: undefined,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	return new CodepathEditTool(session);
}

function isError(r: unknown): boolean {
	return Boolean((r as { isError?: boolean }).isError);
}

// biome-ignore lint/suspicious/noExplicitAny: action union is wide; tests pass shaped literals
async function exec(tool: CodepathEditTool, target: string, action: any) {
	return tool.execute("t", { operations: [{ target, action }] });
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "body-scope-"));
});

afterEach(async () => {
	if (tmpDir) {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {}
	}
});

describe("edit body-scope — delimiter-inclusive, parse-gated", () => {
	test("elixir def do/end body replace keeps signature + delimiters", async () => {
		const file = path.join(tmpDir, "rename.ex");
		await fs.writeFile(
			file,
			`defmodule Drive.RenameWhatsAppError do
  def fix_patches(ast, _opts) do
    {_ast, patches} =
      Macro.prewalk(ast, [], fn node, acc ->
        {node, acc}
      end)

    Enum.reverse(patches)
  end
end
`,
		);
		const tool = makeTool();
		const r = await exec(tool, `${file}::Drive.RenameWhatsAppError.fix_patches`, {
			kind: "symbolReplace",
			scope: "body",
			content: "do\n    result = compute(ast)\n    Enum.reverse(result)\n  end",
		});
		expect(isError(r)).toBeFalsy();
		const out = await fs.readFile(file, "utf-8");
		// header keyword + closing delimiter preserved, body swapped
		expect(out).toContain("def fix_patches(ast, _opts) do");
		expect(out).toContain("result = compute(ast)");
		expect(out).not.toContain("Macro.prewalk");
		expect(out).toContain("  end\nend");
	});

	test("ts function body replace keeps signature", async () => {
		const file = path.join(tmpDir, "a.ts");
		await fs.writeFile(file, "export function foo(x) {\n  return x + 1;\n}\n");
		const tool = makeTool();
		const r = await exec(tool, `${file}::foo`, {
			kind: "symbolReplace",
			scope: "body",
			content: "{\n  return x * 2;\n}",
		});
		expect(isError(r)).toBeFalsy();
		const out = await fs.readFile(file, "utf-8");
		expect(out).toContain("export function foo(x)");
		expect(out).toContain("return x * 2");
	});

	test("#body qualifier surface is equivalent to scope field", async () => {
		const file = path.join(tmpDir, "b.ts");
		await fs.writeFile(file, "export function foo(x) {\n  return x + 1;\n}\n");
		const tool = makeTool();
		const r = await exec(tool, `${file}::foo#body`, {
			kind: "symbolReplace",
			content: "{\n  return 7;\n}",
		});
		expect(isError(r)).toBeFalsy();
		const out = await fs.readFile(file, "utf-8");
		expect(out).toContain("export function foo(x)");
		expect(out).toContain("return 7");
	});

	test("braceless body content is rejected and the file is left untouched", async () => {
		const file = path.join(tmpDir, "c.ts");
		const original = "export function foo(x) {\n  return x + 1;\n}\n";
		await fs.writeFile(file, original);
		const tool = makeTool();
		const r = await exec(tool, `${file}::foo`, {
			kind: "symbolReplace",
			scope: "body",
			content: "return x * 99;",
		});
		expect(isError(r)).toBeTruthy();
		// must NOT corrupt the file
		expect(await fs.readFile(file, "utf-8")).toBe(original);
	});
});
