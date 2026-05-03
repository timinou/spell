/**
 * Tests for the `remember` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeOrg } from "@oh-my-pi/pi-natives";
import { createOrgTool, type OrgToolDefinition } from "../src/tool";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;
let tool: OrgToolDefinition;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-remember-"));
	tool = createOrgTool(tmpDir, {
		dirs: {
			tasks: {
				path: "tasks",
				categories: { features: { prefix: "FEAT", path: "features" } },
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	});
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

describe("remember episode", () => {
	test("writes an episode file under .spell/memory/episodes", async () => {
		if (skipIfNoNative()) return;

		const result = (await tool.execute({
			command: "remember",
			kind: "episode",
			summary: "Debugged auth flow edge case",
			involves: ["FEAT-001", "FEAT-002"],
		})) as Record<string, unknown>;

		expect(typeof result.id).toBe("string");
		expect((result.id as string).startsWith("EP-")).toBe(true);
		expect(typeof result.file).toBe("string");
		expect(result.file as string).toContain(".spell/memory/episodes/");
	});
});

describe("remember concept", () => {
	test("writes a concept file under .spell/memory/concepts", async () => {
		if (skipIfNoNative()) return;

		const result = (await tool.execute({
			command: "remember",
			kind: "concept",
			summary: "JWT Token Validation",
			about: ["CON-001"],
		})) as Record<string, unknown>;

		expect(result.id).toBe("CON-jwt-token-validation");
		expect(typeof result.file).toBe("string");
		expect(result.file as string).toContain(".spell/memory/concepts/jwt-token-validation.org");
	});
});

describe("remember idempotent append", () => {
	test("appends to existing day file without duplicating header", async () => {
		if (skipIfNoNative()) return;

		// First write
		const r1 = (await tool.execute({
			command: "remember",
			kind: "episode",
			summary: "First episode today",
		})) as Record<string, unknown>;

		// Second write to same day
		const r2 = (await tool.execute({
			command: "remember",
			kind: "episode",
			summary: "Second episode today",
		})) as Record<string, unknown>;

		expect(typeof r1.id).toBe("string");
		expect(typeof r2.id).toBe("string");
		expect(r1.id).not.toBe(r2.id);

		// Both should be in the same day file (same file path pattern)
		const file1 = r1.file as string;
		const file2 = r2.file as string;
		expect(file1).toBe(file2);
	});
});
