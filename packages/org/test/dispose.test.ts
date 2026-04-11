/**
 * Tests for org tool dispose behavior.
 *
 * Contracts:
 * 1. dispose() before first use does not throw.
 * 2. dispose() is idempotent — second call is a no-op.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_ORG_CONFIG } from "../src/schema/defaults";
import { createOrgTool } from "../src/tool";

describe("org tool dispose", () => {
	it("dispose before first use does not throw", async () => {
		const tool = createOrgTool("/tmp/project", DEFAULT_ORG_CONFIG);
		expect(tool.dispose).toBeDefined();
		await tool.dispose!();
	});

	it("dispose is idempotent", async () => {
		const tool = createOrgTool("/tmp/project", DEFAULT_ORG_CONFIG);
		await tool.dispose!();
		await tool.dispose!();
	});
});
