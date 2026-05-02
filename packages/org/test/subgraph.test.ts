/**
 * Tests for the `subgraph` org command.
 *
 * NOTE: Requires `bun --cwd=packages/natives run dev:native` after adding
 * the new native dispatch arms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool, type OrgToolDefinition } from "../src/tool";
import { executeOrg } from "@oh-my-pi/pi-natives";

let tmpDir: string;
let tool: OrgToolDefinition;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-subgraph-"));
	tool = createOrgTool(tmpDir, {
		dirs: {
			tasks: {
				path: "tasks",
				categories: { features: { prefix: "FEAT", path: "features" } },
			},
		},
		todoKeywords: ["ITEM", "DOING", "DONE"],
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

describe("subgraph hops=1", () => {
	test("returns immediate neighbors", async () => {
		if (skipIfNoNative()) return;

		const memoryDir = path.join(tmpDir, ".spell/memory");
		await fs.mkdir(path.join(memoryDir, "concepts"), { recursive: true });
		await Bun.write(
			path.join(memoryDir, "concepts", "concepts.org"),
			[
				"* ITEM OAuth Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-oauth",
				":KIND: concept",
				":END:",
				":RELATIONS:",
				"INVOLVED: CON-tokens",
				":END:",
				"",
				"* ITEM Token Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-tokens",
				":KIND: concept",
				":END:",
				"",
				"* ITEM Unrelated Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-unrelated",
				":KIND: concept",
				":END:",
			].join("\n"),
		);

		const result = await tool.execute({
			command: "subgraph",
			root: "CON-oauth",
			hops: 1,
		}) as Record<string, unknown>;

		const nodes = (result as { nodes?: unknown[] }).nodes ?? [];
		const edges = (result as { edges?: unknown[] }).edges ?? [];

		// Should include CON-oauth, CON-tokens (neighbor), but NOT CON-unrelated
		const nodeIds = nodes.map((n: unknown) => (n as Record<string, unknown>).id);
		expect(nodeIds).toContain("CON-oauth");
		expect(nodeIds).toContain("CON-tokens");
		expect(nodeIds).not.toContain("CON-unrelated");
		expect(edges.length).toBeGreaterThanOrEqual(1);
	});
});

describe("subgraph hops=2 with kind filter", () => {
	test("filters edges by kind", async () => {
		if (skipIfNoNative()) return;

		const memoryDir = path.join(tmpDir, ".spell/memory");
		await fs.mkdir(path.join(memoryDir, "concepts"), { recursive: true });
		await Bun.write(
			path.join(memoryDir, "concepts", "concepts.org"),
			[
				"* ITEM Root Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-root",
				":KIND: concept",
				":END:",
				":RELATIONS:",
				"INVOLVED: CON-child",
				"ABOUT: CON-other",
				":END:",
				"",
				"* ITEM Child Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-child",
				":KIND: concept",
				":END:",
				":RELATIONS:",
				"INVOLVED: CON-grandchild",
				":END:",
				"",
				"* ITEM Grandchild Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-grandchild",
				":KIND: concept",
				":END:",
				"",
				"* ITEM Other Concept",
				":PROPERTIES:",
				":CUSTOM_ID: CON-other",
				":KIND: concept",
				":END:",
			].join("\n"),
		);

		const result = await tool.execute({
			command: "subgraph",
			root: "CON-root",
			hops: 2,
			kinds: ["INVOLVED"],
		}) as Record<string, unknown>;

		const nodeIds = ((result as { nodes?: Array<{ id: string }> }).nodes ?? []).map(n => n.id);
		const edgeKinds = ((result as { edges?: Array<{ kind: string }> }).edges ?? []).map(e => e.kind);

		// All edges should be INVOLVED
		expect(edgeKinds.every((k: string) => k === "INVOLVED")).toBe(true);
		// Should reach grandchild via 2 hops over INVOLVED edges
		expect(nodeIds).toContain("CON-grandchild");
		// CON-other is connected via ABOUT, not INVOLVED, so should be excluded
		expect(nodeIds).not.toContain("CON-other");
	});
});
