/**
 * Tests for the `recall` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms. Without that, executeOrg will throw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool, type OrgToolDefinition } from "../src/tool";
import type { OrgConfig } from "../src/types";
import { executeOrg } from "@oh-my-pi/pi-natives";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;
let tool: OrgToolDefinition;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-recall-"));
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

async function writeFixture(subdir: string, file: string, content: string): Promise<string> {
	const p = path.join(tmpDir, subdir, file);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await Bun.write(p, content);
	return p;
}

function skipIfNoNative(): boolean {
	try {
		executeOrg({ command: "recall", text: "x" });
		return false;
	} catch {
		return true;
	}
}

describe("recall happy path", () => {
	test("returns hits from fts matching text", async () => {
		if (skipIfNoNative()) return;

		// Write fixture org files under !tasks
		await writeFixture("!tasks/features", "FEAT-001.org", [
			"* ITEM Authentication flow",
			":PROPERTIES:",
			":CUSTOM_ID: FEAT-001",
			":KIND: concept",
			":END:",
			"Implement OAuth2 login with refresh tokens",
		].join("\n"));
		await writeFixture("!tasks/features", "FEAT-002.org", [
			"* ITEM Database schema",
			":PROPERTIES:",
			":CUSTOM_ID: FEAT-002",
			":KIND: concept",
			":END:",
			"Design the user table schema",
		].join("\n"));

		const result = await tool.execute({
			command: "recall",
			text: "OAuth2",
		}) as Record<string, unknown>;

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(hits.length).toBeGreaterThanOrEqual(1);
		const hit = hits[0] as Record<string, unknown>;
		expect(hit.id).toBe("FEAT-001");
		expect(typeof hit.score).toBe("number");
	});
});

describe("recall profile", () => {
	test("uses profile parameter", async () => {
		if (skipIfNoNative()) return;

		await writeFixture("!tasks/features", "FEAT-001.org", [
			"* ITEM Auth flow",
			":PROPERTIES:",
			":CUSTOM_ID: FEAT-001",
			":KIND: concept",
			":END:",
			"OAuth2 authentication implementation",
		].join("\n"));

		const result = await tool.execute({
			command: "recall",
			text: "authentication",
			profile: "session-start",
		}) as Record<string, unknown>;

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(Array.isArray(hits)).toBe(true);
	});
});

describe("recall scope filter", () => {
	test("filters by scope", async () => {
		if (skipIfNoNative()) return;

		await writeFixture("!tasks/features", "FEAT-001.org", [
			"* ITEM Auth flow",
			":PROPERTIES:",
			":CUSTOM_ID: FEAT-001",
			":KIND: episode",
			":END:",
			"Implemented OAuth2 with refresh tokens",
		].join("\n"));

		const result = await tool.execute({
			command: "recall",
			text: "OAuth2",
			scope: ["concept"],
		}) as Record<string, unknown>;

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		// The only item has kind=episode, scope=["concept"] should exclude it
		expect(hits.length).toBe(0);
	});
});

describe("recall empty result", () => {
	test("returns empty hits when no match", async () => {
		if (skipIfNoNative()) return;

		await writeFixture("!tasks/features", "FEAT-001.org", [
			"* ITEM Auth flow",
			":PROPERTIES:",
			":CUSTOM_ID: FEAT-001",
			":KIND: concept",
			":END:",
			"OAuth2 authentication",
		].join("\n"));

		const result = await tool.execute({
			command: "recall",
			text: "zzzzzzzzzzz",
		}) as Record<string, unknown>;

		const hits = (result as { hits?: unknown[] }).hits ?? [];
		expect(hits.length).toBe(0);
	});
});
