import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOrgTool } from "../src/tool";
import type { OrgConfig } from "../src/types";

const TODO_KEYWORDS = ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED", "CANCELLED"];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-org-create-response-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(): OrgConfig {
	return {
		dirs: {
			tasks: {
				path: "tasks",
				categories: {
					features: { prefix: "FEAT", path: "features" },
				},
			},
		},
		todoKeywords: TODO_KEYWORDS,
		requiredProperties: ["CUSTOM_ID"],
	};
}

describe("org create response", () => {
	test("includes prefix and missing LAYER guidance when layer is absent", async () => {
		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({
			command: "create",
			category: "features",
			title: "Create response",
		})) as Record<string, unknown>;
		expect(result.success).toBe(true);
		expect(result.suboutlinePrefix).toBe(`${result.id}::`);
		expect(result.missingRequired).toEqual(["LAYER"]);
		expect(result.recommended).toEqual({ DEPENDS: "unset" });
	});

	test("includes suboutline rewrites and satisfied guidance when body uses bare ids", async () => {
		const tool = createOrgTool(tmpDir, makeConfig());
		const result = (await tool.execute({
			command: "create",
			category: "features",
			title: "Create with body",
			properties: { LAYER: "backend", DEPENDS: "FEAT-000-existing" },
			body: ["** Define types", ":PROPERTIES:", ":CUSTOM_ID: define-types", ":END:"].join("\n"),
		})) as Record<string, unknown>;
		expect(result.success).toBe(true);
		expect(result.missingRequired).toEqual([]);
		expect(result.recommended).toEqual({ DEPENDS: "set" });
		expect(result.suboutlineRewrites).toEqual({ "define-types": `${result.id}::define-types` });
	});
});
