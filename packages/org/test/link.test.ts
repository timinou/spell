/**
 * Tests for the native `link` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-link-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function skipIfNoNative(): boolean {
	try {
		executeOrg({ command: "recall", text: "x" });
		return false;
	} catch {
		return true;
	}
}

function link(args: Record<string, unknown>): Record<string, unknown> {
	const result = executeOrg({ command: "link", repoRoot: tmpDir, ...args });
	if (result.error) throw new Error(String(result.output));
	return result.output as Record<string, unknown>;
}

describe("link appends edge", () => {
	test("adds a RELATIONS edge to the source item file", async () => {
		if (skipIfNoNative()) return;

		const tasksDir = path.join(tmpDir, "!tasks", "features");
		await fs.mkdir(tasksDir, { recursive: true });
		await Bun.write(
			path.join(tasksDir, "FEAT-001.org"),
			["* ITEM Feature One", ":PROPERTIES:", ":CUSTOM_ID: FEAT-001", ":END:", "", "Some body text."].join("\n"),
		);
		await Bun.write(
			path.join(tasksDir, "FEAT-002.org"),
			["* ITEM Feature Two", ":PROPERTIES:", ":CUSTOM_ID: FEAT-002", ":END:"].join("\n"),
		);

		const result = link({ from: "FEAT-001", to: "FEAT-002", kind: "INVOLVED" });

		expect(typeof result.revision).toBe("number");
		expect(typeof result.file).toBe("string");
		expect(result.file as string).toContain("FEAT-001.org");
	});
});

describe("link idempotent", () => {
	test("does not add duplicate edges", async () => {
		if (skipIfNoNative()) return;

		const tasksDir = path.join(tmpDir, "!tasks", "features");
		await fs.mkdir(tasksDir, { recursive: true });
		await Bun.write(
			path.join(tasksDir, "FEAT-003.org"),
			[
				"* ITEM Feature Three",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-003",
				":END:",
				":RELATIONS:",
				"INVOLVED: FEAT-004",
				":END:",
			].join("\n"),
		);
		await Bun.write(
			path.join(tasksDir, "FEAT-004.org"),
			["* ITEM Feature Four", ":PROPERTIES:", ":CUSTOM_ID: FEAT-004", ":END:"].join("\n"),
		);

		const result = link({ from: "FEAT-003", to: "FEAT-004", kind: "INVOLVED" });

		expect(typeof result.revision).toBe("number");
		expect(typeof result.file).toBe("string");

		const content = await Bun.file(result.file as string).text();
		const matches = content.match(/INVOLVED: FEAT-004/g);
		expect(matches?.length).toBe(1);
	});
});
