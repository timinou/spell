import { describe, expect, it } from "bun:test";
import { normalizeCommand, resolveCommandCwd } from "../../src/task/gate-verification";

describe("normalize command", () => {
	it("strips transparent env and shell wrappers down to the canonical command", () => {
		expect(normalizeCommand("env CI=1 bun test")).toBe("bun test");
		expect(normalizeCommand('sh -c "bun test"')).toBe("bun test");
		expect(normalizeCommand("bash -lc 'env CI=1 bun test foo.ts'")).toBe("bun test foo.ts");
	});

	it("strips cwd-changing prefixes from the canonical command text", () => {
		expect(normalizeCommand("cd packages/coding-agent && bun test")).toBe("bun test");
		expect(normalizeCommand('pushd src && sh -c "bun test"')).toBe("bun test");
	});

	it("keeps non-transparent wrappers distinct", () => {
		expect(normalizeCommand("pnpm test")).toBe("pnpm test");
		expect(normalizeCommand("echo bun test")).toBe("echo bun test");
	});

	it("resolves the expected cwd after inline cd prefixes", () => {
		expect(resolveCommandCwd("bun test", "/repo")).toBe("/repo");
		expect(resolveCommandCwd("cd packages/coding-agent && bun test", "/repo")).toBe("/repo/packages/coding-agent");
		expect(resolveCommandCwd('sh -c "cd test && bun test"', "/repo")).toBe("/repo/test");
		expect(resolveCommandCwd('cd /tmp && sh -c "cd nested && bun test"', "/repo")).toBe("/tmp/nested");
	});
});
