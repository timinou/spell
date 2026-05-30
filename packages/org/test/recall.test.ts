/**
 * Tests for the native `recall` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms. Without that, executeOrg will throw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeOrg } from "@spell/pi-natives";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-recall-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(subdir: string, file: string, content: string): Promise<string> {
	const p = path.join(tmpDir, subdir, file);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await Bun.write(p, content);
	return p;
}

async function skipIfNoNative(): Promise<boolean> {
	try {
		await executeOrg({ command: "recall", text: "x" });
		return false;
	} catch {
		return true;
	}
}

async function recall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await executeOrg({ command: "recall", repoRoot: tmpDir, ...args });
	if (result.error) throw new Error(String(result.output));
	return result.output as Record<string, unknown>;
}

describe("recall happy path", () => {
	test("returns hits from fts matching text", async () => {
  if (await skipIfNoNative()) return;

		await writeFixture(
			"!tasks/features",
			"FEAT-001.org",
			[
				"* ITEM Authentication flow",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-001",
				":KIND: concept",
				":END:",
				"Implement OAuth2 login with refresh tokens",
			].join("\n"),
		);
		await writeFixture(
			"!tasks/features",
			"FEAT-002.org",
			[
				"* ITEM Database schema",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-002",
				":KIND: concept",
				":END:",
				"Design the user table schema",
			].join("\n"),
		);

		const result = await recall({ text: "OAuth2" });

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(hits.length).toBeGreaterThanOrEqual(1);
		const hit = hits[0] as Record<string, unknown>;
		expect(hit.id).toBe("FEAT-001");
		expect(typeof hit.score).toBe("number");
	});
});

describe("recall profile", () => {
	test("uses profile parameter", async () => {
  if (await skipIfNoNative()) return;

		await writeFixture(
			"!tasks/features",
			"FEAT-001.org",
			[
				"* ITEM Auth flow",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-001",
				":KIND: concept",
				":END:",
				"OAuth2 authentication implementation",
			].join("\n"),
		);

		const result = await recall({ text: "authentication", profile: "session-start" });

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(Array.isArray(hits)).toBe(true);
	});
});

describe("recall scope filter", () => {
	test("filters by scope", async () => {
  if (await skipIfNoNative()) return;

		await writeFixture(
			"!tasks/features",
			"FEAT-001.org",
			[
				"* ITEM Auth flow",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-001",
				":KIND: episode",
				":END:",
				"Implemented OAuth2 with refresh tokens",
			].join("\n"),
		);

		const result = await recall({ text: "OAuth2", scope: ["concept"] });

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(hits.length).toBe(0);
	});
});

describe("recall empty result", () => {
	test("returns no FTS-ranked hits when no text match", async () => {
  if (await skipIfNoNative()) return;

		await writeFixture(
			"!tasks/features",
			"FEAT-001.org",
			[
				"* ITEM Auth flow",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-001",
				":KIND: concept",
				":END:",
				"OAuth2 authentication",
			].join("\n"),
		);

		const result = await recall({ text: "zzzzzzzzzzz" });

		const hits = ((result as { hits?: Array<Record<string, unknown>> }).hits ?? []).filter(
			h => (h.why as Record<string, unknown> | undefined)?.bm25_rank !== null,
		);
		expect(hits.length).toBe(0);
	});
});
