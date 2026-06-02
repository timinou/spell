/**
 * The catalog drift check must pass against the live tool registry, and its
 * logic must correctly flag untagged / stale tools.
 */

import { describe, expect, it } from "bun:test";
import { findStaleEffectTags, findUntaggedTools, runCatalogCheck } from "./catalog-check";

describe("catalog drift check (live registry)", () => {
	it("every program-callable builtin has an explicit effect tag", () => {
		const untagged = findUntaggedTools();
		expect(untagged).toEqual([]);
	});

	it("no effect tag references a non-existent tool", () => {
		expect(findStaleEffectTags()).toEqual([]);
	});

	it("runCatalogCheck reports ok against the current tree", () => {
		const { ok, report } = runCatalogCheck();
		expect(ok).toBe(true);
		expect(report).toContain("in sync");
	});
});
