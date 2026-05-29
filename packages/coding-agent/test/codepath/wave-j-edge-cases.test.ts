/**
 * Wave J — edge-case coverage.
 *
 * Cover every documented corner of the canonical edit surface:
 *   - empty / large / non-existent content
 *   - fileCreate force semantics
 *   - fileDelete on existent + missing
 *   - transaction:strict atomicity (single + cross file)
 *   - symbolReplace scope:body diagnostic (Wave H3 regression)
 *   - lineInsert with at:{side,anchor} shape
 *   - path-traversal sandbox rejection
 *
 * Tests use the canonical surfaces only (executeCodePath + CodepathEditTool).
 * No legacy adapter, no removed Op::from_legacy paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeLineHash } from "@oh-my-pi/pi-coding-agent/patch";
import { CodepathEditTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

function makeSession(tmpDir: string, sandboxPolicy?: ToolSession["sandboxPolicy"]): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sandboxPolicy,
	};
}

function getText(result: AgentToolResult): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => (c as { text?: string }).text ?? "")
		.join("\n");
}

async function runRaw(tmpDir: string, target: string, action: any): Promise<{ diags: any[]; chunks: any[] }> {
	const chunks = await executeCodePath({
		command: "edit",
		target,
		root: tmpDir,
		actions: [action],
		sessionId: "S-edge",
	});
	return { chunks, diags: chunks.flatMap(c => c.diagnostics) };
}

describe("Wave J: edge cases", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-j-edge-"));
		await fs.mkdir(path.join(tmpDir, ".spell"), { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("fileWrite with empty content yields an empty file (not deletion)", async () => {
		const file = path.join(tmpDir, "empty.txt");
		await fs.writeFile(file, "stale\n");

		const { diags } = await runRaw(tmpDir, "empty.txt", { kind: "fileWrite", content: "" });
		expect(diags.length).toBe(0);
		expect(await fs.readFile(file, "utf-8")).toBe("");
		const stat = await fs.stat(file);
		expect(stat.isFile()).toBe(true);
	});

	it("fileWrite preserves explicit trailing newline in multiline content", async () => {
		const file = path.join(tmpDir, "multi.txt");
		await fs.writeFile(file, "x\n");

		const body = "line1\nline2\nline3\n";
		const { diags } = await runRaw(tmpDir, "multi.txt", { kind: "fileWrite", content: body });
		expect(diags.length).toBe(0);
		expect(await fs.readFile(file, "utf-8")).toBe(body);
	});

	it("fileCreate refuses to overwrite an existing file without force", async () => {
		const file = path.join(tmpDir, "exists.txt");
		await fs.writeFile(file, "old\n");

		const { diags } = await runRaw(tmpDir, "exists.txt", { kind: "fileCreate", content: "new\n" });
		expect(diags.length).toBeGreaterThan(0);
		expect(await fs.readFile(file, "utf-8")).toBe("old\n");
	});

	it("fileCreate with force:true overwrites an existing file", async () => {
		const file = path.join(tmpDir, "force.txt");
		await fs.writeFile(file, "old\n");

		const { diags } = await runRaw(tmpDir, "force.txt", { kind: "fileCreate", content: "new\n", force: true });
		expect(diags.length).toBe(0);
		expect(await fs.readFile(file, "utf-8")).toBe("new\n");
	});

	it("fileDelete on existing file removes it", async () => {
		const file = path.join(tmpDir, "doomed.txt");
		await fs.writeFile(file, "bye\n");

		const { diags } = await runRaw(tmpDir, "doomed.txt", { kind: "fileDelete" });
		expect(diags.length).toBe(0);
		expect(await fs.exists(file)).toBe(false);
	});

	it("fileDelete on a nonexistent file returns a clean diagnostic (no panic)", async () => {
		const { chunks, diags } = await runRaw(tmpDir, "ghost.txt", { kind: "fileDelete" });
		// Either a diagnostic OR a benign no-op result — both are acceptable as long
		// as the kernel doesn't crash and we still get a final `done` chunk.
		expect(chunks.some(c => c.done === true)).toBe(true);
		if (diags.length > 0) {
			expect(typeof diags[0].message).toBe("string");
			expect(diags[0].message.length).toBeGreaterThan(0);
		}
	});

	it("transaction:strict — 2 ops same file both succeed", async () => {
		const file = path.join(tmpDir, "same.txt");
		await fs.writeFile(file, "alpha\nbeta\n");

		const tool = new CodepathEditTool(makeSession(tmpDir));
		const result = await tool.execute("t", {
			transaction: "strict",
			operations: [
				{ target: file, action: { kind: "fileRawTextReplace", find: "alpha", content: "ALPHA" } },
				{ target: file, action: { kind: "fileRawTextReplace", find: "beta", content: "BETA" } },
			],
		});
		expect(result.isError).toBeFalsy();
		expect(await fs.readFile(file, "utf-8")).toBe("ALPHA\nBETA\n");
	});

	it("transaction:strict — second op fails on a different file → first op rolled back", async () => {
		const a = path.join(tmpDir, "a.txt");
		const b = path.join(tmpDir, "b.txt");
		await fs.writeFile(a, "original-a\n");
		await fs.writeFile(b, "original-b\n");

		const tool = new CodepathEditTool(makeSession(tmpDir));
		const result = await tool.execute("t", {
			transaction: "strict",
			operations: [
				// Op 1 succeeds on a.txt.
				{ target: a, action: { kind: "fileRawTextReplace", find: "original-a", content: "patched-a" } },
				// Op 2 fails: searching for a string that doesn't exist in b.txt.
				{ target: b, action: { kind: "fileRawTextReplace", find: "ABSENT_TOKEN_XYZ", content: "patched-b" } },
			],
		});
		expect(result.isError).toBe(true);
		// Rollback restored both files to their pre-batch state.
		expect(await fs.readFile(a, "utf-8")).toBe("original-a\n");
		expect(await fs.readFile(b, "utf-8")).toBe("original-b\n");
	});

	it("symbolReplace scope:body without surrounding braces produces a clear diagnostic (Wave H3)", async () => {
		const file = path.join(tmpDir, "body.ts");
		await fs.writeFile(file, "function f(): number { return 1; }\n");

		const tool = new CodepathEditTool(makeSession(tmpDir));
		const result = await tool.execute("t", {
			operations: [
				{
					target: `${file}::f`,
    	action: { kind: "symbolReplace", scope: "body", content: "@@@" /* missing braces + invalid */ },
    				},
    			],
    		});
    		expect(result.isError).toBe(true);
    		const text = getText(result);
    		expect(text).toMatch(/braces|outer braces|\{ \.\.\. \}|structurally invalid/i);
    		expect(text).toContain("@@@"); // diagnostic includes the offending excerpt
	});

	it("lineInsert with at:{side:'after', line:N} inserts multiline content correctly", async () => {
		const file = path.join(tmpDir, "anchored.txt");
		const initial = "alpha\nbeta\ngamma\n";
		await fs.writeFile(file, initial);

		const tool = new CodepathEditTool(makeSession(tmpDir));
		const result = await tool.execute("t", {
			operations: [
				{
					target: file,
					action: { kind: "lineInsert", at: { side: "after", line: 2 }, content: ["one", "two"] },
				},
			],
		});
		expect(result.isError).toBeFalsy();
		expect(await fs.readFile(file, "utf-8")).toBe("alpha\nbeta\none\ntwo\ngamma\n");
	});

	it("fileWrite handles ~1MB content without policy crash", async () => {
		const file = path.join(tmpDir, "big.txt");
		await fs.writeFile(file, "seed\n");
		// 1 MiB exactly: 1024 * 1024 chars
		const body = "x".repeat(1024 * 1024);

		const { diags } = await runRaw(tmpDir, "big.txt", { kind: "fileWrite", content: body });
		expect(diags.length).toBe(0);
		const stat = await fs.stat(file);
		expect(stat.size).toBe(body.length);
	});

	it("path traversal target rejected by sandbox policy", async () => {
		const policy = { pathsWrite: [tmpDir], writeErrorPrefix: "[sandbox] " } as ToolSession["sandboxPolicy"];
		const tool = new CodepathEditTool(makeSession(tmpDir, policy));

		let threw = false;
		try {
			await tool.execute("t", {
				operations: [
					{
						target: "../../../etc/passwd",
						action: { kind: "fileWrite", content: "owned\n", force: true },
					},
				],
			});
		} catch (e) {
			threw = true;
			expect(String(e)).toMatch(/sandbox|blocks|passwd|allowed/i);
		}
		expect(threw).toBe(true);
		// /etc/passwd, if present, must remain unmodified.
		try {
			const passwd = await fs.readFile("/etc/passwd", "utf-8");
			expect(passwd).not.toContain("owned");
		} catch {
			// fine if unreadable / missing; sandbox blocked the write regardless
		}
	});
});
