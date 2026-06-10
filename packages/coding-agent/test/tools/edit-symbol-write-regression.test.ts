import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodepathEditTool } from "../../src/tools/edit";

describe("PLAN-304 regression — canonical Op surface for symbol-target writes", () => {
	test("replace verb on a symbol target is accepted by the tool schema", async () => {
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
						kind: "replace",
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
	test("replace verb with find on a file target is accepted by the tool schema", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bug-fnr-new-"));
		const file = path.join(dir, "f.ts");
		await fs.writeFile(file, "const oldName = 1;\n", "utf-8");
		const session: any = { cwd: dir, sandboxPolicy: null };
		const tool = new CodepathEditTool(session);

		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", find: "oldName", content: "newName" },
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
