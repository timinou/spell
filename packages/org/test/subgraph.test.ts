/**
 * Tests for the native `subgraph` org command.
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
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-subgraph-"));
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

async function subgraph(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await executeOrg({ command: "subgraph", repoRoot: tmpDir, ...args });
	if (result.error) throw new Error(String(result.output));
	return result.output as Record<string, unknown>;
}

describe("subgraph hops=1", () => {
	test("returns immediate neighbors", async () => {
  if (await skipIfNoNative()) return;

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

		const result = await subgraph({ root: "CON-oauth", hops: 1 });

		const nodes = (result as { nodes?: unknown[] }).nodes ?? [];
		const edges = (result as { edges?: unknown[] }).edges ?? [];

		const nodeIds = nodes.map((n: unknown) => (n as Record<string, unknown>).id);
		expect(nodeIds).toContain("CON-oauth");
		expect(nodeIds).toContain("CON-tokens");
		expect(nodeIds).not.toContain("CON-unrelated");
		expect(edges.length).toBeGreaterThanOrEqual(1);
	});
});

describe("subgraph hops=2 with kind filter", () => {
	test("filters edges by kind", async () => {
  if (await skipIfNoNative()) return;

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

		const result = await subgraph({ root: "CON-root", hops: 2, kinds: ["INVOLVED"] });

		const nodeIds = ((result as { nodes?: Array<{ id: string }> }).nodes ?? []).map(n => n.id);
		const edgeKinds = ((result as { edges?: Array<{ kind: string }> }).edges ?? []).map(e => e.kind);

		expect(edgeKinds.every((k: string) => k === "INVOLVED")).toBe(true);
		expect(nodeIds).toContain("CON-grandchild");
		expect(nodeIds).not.toContain("CON-other");
	});
});
