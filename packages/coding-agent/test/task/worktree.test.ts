import { describe, expect, it } from "bun:test";
import { getGitNoIndexNullPath, isProjfsUnavailableError } from "../../src/task/worktree";

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("detects ProjFS prerequisite errors by prefix", () => {
		expect(isProjfsUnavailableError(new Error("PROJFS_UNAVAILABLE: missing feature"))).toBe(true);
		expect(isProjfsUnavailableError(new Error("fuse-overlay mount failed"))).toBe(false);
		expect(isProjfsUnavailableError("PROJFS_UNAVAILABLE: not-an-error-instance")).toBe(false);
	});
});
