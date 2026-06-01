/**
 * Tests for the native `timeline` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeOrg } from "@spell/pi-natives";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-timeline-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function skipIfNoNative(): Promise<boolean> {
	try {
		await executeOrg({ command: "recall", text: "x" });
		return false;
	} catch {
		return true;
	}
}

async function timeline(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await executeOrg({ command: "timeline", repoRoot: tmpDir, ...args });
	if (result.error) throw new Error(String(result.output));
	return result.output as Record<string, unknown>;
}

describe("timeline ordered episodes", () => {
	test("returns timeline entries with ABOUT relations", async () => {
  if (await skipIfNoNative()) return;

		const target = "CON-oauth";
		const episodesDir = path.join(tmpDir, ".spell/memory/episodes");
		await fs.mkdir(episodesDir, { recursive: true });
		await Bun.write(
			path.join(episodesDir, "2026-05-01.org"),
			[
				"#+TITLE: Episodes 2026-05-01",
				"",
				"** ITEM Implemented OAuth flow",
				":PROPERTIES:",
				":CUSTOM_ID: EP-001",
				":CREATED: 2026-05-01T10:00:00Z",
				":END:",
				":RELATIONS:",
				"ABOUT: CON-oauth",
				":END:",
			].join("\n"),
		);

		const result = await timeline({ target });

		const entries = (result as { entries?: unknown[] }).entries ?? [];
		expect(entries.length).toBeGreaterThanOrEqual(1);
		const entry = entries[0] as Record<string, unknown>;
		expect(entry.id).toBe("EP-001");
	});
});

describe("timeline no-target empty", () => {
	test("returns empty entries when target not in relations", async () => {
  if (await skipIfNoNative()) return;

		const episodesDir = path.join(tmpDir, ".spell/memory/episodes");
		await fs.mkdir(episodesDir, { recursive: true });
		await Bun.write(
			path.join(episodesDir, "2026-05-01.org"),
			[
				"#+TITLE: Episodes 2026-05-01",
				"",
				"** ITEM Misc work",
				":PROPERTIES:",
				":CUSTOM_ID: EP-002",
				":END:",
				":RELATIONS:",
				"ABOUT: CON-something-else",
				":END:",
			].join("\n"),
		);

		const result = await timeline({ target: "CON-nonexistent" });

		const entries = (result as { entries?: unknown[] }).entries ?? [];
		expect(entries.length).toBe(0);
	});
});
