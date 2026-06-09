/**
 * Tests for the journal writer.
 *
 * Contracts:
 *   - journalFilePath produces a stable, deterministic path for a given session ID
 *   - writeJournal produces valid org content mapping todo statuses to org keywords
 *   - Status mapping: pending→ITEM, in_progress→DOING, completed→DONE, abandoned→DONE
 *   - Each group becomes a top-level heading; each task a sub-heading
 *   - writeJournal does not throw on write failure (best-effort)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JournalTodoGroup } from "../src/journal";
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

const groups: JournalTodoGroup[] = [
	{
		id: "group-1",
		name: "Investigation",
		tasks: [
			{ id: "task-1", content: "Read source files", status: "completed" },
			{ id: "task-2", content: "Map callsites", status: "completed" },
		],
	},
	{
		id: "group-2",
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
		await writeJournal(tmpDir, "test-session", groups);

		const p = journalFilePath(tmpDir, "test-session");
		const exists = await fs
			.access(p)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	test("produces valid org file header", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const p = journalFilePath(tmpDir, "test-session");
		const content = await Bun.file(p).text();

		expect(content).toContain("#+TITLE:");
		expect(content).toContain("#+DATE:");
		expect(content).toContain("#+TODO: ITEM DOING BLOCKED | DONE");
	});

	test("maps completed → DONE", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DONE Read source files");
	});

	test("maps in_progress → DOING", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DOING Apply fix");
	});

	test("maps pending → ITEM", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** ITEM Run tests");
	});

	test("maps abandoned → DONE", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("** DONE ");
		// The abandoned task title is wrapped in ~~strikethrough~~
		expect(content).toContain("~~Old approach~~");
	});

	test("each group appears as a top-level heading", async () => {
		await writeJournal(tmpDir, "test-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "test-session")).text();
		expect(content).toContain("* Investigation");
		expect(content).toContain("* Implementation");
	});

	test("writes task notes when present", async () => {
		const withNote: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Work",
				tasks: [{ id: "task-1", content: "Do thing", status: "in_progress", notes: "Blocked by upstream" }],
			},
		];

		await writeJournal(tmpDir, "noted-session", withNote);
		const content = await Bun.file(journalFilePath(tmpDir, "noted-session")).text();
		expect(content).toContain("Blocked by upstream");
	});

	test("overwrites previous journal on second call", async () => {
		await writeJournal(tmpDir, "overwrite-session", groups);

		const minimal: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Only group",
				tasks: [{ id: "task-1", content: "Single task", status: "pending" }],
			},
		];

		await writeJournal(tmpDir, "overwrite-session", minimal);

		const content = await Bun.file(journalFilePath(tmpDir, "overwrite-session")).text();
		expect(content).toContain("Only group");
		// Old group names should be gone (file is fully rewritten)
		expect(content).not.toContain("* Investigation");
	});

	test("does not throw when write fails (non-existent deep path handled by Bun.write auto-mkdir)", async () => {
		// Bun.write creates parent dirs, so this should succeed silently
		await expect(writeJournal("/tmp/definitely-does-not-exist-pi-org-test/sub", "s", [])).resolves.toBeUndefined();
	});
	test("serializes gate properties to org PROPERTIES drawer", async () => {
		const gatedPhases: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Gated Work",
				tasks: [
					{
						id: "task-1",
						content: "Build feature",
						status: "in_progress",
						verify: { commit: true, artifact: "dist/output.json", cmd: "bun test" },
					},
				],
			},
		];
		await writeJournal(tmpDir, "gate-session", gatedPhases);
		const content = await Bun.file(journalFilePath(tmpDir, "gate-session")).text();
		expect(content).toContain(":VERIFY_COMMIT: true");
		expect(content).toContain(":VERIFY_ARTIFACT: dist/output.json");
		expect(content).toContain(":VERIFY_CMD: bun test");
	});

	test("serializes blocker properties space-separated", async () => {
		const blockerPhases: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Blocked Work",
				tasks: [
					{
						id: "task-1",
						content: "Depends on others",
						status: "pending",
						blockers: ["task-2", "task-3"],
					},
				],
			},
		];
		await writeJournal(tmpDir, "blocker-session", blockerPhases);
		const content = await Bun.file(journalFilePath(tmpDir, "blocker-session")).text();
		expect(content).toContain(":DEPENDS: task-2 task-3");
	});

	test("omits gate properties when not set", async () => {
		const plainPhases: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Plain Work",
				tasks: [
					{
						id: "task-1",
						content: "Simple task",
						status: "pending",
					},
				],
			},
		];
		await writeJournal(tmpDir, "plain-session", plainPhases);
		const content = await Bun.file(journalFilePath(tmpDir, "plain-session")).text();
		expect(content).not.toContain(":VERIFY_");
		expect(content).not.toContain(":DEPENDS");
		expect(content).not.toContain(":BLOCKER");
	});

	test("ref and closesRef written to journal", async () => {
		const groups: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Linked Work",
				tasks: [
					{
						id: "task-1",
						content: "Linked task",
						status: "completed",
						ref: "org://FEAT-001-auth",
						closesRef: true,
					},
				],
			},
		];
		await writeJournal(tmpDir, "linked-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "linked-session")).text();
		expect(content).toContain(":REF: org://FEAT-001-auth");
		expect(content).toContain(":CLOSES_REF: true");
	});

	test("omits org item properties when not set", async () => {
		const groups: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Plain Work",
				tasks: [
					{
						id: "task-1",
						content: "No org link",
						status: "pending",
					},
				],
			},
		];
		await writeJournal(tmpDir, "no-org-session", groups);
		const content = await Bun.file(journalFilePath(tmpDir, "no-org-session")).text();
		expect(content).not.toContain(":REF:");
		expect(content).not.toContain(":CLOSES_REF:");
	});

	test("serializes details as body text below PROPERTIES drawer", async () => {
		const detailPhases: JournalTodoGroup[] = [
			{
				id: "group-1",
				name: "Detailed Work",
				tasks: [
					{
						id: "task-1",
						content: "Complex task",
						status: "in_progress",
						details: "Step 1: Read the code\nStep 2: Fix the bug",
					},
				],
			},
		];
		await writeJournal(tmpDir, "detail-session", detailPhases);
		const content = await Bun.file(journalFilePath(tmpDir, "detail-session")).text();
		expect(content).toContain("Step 1: Read the code");
		expect(content).toContain("Step 2: Fix the bug");
		const endIdx = content.indexOf(":END:");
		const detailIdx = content.indexOf("Step 1: Read the code");
		expect(detailIdx).toBeGreaterThan(endIdx);
	});
});
