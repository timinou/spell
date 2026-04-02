import { describe, expect, it } from "bun:test";
import { enforceBashCommand, type SandboxPolicy } from "../../src/sandbox";

const policy: SandboxPolicy = {
	pathsWrite: [],
	bashAllow: ["bun test*", "git status"],
	bashDeny: ["rm -rf *", "bun test dangerous/*"],
};

describe("enforceBashCommand", () => {
	it("allows command matching bashAllow", () => {
		expect(enforceBashCommand("git status", policy)).toBeNull();
	});

	it("blocks command not matching any bashAllow", () => {
		expect(enforceBashCommand("git push", policy)).toBe(
			"Sandbox policy blocks bash command. Allowed patterns: bun test*, git status",
		);
	});

	it("blocks command matching bashDeny even if bashAllow matches", () => {
		expect(enforceBashCommand("bun test dangerous/spec.test.ts", policy)).toBe(
			"Sandbox policy denies bash command matching 'bun test dangerous/*'",
		);
	});

	it("allows all commands when sandbox policy is undefined", () => {
		expect(enforceBashCommand("anything", undefined)).toBeNull();
	});

	it("allows all commands when both bash lists are empty", () => {
		const unrestrictedPolicy: SandboxPolicy = {
			pathsWrite: [],
			bashAllow: [],
			bashDeny: [],
		};

		expect(enforceBashCommand("bun run build", unrestrictedPolicy)).toBeNull();
	});

	it("supports glob patterns in bashAllow", () => {
		expect(enforceBashCommand("bun test src/foo.test.ts", policy)).toBeNull();
	});
});
