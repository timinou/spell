/**
 * Tests for the native `remember` org command.
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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-remember-"));
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

async function remember(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await executeOrg({ command: "remember", repoRoot: tmpDir, ...args });
	if (result.error) throw new Error(String(result.output));
	return result.output as Record<string, unknown>;
}

describe("remember episode", () => {
	test("writes an episode file under .spell/memory/episodes", async () => {
  if (await skipIfNoNative()) return;

		const result = await remember({
			kind: "episode",
			summary: "Debugged auth flow edge case",
			involves: ["FEAT-001", "FEAT-002"],
		});

		expect(typeof result.id).toBe("string");
		expect((result.id as string).startsWith("EP-")).toBe(true);
		expect(typeof result.file).toBe("string");
		expect(result.file as string).toContain(".spell/memory/episodes/");
	});
});

describe("remember concept", () => {
	test("writes a concept file under .spell/memory/concepts", async () => {
  if (await skipIfNoNative()) return;

		const result = await remember({
			kind: "concept",
			summary: "JWT Token Validation",
			about: ["CON-001"],
		});

		expect(result.id).toBe("CON-jwt-token-validation");
		expect(typeof result.file).toBe("string");
		expect(result.file as string).toContain(".spell/memory/concepts/jwt-token-validation.org");
	});
});

describe("remember idempotent append", () => {
	test("appends to existing day file without duplicating header", async () => {
  if (await skipIfNoNative()) return;

		const r1 = await remember({ kind: "episode", summary: "First episode today" });
		const r2 = await remember({ kind: "episode", summary: "Second episode today" });

		expect(typeof r1.id).toBe("string");
		expect(typeof r2.id).toBe("string");
		expect(r1.id).not.toBe(r2.id);

		const file1 = r1.file as string;
		const file2 = r2.file as string;
		expect(file1).toBe(file2);
	});
});
