/**
 * BUG-404 / PLAN-317 W0 — red test
 *
 * lineReplace / lineInsert / lineAppend / linePrepend should accept
 * plain 1-indexed line numbers (the shape agents naturally write),
 * not LINE#HASH base32 anchor strings.
 *
 * Today: schema (lineSpanSchema/lineAnchorSchema/lineAtSchema) requires
 * "^\\d+#.+$" string anchors; 86% of lineReplace calls in the corpus
 * fail with "replace requires at least one anchor (pos or end)".
 *
 * This test MUST FAIL today (schema rejects bare numbers).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@spell/pi-coding-agent/tools";

let cwd: string;
beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "edit-line-num-"));
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

async function write(name: string, body: string): Promise<string> {
	const p = path.join(cwd, name);
	await fs.writeFile(p, body, "utf-8");
	return p;
}

describe("numeric line addressing — BUG-404", () => {
	it("replace on a line-range target accepts numeric start-end", async () => {
		const file = await write("a.txt", "one\ntwo\nthree\nfour\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: `${file}:2-3`,
					action: { kind: "replace", content: ["TWO", "THREE"] },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nTHREE\nfour\n");
	});

	it("replace on a single-line target", async () => {
		const file = await write("b.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: `${file}:2-2`,
					action: { kind: "replace", content: "TWO" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nthree\n");
	});

	it("replace place:after with numeric `at` inserts after a line", async () => {
		const file = await write("c.txt", "one\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", place: "after", at: 1, content: "two" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nthree\n");
	});

	it("replace place:after appends after the anchor line", async () => {
		const file = await write("d.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", place: "after", at: 2, content: "TWO-EXTRA" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nTWO-EXTRA\nthree\n");
	});

	it("replace place:before inserts before the anchor line", async () => {
		const file = await write("e.txt", "one\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", place: "before", at: 2, content: "two" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nthree\n");
	});

	it("replace place:before|after requires `at` on a file target", async () => {
		const file = await write("f.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "replace", place: "after", content: "TWO" },
				},
			],
		});
		expect((result as any).isError).toBe(true);
		expect(getText(result)).toMatch(/at|line|requires/i);
	});
});
