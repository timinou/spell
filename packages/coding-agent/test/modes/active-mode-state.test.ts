import { describe, expect, test } from "bun:test";
import type { ResolvedModeConfig } from "../../src/capability/mode";
import type { SourceMeta } from "../../src/capability/types";
import type { AuditState } from "../../src/modes/audit-state";
import { type ActiveModeState, isAuditMode, isUserMode, type UserModeState } from "../../src/modes/mode-state";
import type { ToolSession } from "../../src/tools";
import { enforceModeWrite } from "../../src/tools/mode-guard";

const testSource: SourceMeta = { provider: "test", providerName: "Test", path: "/test", level: "project" };

function makeUserConfig(name: string): ResolvedModeConfig {
	return {
		name,
		path: "/test",
		frontmatter: {},
		sections: { custom: {} },
		level: "project",
		_source: testSource,
		extendsChain: [name],
	};
}

function makeMockSession(activeMode?: ActiveModeState): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: {
			get: (key: string) => (key === "planMode.allowedFolders" ? {} : undefined),
		} as any,
		getActiveModeState: () => activeMode,
	} as ToolSession;
}


const auditState: AuditState = { type: "audit", pending: false, active: true };

const userState: UserModeState = {
	type: "user",
	name: "review",
	config: makeUserConfig("review"),
	enabled: true,
	readOnly: false,
};

describe("ActiveModeState type guards", () => {
	test("isAuditMode returns true for audit state", () => {
		expect(isAuditMode(auditState)).toBe(true);
	});

	test("isUserMode returns true for user state", () => {
		expect(isUserMode(userState)).toBe(true);
	});

	test("all type guards return false for undefined", () => {
		expect(isAuditMode(undefined)).toBe(false);
		expect(isUserMode(undefined)).toBe(false);
	});

	test("all type guards return false for null", () => {
		expect(isAuditMode(null)).toBe(false);
		expect(isUserMode(null)).toBe(false);
	});
});

describe("enforceModeWrite", () => {
	test("user mode readOnly=true blocks writes", () => {
		const roUser: UserModeState = { ...userState, readOnly: true };
		const session = makeMockSession(roUser);
		expect(() => enforceModeWrite(session, "/tmp/test/file.ts")).toThrow("Read-only mode");
	});

	test("user mode readOnly=false allows writes", () => {
		const session = makeMockSession(userState);
		expect(() => enforceModeWrite(session, "/tmp/test/file.ts")).not.toThrow();
	});

	test("audit mode blocks writes", () => {
		const session = makeMockSession(auditState);
		expect(() => enforceModeWrite(session, "/tmp/test/file.ts")).toThrow("Audit mode");
	});


	test("no active mode imposes no restriction", () => {
		const session = makeMockSession(undefined);
		expect(() => enforceModeWrite(session, "/tmp/test/file.ts")).not.toThrow();
	});
});
