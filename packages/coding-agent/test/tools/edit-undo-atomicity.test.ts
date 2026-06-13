/**
 * Undo-atomicity (session 1506a660 post-mortem).
 *
 * Two failure modes were observed in production and are guarded here end-to-end
 * through the live `CodepathEditTool` + native edit-history:
 *
 *  A. The `undo` op's `target` was discarded (hardcoded `target: ""` in the
 *     manage bridge), so undo silently reverted "the most recent edit in the
 *     session-cwd's workspace shard" — a DIFFERENT file than the one named.
 *     Fix: the op's `target` now scopes the revert.
 *
 *  B. A multi-file edit (e.g. a cross-file rename) recorded N history entries
 *     with no shared identity, so a single undo reverted only ONE file, leaving
 *     the operation half-undone. Fix: every edit in one `edit` invocation shares
 *     an `editGroupId`; undo/redo revert the whole group atomically.
 *
 * These tests drive the real tool against a temp workspace (with a `.spell`
 * marker so the edit-history log resolves) and assert on-disk state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@spell/pi-coding-agent/tools";

let ws: string;

beforeEach(async () => {
	ws = await fs.mkdtemp(path.join(os.tmpdir(), "edit-undo-"));
	// `.spell` marks the workspace root so the kernel resolves the edit-history
	// log here (and the undo handler finds the same log the edits wrote to).
	await fs.mkdir(path.join(ws, ".spell"), { recursive: true });
});

afterEach(async () => {
	if (ws) await fs.rm(ws, { recursive: true, force: true });
});

function makeSession(sessionId: string): ToolSession {
	return {
		cwd: ws,
		sandboxPolicy: undefined,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => sessionId,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("edit undo-atomicity", () => {
	it("undo honours the op target — reverts the NAMED file, not the most-recent (fix A)", async () => {
		const tool = new CodepathEditTool(makeSession("S-A"));
		await fs.writeFile(path.join(ws, "a.ts"), "const a = 1;\n", "utf-8");
		await fs.writeFile(path.join(ws, "b.ts"), "const b = 1;\n", "utf-8");

		// Edit `a` first, then `b` (b is most-recent).
		await tool.execute("t1", {
			operations: [{ target: "a.ts", action: { kind: "replace", find: "1", content: "111" } }],
		});
		await tool.execute("t2", {
			operations: [{ target: "b.ts", action: { kind: "replace", find: "1", content: "222" } }],
		});
		expect(await fs.readFile(path.join(ws, "a.ts"), "utf-8")).toBe("const a = 111;\n");
		expect(await fs.readFile(path.join(ws, "b.ts"), "utf-8")).toBe("const b = 222;\n");

		// Undo TARGETING a.ts must revert a.ts, leaving the most-recent b.ts alone.
		const undo = await tool.execute("t3", {
			operations: [{ target: "a.ts", action: { kind: "undo" } }],
		});
		expect((undo as any).isError ?? false).toBe(false);
		expect(await fs.readFile(path.join(ws, "a.ts"), "utf-8")).toBe("const a = 1;\n");
		expect(await fs.readFile(path.join(ws, "b.ts"), "utf-8")).toBe("const b = 222;\n");
	});

	it("undo reverts a whole multi-file group atomically; redo re-applies it (fix B)", async () => {
		const tool = new CodepathEditTool(makeSession("S-B"));
		await fs.writeFile(path.join(ws, "x.ts"), "use oldName;\n", "utf-8");
		await fs.writeFile(path.join(ws, "y.ts"), "call(oldName);\n", "utf-8");

		// One logical edit invocation touching TWO files → one group.
		const edit = await tool.execute("t1", {
			operations: [
				{ target: "x.ts", action: { kind: "replace", find: "oldName", content: "newName" } },
				{ target: "y.ts", action: { kind: "replace", find: "oldName", content: "newName" } },
			],
		});
		expect((edit as any).isError ?? false).toBe(false);
		expect(await fs.readFile(path.join(ws, "x.ts"), "utf-8")).toBe("use newName;\n");
		expect(await fs.readFile(path.join(ws, "y.ts"), "utf-8")).toBe("call(newName);\n");

		// A single undo (target one member) reverts BOTH.
		const undo = await tool.execute("t2", {
			operations: [{ target: "x.ts", action: { kind: "undo" } }],
		});
		expect((undo as any).isError ?? false).toBe(false);
		expect(await fs.readFile(path.join(ws, "x.ts"), "utf-8")).toBe("use oldName;\n");
		expect(await fs.readFile(path.join(ws, "y.ts"), "utf-8")).toBe("call(oldName);\n");

		// A single redo re-applies BOTH.
		const redo = await tool.execute("t3", {
			operations: [{ target: "x.ts", action: { kind: "redo" } }],
		});
		expect((redo as any).isError ?? false).toBe(false);
		expect(await fs.readFile(path.join(ws, "x.ts"), "utf-8")).toBe("use newName;\n");
		expect(await fs.readFile(path.join(ws, "y.ts"), "utf-8")).toBe("call(newName);\n");
	});

	it("history op may not be batched with regular edits", async () => {
		const tool = new CodepathEditTool(makeSession("S-C"));
		await fs.writeFile(path.join(ws, "a.ts"), "const a = 1;\n", "utf-8");
		const res = await tool.execute("t1", {
			operations: [
				{ target: "a.ts", action: { kind: "replace", find: "1", content: "2" } },
				{ target: "a.ts", action: { kind: "undo" } },
			],
		});
		expect((res as any).isError).toBe(true);
	});
});
