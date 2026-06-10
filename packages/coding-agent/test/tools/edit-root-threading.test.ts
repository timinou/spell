/**
 * BUG-401 / PLAN-317 W0 — red test
 *
 * The `edit` tool advertises a `root` parameter in its schema
 * (editSchema.root in codepath-types.ts). Today it is silently ignored:
 * targets resolve against `session.cwd` regardless of params.root.
 *
 * Repro:
 *   edit { root: "/tmp/X", operations: [{ target: "rel.ts", ... }] }
 *   → resolves rel.ts under session.cwd, not /tmp/X
 *   → buffer empty → "find text not found in scope. Scope preview:" empty
 *
 * This test asserts the *intended* behaviour. It MUST FAIL today.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { CodepathEditTool, type ToolSession } from "@spell/pi-coding-agent/tools";

let rootDir: string;
let sessionCwd: string;

beforeAll(async () => {
	rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-root-"));
	sessionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "edit-cwd-"));
	await fs.writeFile(path.join(rootDir, "rel.ts"), "alpha\nbeta\ngamma\n", "utf-8");
});

afterAll(async () => {
	await fs.rm(rootDir, { recursive: true, force: true });
	await fs.rm(sessionCwd, { recursive: true, force: true });
});

function makeSession(): ToolSession {
	return {
		cwd: sessionCwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("edit({ root }) — BUG-401", () => {
	it("resolves relative target against params.root, not session.cwd", async () => {
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			root: rootDir,
			operations: [
				{
					target: "rel.ts",
					action: { kind: "replace", find: "beta", content: "delta" },
				},
			],
		});

		// Must not be an error
		expect((result as any).isError ?? false).toBe(false);

		// File at rootDir/rel.ts must have changed
		const after = await fs.readFile(path.join(rootDir, "rel.ts"), "utf-8");
		expect(after).toBe("alpha\ndelta\ngamma\n");

		// A wrong-path side effect (session.cwd/rel.ts) must NOT exist
		expect(await fs.exists(path.join(sessionCwd, "rel.ts"))).toBe(false);
	});

	it("resolves a relative params.root against session.cwd", async () => {
		// When params.root is a relative path, it must resolve from session.cwd.
		const sub = await fs.mkdtemp(path.join(sessionCwd, "sub-"));
		await fs.writeFile(path.join(sub, "hello.ts"), "world\n", "utf-8");
		const relRoot = path.relative(sessionCwd, sub);
		const tool = new CodepathEditTool(makeSession());
		const result = await tool.execute("t", {
			root: relRoot,
			operations: [
				{
					target: "hello.ts",
					action: { kind: "replace", find: "world", content: "REPLACED" },
				},
			],
		});
		expect((result as any).isError ?? false).toBe(false);
		expect(await fs.readFile(path.join(sub, "hello.ts"), "utf-8")).toBe("REPLACED\n");
	});
});
