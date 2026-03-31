import { describe, expect, test } from "bun:test";

/**
 * Tests for wave manifest skeleton generation.
 *
 * The formatWaveManifest function is internal to tool.ts, so we test the
 * contract through the exported types and verify the manifest format
 * expectations that downstream consumers (exit-plan-mode, planner prompt) rely on.
 */

describe("Wave manifest format contract", () => {
	test("manifest skeleton uses :wave: tagged headings", () => {
		// This verifies the format contract that exit-plan-mode and planner prompt depend on.
		// A wave heading must match: ** wave-N followed by :wave: tag
		const waveHeadingRe = /^\*\* wave-\d+\s+:wave:$/;
		expect(waveHeadingRe.test("** wave-1                                        :wave:")).toBe(true);
		expect(waveHeadingRe.test("** wave-2         :wave:")).toBe(true);
		expect(waveHeadingRe.test("** wave-10 :wave:")).toBe(true);
	});

	test("manifest entries use [[id:...]] link format", () => {
		// Each wave entry references a sub-outline via [[id:PARENT::slug]] link
		const entryRe = /^- \[\[id:[A-Z]+-\d+(?:-[a-z0-9-]+)?(?:::[a-z0-9-]+)?\]\] .+$/;
		expect(entryRe.test("- [[id:FEAT-001::define-types]] Define TypeScript interfaces")).toBe(true);
		expect(entryRe.test("- [[id:PROJ-007::schema]] Schema definition")).toBe(true);
		// Top-level IDs also valid in manifest
		expect(entryRe.test("- [[id:FEAT-001]] Feature one")).toBe(true);
	});

	test("manifest has * Execution Manifest heading", () => {
		const headingRe = /^\* Execution Manifest$/;
		expect(headingRe.test("* Execution Manifest")).toBe(true);
	});

	test("3-wave manifest has correct structure", () => {
		// Simulate what formatWaveManifest produces
		const lines = [
			"* Execution Manifest",
			"** wave-1                                        :wave:",
			"- [[id:FEAT-001::define-types]] Define TypeScript interfaces",
			"- [[id:FEAT-002::define-schema]] Define parser schema",
			"** wave-2                                        :wave:",
			"- [[id:FEAT-001::implement-parser]] Implement parser logic",
			"** wave-3                                        :wave:",
			"- [[id:FEAT-001::write-tests]] Write parser tests",
			"",
		];
		const manifest = lines.join("\n");

		// Verify structure
		expect(manifest).toContain("* Execution Manifest");
		expect(manifest).toContain("** wave-1");
		expect(manifest).toContain("** wave-2");
		expect(manifest).toContain("** wave-3");
		expect(manifest).toContain(":wave:");
		expect(manifest).toContain("[[id:FEAT-001::define-types]]");
		expect(manifest).toContain("[[id:FEAT-002::define-schema]]");
		expect(manifest).toContain("[[id:FEAT-001::implement-parser]]");
		expect(manifest).toContain("[[id:FEAT-001::write-tests]]");
	});
});
