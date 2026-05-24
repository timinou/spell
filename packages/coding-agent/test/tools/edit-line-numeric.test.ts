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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
	it("lineReplace accepts {start, end} as numbers", async () => {
		const file = await write("a.txt", "one\ntwo\nthree\nfour\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: 2, end: 3 }, content: ["TWO", "THREE"] },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nTHREE\nfour\n");
	});

	it("lineReplace accepts {start} as a single-line number", async () => {
		const file = await write("b.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: 2 }, content: "TWO" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nthree\n");
	});

	it("lineInsert accepts {side, line} numeric", async () => {
		const file = await write("c.txt", "one\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineInsert", at: { side: "after", line: 1 }, content: "two" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nthree\n");
	});

	it("lineAppend accepts a bare numeric anchor", async () => {
		const file = await write("d.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineAppend", at: 2, content: "TWO-EXTRA" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nTWO-EXTRA\nthree\n");
	});

	it("linePrepend accepts a bare numeric anchor", async () => {
		const file = await write("e.txt", "one\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "linePrepend", at: 2, content: "two" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(file, "utf-8")).toBe("one\ntwo\nthree\n");
	});

	it("rejects string-shaped LINE#HASH anchors (post-removal)", async () => {
		const file = await write("f.txt", "one\ntwo\nthree\n");
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineReplace", span: { start: "2#XX" } as any, content: "TWO" },
				},
			],
		});
		expect((result as any).isError).toBe(true);
		// helpful message naming the expected numeric shape
		expect(getText(result)).toMatch(/number|integer|u32|line/i);
	});
});
