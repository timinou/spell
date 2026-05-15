import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodepathEditTool } from "../../src/tools/edit";

describe("PLAN-304 regression — original 'no resolver supports action Write' bug", () => {
	test("legacy kind:'write' on symbol target no longer returns 'no resolver supports'", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p304-"));
		const file = path.join(dir, "transcript.ts");
		await fs.writeFile(
			file,
			"export function renderSessionMarkdown() { return 'old'; }\nexport function helper() { return 1; }\n",
			"utf-8",
		);
		const session: any = { cwd: dir, sandboxPolicy: null };
		const tool = new CodepathEditTool(session);

		const result = await tool.execute("t", {
			operations: [
				{
					target: `${file}::renderSessionMarkdown`,
					action: {
						kind: "write",
						content: "export function renderSessionMarkdown() { return 'new'; }",
					},
				},
			],
		});

		const text =
			(result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") as string) || "";

		// The defining symptom of the original bug: the literal string
		// "no resolver supports action Write" appearing in the tool result.
		// With PLAN-304 fixes, that message is impossible — the adapter
		// (or kernel Op::from_legacy) routes the call to symbolReplace
		// and the kernel either applies it or fails with a different,
		// structured diagnostic.
		expect(text).not.toContain("no resolver supports");
	});

	test("new shape kind:'symbolReplace' is accepted by the tool schema", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p304-new-"));
		const file = path.join(dir, "f.ts");
		await fs.writeFile(file, "export function foo() { return 1; }\n", "utf-8");
		const session: any = { cwd: dir, sandboxPolicy: null };
		const tool = new CodepathEditTool(session);

		const result = await tool.execute("t", {
			operations: [
				{
					target: `${file}::foo`,
					action: {
						kind: "symbolReplace",
						content: "export function foo() { return 9; }",
					},
				},
			],
		});

		const text =
			(result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") as string) || "";
		// Schema accepts the new kind: even if structural application has
		// an issue, the result is NOT a schema rejection or "no resolver"
		// catch-all. It is at worst a structured kernel diagnostic.
		expect(text).not.toContain("no resolver supports");
		expect(text).not.toContain("not a valid");
	});
});

// BUG (session 2026-05-13): legacy `findAndReplace` on a bare file path
// (no `::Symbol`) returned "no resolver supports action FindAndReplace".
// The PLAN-300 wave-3 fix routes the Action to `Op::FileFindReplace` and the
// schema layer now exposes the same capability via the new `fileFindReplace`
// kind. Both spellings must reach the kernel without schema rejection.
describe("BUG-2026-05-13 — findAndReplace on bare file path", () => {
	test("legacy kind:'findAndReplace' + bare file target does not surface 'no resolver supports'", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bug-fnr-legacy-"));
		const file = path.join(dir, "f.ts");
		await fs.writeFile(file, "const oldName = 1;\nconst other = 2;\n", "utf-8");
		const session: any = { cwd: dir, sandboxPolicy: null };
		const tool = new CodepathEditTool(session);

		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "findAndReplace", find: "oldName", content: "newName" },
				},
			],
		});

		const text =
			(result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") as string) || "";
		expect(text).not.toContain("no resolver supports");
	});

	test("new kind:'fileFindReplace' is accepted by the tool schema", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bug-fnr-new-"));
		const file = path.join(dir, "f.ts");
		await fs.writeFile(file, "const oldName = 1;\n", "utf-8");
		const session: any = { cwd: dir, sandboxPolicy: null };
		const tool = new CodepathEditTool(session);

		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "fileFindReplace", find: "oldName", content: "newName" },
				},
			],
		});

		const text =
			(result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") as string) || "";
		expect(text).not.toContain("no resolver supports");
		expect(text).not.toContain("not a valid");
	});
});
