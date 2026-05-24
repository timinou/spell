/**
 * BUG-403 / PLAN-317 W0 — red test
 *
 * Mutating edit ops against a missing file should fail fast with a
 * clear "file_not_found" diagnostic, not the misleading
 * "find text not found in scope. Scope preview:" empty error.
 *
 * Today: kernel creates an empty buffer for the missing file, then
 * apply_patches reports an empty-scope match failure. Agents
 * misinterpret as a stale `find` string and waste tokens.
 *
 * This test MUST FAIL today.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

let cwd: string;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "edit-preflight-"));
});
afterAll(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

function makeSession(): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function getText(r: any): string {
	return r.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("edit pre-flight existence — BUG-403", () => {
	it("fileFindReplace on missing file returns file_not_found, not empty scope preview", async () => {
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: "does-not-exist.ts",
					action: { kind: "fileFindReplace", find: "X", content: "Y" },
				},
			],
		});

		expect((result as any).isError).toBe(true);
		const text = getText(result);
		// Must mention the file path and "not found"
		expect(text).toMatch(/not found|file_not_found|does not exist/i);
		expect(text).toContain("does-not-exist.ts");
		// Must NOT degrade into the misleading scope-preview message
		expect(text).not.toMatch(/Scope preview:\s*$/m);
		expect(text).not.toMatch(/find text not found in scope/);
	});

	it("symbolReplace on missing file returns file_not_found", async () => {
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: "missing.ts::Foo",
					action: { kind: "symbolReplace", content: "function Foo() {}" },
				},
			],
		});
		expect((result as any).isError).toBe(true);
		const text = getText(result);
		expect(text).toMatch(/not found|file_not_found/i);
		expect(text).toContain("missing.ts");
	});

	it("fileCreate on missing file SUCCEEDS (must not be blocked)", async () => {
		const file = path.join(cwd, "fresh.ts");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileCreate", content: "hello" } }],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("hello");
	});

	it("anchorless fileAppend on missing file SUCCEEDS (creates the file)", async () => {
		const file = path.join(cwd, "appended.ts");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [{ target: file, action: { kind: "fileAppend", content: "data" } }],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toContain("data");
	});
});
