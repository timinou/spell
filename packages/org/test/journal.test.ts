/**
 * Tests for the journal writer.
 *
 * Contracts:
 *   - journalFilePath produces a stable, deterministic path for a given session ID
 *   - writeJournal produces valid org content mapping todo statuses to org keywords
 *   - Status mapping: pending→ITEM, in_progress→DOING, completed→DONE, abandoned→DONE
 *   - Each phase becomes a top-level heading; each task a sub-heading
 *   - writeJournal does not throw on write failure (best-effort)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JournalTodoPhase } from "../src/journal";
import { journalFilePath, writeJournal } from "../src/journal";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-journal-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// journalFilePath
// ---------------------------------------------------------------------------

describe("journalFilePath", () => {
	test("returns path under .local/!journal/todos/", () => {
		const p = journalFilePath("/project", "session-abc");
		expect(p).toContain(".local/!journal/todos/");
	});

	test("includes today's date prefix", () => {
		const today = new Date().toISOString().slice(0, 10);
		const p = journalFilePath("/project", "session-abc");
		const basename = path.basename(p);
		expect(basename.startsWith(today)).toBe(true);
	});

	test("ends with .org extension", () => {
		const p = journalFilePath("/project", "session-abc");
		expect(p.endsWith(".org")).toBe(true);
	});

	test("is deterministic for the same session ID", () => {
		const p1 = journalFilePath("/project", "session-xyz");
		const p2 = journalFilePath("/project", "session-xyz");
		expect(p1).toBe(p2);
	});

	test("differs for different session IDs", () => {
		const p1 = journalFilePath("/project", "session-aaa");
		const p2 = journalFilePath("/project", "session-bbb");
		expect(p1).not.toBe(p2);
	});
});

// ---------------------------------------------------------------------------
// writeJournal
// ---------------------------------------------------------------------------

const phases: JournalTodoPhase[] = [
	{
		id: "phase-1",
		name: "Investigation",
		tasks: [
			{ id: "task-1", content: "Read source files", status: "completed" },
			{ id: "task-2", content: "Map callsites", status: "completed" },
		],
	},
	{
		id: "phase-2",
		name: "Implementation",
		tasks: [
			{ id: "task-3", content: "Apply fix", status: "in_progress" },
			{ id: "task-4", content: "Run tests", status: "pending" },
			{ id: "task-5", content: "Old approach", status: "abandoned" },
		],
	},
];

describe("writeJournal", () => {
	test("creates the journal file at the expected path", async () => {
		await writeJournal(tmpDir, "test-session", phases);

		const p = journalFilePath(tmpDir, "test-session");
		const exists = await fs
			.access(p)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	test("produces valid org file header", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const p = journalFilePath(tmpDir, "test-session");
		const content = await Bun.file(p).text();

		expect(content).toContain("#+TITLE:");
		expect(content).toContain("#+DATE:");
		expect(content).toContain("#+TODO: ITEM DOING | DONE");
	});

	test("maps completed → DONE", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DONE Read source files");
	});

	test("maps in_progress → DOING", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DOING Apply fix");
	});

	test("maps pending → ITEM", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** ITEM Run tests");
	});

	test("maps abandoned → DONE", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DONE ");
		// The abandoned task title is wrapped in ~~strikethrough~~
		expect(content).toContain("~~Old approach~~");
	});

	test("each phase appears as a top-level heading", async () => {
		await writeJournal(tmpDir, "test-session", phases);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("* Investigation");
		expect(content).toContain("* Implementation");
	});

	test("writes task notes when present", async () => {
		const withNote: JournalTodoPhase[] = [
			{
				id: "phase-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Do thing", status: "in_progress", notes: "Blocked by upstream" }],
			},
		];

		await writeJournal(tmpDir, "noted-session", withNote);
		const content = await Bun.file(journalFilePath(tmpDir, "noted-session")).text();
		expect(content).toContain("Blocked by upstream");
	});

	test("overwrites previous journal on second call", async () => {
		await writeJournal(tmpDir, "overwrite-session", phases);

		const minimal: JournalTodoPhase[] = [
			{
				id: "phase-1",
				name: "Only phase",
				tasks: [{ id: "task-1", content: "Single task", status: "pending" }],
			},
		];

		await writeJournal(tmpDir, "overwrite-session", minimal);

		const content = await Bun.file(journalFilePath(tmpDir, "overwrite-session")).text();
		expect(content).toContain("Only phase");
		// Old phase names should be gone (file is fully rewritten)
		expect(content).not.toContain("* Investigation");
	});

	test("does not throw when write fails (non-existent deep path handled by Bun.write auto-mkdir)", async () => {
		// Bun.write creates parent dirs, so this should succeed silently
		await expect(writeJournal("/tmp/definitely-does-not-exist-pi-org-test/sub", "s", [])).resolves.toBeUndefined();
	});
});
