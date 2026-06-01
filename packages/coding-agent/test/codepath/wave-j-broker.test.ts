/**
 * Wave J — broker contract tests.
 *
 * Asserts the canonical edit path (executeCodePath) honours the per-session
 * `edit-history.jsonl` journal contract: writes ARE recorded when sessionId
 * is set; SKIPPED when absent; multi-edit sessions accumulate; concurrent
 * sessions on different files succeed without false-positive PeerConflict.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { executeCodePath } from "@spell/pi-natives";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface HistoryEntry {
	id: string;
	session_id: string;
	file: string;
	before: string;
	after: string;
	diff: string;
}

async function readHistory(root: string): Promise<HistoryEntry[]> {
	const file = path.join(root, ".spell", "edit-history.jsonl");
	try {
		const raw = await fs.readFile(file, "utf-8");
		return raw
			.split("\n")
			.filter(l => l.trim().length > 0)
			.map(l => JSON.parse(l) as HistoryEntry);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
}

async function editFile(root: string, file: string, find: string, content: string, sessionId?: string): Promise<void> {
	const chunks = await executeCodePath({
		command: "edit",
		target: file,
		root,
		actions: [{ kind: "fileRawTextReplace", find, content }],
		sessionId,
	});
	const diags = chunks.flatMap(c => c.diagnostics);
	if (diags.length > 0) throw new Error(`edit failed: ${diags[0]!.message}`);
}

describe("Wave J: broker contract", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-j-broker-"));
		// Plant a `.spell` marker so workspace_root_for stops at tmpDir.
		await fs.mkdir(path.join(tmpDir, ".spell"), { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("edit with session.id appends a journal entry tagged with that session", async () => {
		const file = path.join(tmpDir, "a.ts");
		await fs.writeFile(file, "const x = 1;\n");

		await editFile(tmpDir, "a.ts", "1", "2", "S-test-1");

		const entries = await readHistory(tmpDir);
		expect(entries.length).toBe(1);
		expect(entries[0]!.session_id).toBe("S-test-1");
		expect(entries[0]!.file).toBe(file);
		expect(entries[0]!.before).toContain("const x = 1");
		expect(entries[0]!.after).toContain("const x = 2");
	});

	it("edit without session.id skips the journal but still writes the file", async () => {
		const file = path.join(tmpDir, "b.ts");
		await fs.writeFile(file, "const y = 10;\n");

		await editFile(tmpDir, "b.ts", "10", "20" /* no sessionId */);

		expect(await fs.readFile(file, "utf-8")).toBe("const y = 20;\n");
		const entries = await readHistory(tmpDir);
		expect(entries.length).toBe(0);
	});

	it("five sequential session edits accumulate five journal entries in order", async () => {
		const file = path.join(tmpDir, "c.ts");
		await fs.writeFile(file, "n=0\n");

		for (let i = 1; i <= 5; i++) {
			await editFile(tmpDir, "c.ts", `n=${i - 1}`, `n=${i}`, "S-multi");
		}

		const entries = await readHistory(tmpDir);
		expect(entries.length).toBe(5);
		for (const e of entries) expect(e.session_id).toBe("S-multi");
		// Order preserved: each entry's `after` matches the next entry's `before`.
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i]!.before).toBe(entries[i - 1]!.after);
		}
		expect(await fs.readFile(file, "utf-8")).toBe("n=5\n");
	});

	it("two concurrent sessions on different files both succeed (no false PeerConflict)", async () => {
		await fs.writeFile(path.join(tmpDir, "alpha.ts"), "val=A\n");
		await fs.writeFile(path.join(tmpDir, "beta.ts"), "val=B\n");

		const [resA, resB] = await Promise.allSettled([
			editFile(tmpDir, "alpha.ts", "A", "AA", "S-alpha"),
			editFile(tmpDir, "beta.ts", "B", "BB", "S-beta"),
		]);
		expect(resA.status).toBe("fulfilled");
		expect(resB.status).toBe("fulfilled");
		expect(await fs.readFile(path.join(tmpDir, "alpha.ts"), "utf-8")).toBe("val=AA\n");
		expect(await fs.readFile(path.join(tmpDir, "beta.ts"), "utf-8")).toBe("val=BB\n");

		const entries = await readHistory(tmpDir);
		const sessions = new Set(entries.map(e => e.session_id));
		expect(sessions.has("S-alpha")).toBe(true);
		expect(sessions.has("S-beta")).toBe(true);
	});

	// TODO: two sessions edit SAME file → second hits PeerConflict — requires
	// spawning the pi-edit-broker daemon under a controlled socket, which is out
	// of scope for this test file. See PLAN-309 Wave H P0/P1 for kernel coverage.
 it.todo("PeerConflict on same-file concurrent sessions (broker daemon required)", () => {});
});
