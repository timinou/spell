/**
 * BUG-466 — non-array `operations` must not crash with a raw TypeError.
 *
 * When the model stringifies the `operations` payload (common for Elixir
 * `do…end` bodies whose escaping breaks JSON coercion in
 * validateToolArguments), `lenientArgValidation` hands the raw string straight
 * to `execute`. Before the guard this hit `params.operations.some is not a
 * function`. It must now return an actionable isError tool result.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@spell/pi-coding-agent/tools";

let cwd: string;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "edit-malformed-ops-"));
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

describe("edit non-array operations — BUG-466", () => {
	it("stringified operations array returns malformed_operations, not a TypeError", async () => {
		const tool = new CodepathEditTool(makeSession());
		// Simulate lenientArgValidation handing through the raw, unparsed string.
		const result = await tool.execute("t", {
			operations: '[{"target":"a.ex::Foo.bar#body","action":{"kind":"replace","content":"do\\n  x\\nend"}}]',
		} as any);

		expect((result as any).isError).toBe(true);
		const text = getText(result);
		expect(text).toMatch(/must be a JSON array/i);
		expect(text).not.toMatch(/is not a function/i);
	});

	it("undefined operations does not throw a raw TypeError", async () => {
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {} as any);

		expect((result as any).isError).toBe(true);
		expect(getText(result)).toMatch(/must be a JSON array/i);
	});
});
