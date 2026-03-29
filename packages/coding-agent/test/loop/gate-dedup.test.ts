import { describe, expect, it } from "bun:test";
import { FindingDedup } from "../../src/loop/gates/dedup";

describe("FindingDedup", () => {
	it("detects repeated findings by normalized content hash", () => {
		const dedup = new FindingDedup();
		expect(dedup.evaluate("gate-1", ["missing tests"]).repeated).toBe(false);
		expect(dedup.evaluate("gate-1", ["missing   tests"]).repeated).toBe(true);
		expect(dedup.evaluate("gate-1", ["different finding"]).repeated).toBe(false);
	});
});
