/**
 * Regen byte-equality gate.
 *
 * Asserts the committed `codepath-op-schema.generated.ts` is identical to
 * fresh output from `gen-op-schema.ts`.  A mismatch means the kernel Op
 * enum changed without regeneration — the test fails with a clear diff.
 */

import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

const COMMITTED_PATH = path.join(
	import.meta.dir,
	"../../src/tools/codepath-op-schema.generated.ts",
);
const SCRIPT_PATH = path.join(
	import.meta.dir,
	"../../scripts/gen-op-schema.ts",
);
const PKG_ROOT = path.join(import.meta.dir, "../..");

const BACKUP_PATH = "/tmp/op-schema-committed-backup.ts";

test("Op schema regen byte-equal to committed", async () => {
	// ── snapshot committed content before generator overwrites it ──
	const committedContent = await fs.readFile(COMMITTED_PATH, "utf-8");
	await fs.writeFile(BACKUP_PATH, committedContent, "utf-8");

	try {
		// Run the same generator that gen:op-schema invokes
		// This overwrites COMMITTED_PATH with fresh regen output + biome format.
		execSync(`bun run "${SCRIPT_PATH}"`, {
			cwd: PKG_ROOT,
			stdio: "pipe",
			timeout: 30_000,
		});

		const regenContent = await fs.readFile(COMMITTED_PATH, "utf-8");

		// String comparison — expect() gives a nice diff on failure
		expect(regenContent).toBe(committedContent);
	} finally {
		// Always restore the committed file from backup
		await fs.writeFile(COMMITTED_PATH, committedContent, "utf-8");
		await fs.unlink(BACKUP_PATH).catch(() => {});
	}
});
