import { describe, expect, it } from "bun:test";
import { enforcePathWrite, type SandboxPolicy } from "../../src/sandbox";

const cwd = "/repo";
const policy: SandboxPolicy = {
	pathsWrite: ["src/", "allowed.txt"],
	bashAllow: [],
	bashDeny: [],
};

describe("enforcePathWrite", () => {
	it("allows write to path in pathsWrite list", () => {
		expect(enforcePathWrite("allowed.txt", cwd, policy)).toBeNull();
	});

	it("blocks write to path not in pathsWrite list", () => {
		expect(enforcePathWrite("blocked.txt", cwd, policy)).toContain("Sandbox policy blocks writes to 'blocked.txt'");
	});

	it("blocks all writes when pathsWrite is empty array", () => {
		const blockAllPolicy: SandboxPolicy = {
			pathsWrite: [],
			bashAllow: [],
			bashDeny: [],
		};

		expect(enforcePathWrite("src/file.ts", cwd, blockAllPolicy)).toBe("Sandbox policy blocks all file writes");
	});

	it("allows all writes when sandbox policy is undefined", () => {
		expect(enforcePathWrite("anywhere/file.ts", cwd, undefined)).toBeNull();
	});

	it("treats trailing slash entries as matching subdirectories", () => {
		expect(enforcePathWrite("src/foo/bar.ts", cwd, policy)).toBeNull();
	});

	it("resolves relative paths against cwd", () => {
		const relativePolicy: SandboxPolicy = {
			pathsWrite: ["../shared"],
			bashAllow: [],
			bashDeny: [],
		};

		expect(enforcePathWrite("../shared/file.ts", "/repo/packages/app", relativePolicy)).toBeNull();
	});
});
