/**
 * Tile store tests (FUP-123). Exercises the org-item config CRUD + the
 * last-outcome cache via the real native org engine over a tmp project root.
 *
 * The memory-episode half of recordRun() depends on the knowledge daemon; these
 * tests run with PI_KNOWLEDGE_WORKER=inprocess and assert the org-item cache
 * (the render-fast path), which is what the UI reads. Episode write is
 * best-effort and logged, not gated, so a daemon-less run still updates config.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTile, deleteTile, getTile, listTiles, recordRun, updateTile } from "./tile-store";

describe("tile-store", () => {
	let dir: string;
	const prevWorker = process.env.PI_KNOWLEDGE_WORKER;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), "tile-store-"));
		// tiles category lives under !tasks/tiles per DEFAULT_ORG_CONFIG.
		await fs.mkdir(path.join(dir, "!tasks", "tiles"), { recursive: true });
		process.env.PI_KNOWLEDGE_WORKER = "inprocess";
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
		if (prevWorker === undefined) delete process.env.PI_KNOWLEDGE_WORKER;
		else process.env.PI_KNOWLEDGE_WORKER = prevWorker;
	});

	it("creates a tile and round-trips its config", async () => {
		const id = await createTile(dir, {
			owner: "alice",
			project: dir,
			title: "Migrate oldLog to logger.info",
			kind: "codemod",
			programRef: "PB-migrate-oldlog",
			mode: "write",
			autoWrite: false,
		});
		expect(id).toMatch(/^TILE-/);

		const got = await getTile(dir, id);
		expect(got).toBeDefined();
		expect(got?.owner).toBe("alice");
		expect(got?.project).toBe(dir);
		expect(got?.kind).toBe("codemod");
		expect(got?.programRef).toBe("PB-migrate-oldlog");
		expect(got?.mode).toBe("write");
		expect(got?.autoWrite).toBe(false);
	});

	it("round-trips a format-kind tile", async () => {
		const id = await createTile(dir, {
			owner: "a",
			project: dir,
			title: "Normalize whitespace",
			kind: "format",
			programInline: "(format-sweep)",
			mode: "write",
			autoWrite: false,
		});
		const got = await getTile(dir, id);
		expect(got?.kind).toBe("format");
	});

	it("lists only tiles for the given project", async () => {
		await createTile(dir, { owner: "a", project: dir, title: "T1", kind: "codemod", mode: "read", autoWrite: false });
		await createTile(dir, { owner: "a", project: "/other/project", title: "T2", kind: "codemod", mode: "read", autoWrite: false });
		const tiles = await listTiles(dir, dir);
		expect(tiles).toHaveLength(1);
		expect(tiles[0]?.title).toBe("T1");
	});

	it("renames a tile (title is the org headline, not a property)", async () => {
		const id = await createTile(dir, { owner: "a", project: dir, title: "Old name", kind: "codemod", mode: "write", autoWrite: false });
		const ok = await updateTile(dir, id, { title: "New name", programInline: "(+ 1 2)" });
		expect(ok).toBe(true);
		const got = await getTile(dir, id);
		expect(got?.title).toBe("New name");
		expect(got?.programInline).toBe("(+ 1 2)");
	});

	it("arms a tile (autoWrite) and persists across reads", async () => {
		const id = await createTile(dir, { owner: "a", project: dir, title: "Arm me", kind: "codemod", mode: "write", autoWrite: false });
		const ok = await updateTile(dir, id, { autoWrite: true });
		expect(ok).toBe(true);
		const got = await getTile(dir, id);
		expect(got?.autoWrite).toBe(true);
	});

	it("records a run outcome into the org-item cache (commit AND rollback)", async () => {
		const id = await createTile(dir, { owner: "a", project: dir, title: "Run me", kind: "codemod", mode: "write", autoWrite: true });

		await recordRun(dir, id, { intent: "interactive", outcome: "committed", files: 4, paths: ["a.ts", "b.ts"] });
		let got = await getTile(dir, id);
		expect(got?.lastOutcome).toBe("committed");
		expect(got?.lastFiles).toBe(4);
		expect(got?.lastRunAt).toBeDefined();

		// A subsequent rollback is recorded with equal fidelity (not invisible).
		await recordRun(dir, id, { intent: "interactive", outcome: "rolled-back", files: 1, error: "boom" });
		got = await getTile(dir, id);
		expect(got?.lastOutcome).toBe("rolled-back");
		expect(got?.lastFiles).toBe(1);
	});

	it("returns undefined for a missing tile and false on update", async () => {
		expect(await getTile(dir, "TILE-999-nope")).toBeUndefined();
		expect(await updateTile(dir, "TILE-999-nope", { autoWrite: true })).toBe(false);
	});

	it("deletes a tile and removes it from the list", async () => {
		const id = await createTile(dir, { owner: "a", project: dir, title: "Delete me", kind: "codemod", mode: "read", autoWrite: false });
		expect(await getTile(dir, id)).toBeDefined();
		expect(await deleteTile(dir, id)).toBe(true);
		expect(await getTile(dir, id)).toBeUndefined();
		expect(await listTiles(dir, dir)).toHaveLength(0);
		// Deleting a missing tile is a no-op false (not an error).
		expect(await deleteTile(dir, id)).toBe(false);
	});
});
