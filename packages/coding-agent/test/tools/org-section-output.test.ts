import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const createOrgToolMock = vi.fn(() => ({
	name: "org",
	description: "mock org tool",
	parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	execute: async (): Promise<unknown> => ({
		success: true,
		id: "PLAN-008-org-section-level-editing",
		updated: ["body"],
		file: "/tmp/plan.org",
		section: "Context",
		fileContent: `#+TITLE: Sectioned plan
#+STATE: ITEM
#+CUSTOM_ID: PLAN-008-org-section-level-editing

* Context
Revised context.
`,
	}),
}));

beforeEach(() => {
	mock.module("@oh-my-pi/pi-org", () => ({
		createOrgTool: createOrgToolMock,
		DEFAULT_ORG_CONFIG: {
			dirs: {},
			todoKeywords: ["ITEM", "DOING", "REVIEW", "DONE", "BLOCKED"],
			requiredProperties: ["CUSTOM_ID"],
		},
		detectEmacs: async () => ({
			found: true,
			meetsMinimum: true,
			socatFound: true,
			errors: [],
			path: "/usr/bin/emacs",
		}),
	}));
	mock.module("@oh-my-pi/pi-emacs", () => ({
		startEmacsSession: async () => ({
			socketPath: "/tmp/fake-org.sock",
			stop: async (): Promise<void> => {},
			isAlive: (): boolean => true,
		}),
	}));
	createOrgToolMock.mockClear();
});

afterEach(() => {
	mock.restore();
	vi.restoreAllMocks();
});

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "test-session",
		getFirstUserMessage: () => "Inspect org output",
		settings: Settings.isolated(),
	};
}

describe("OrgTool section update output", () => {
	it("returns full file text when the inner org tool includes fileContent", async () => {
		const { OrgTool } = await import("../../src/tools/org");
		const tool = new OrgTool(createSession());
		const result = await tool.execute("call-1", {
			command: "update",
			id: "PLAN-008-org-section-level-editing",
			section: "Context",
			body: "Revised context.",
		});
		const text = result.content.find(content => content.type === "text")?.text ?? "";

		expect(text).toBe(`#+TITLE: Sectioned plan
#+STATE: ITEM
#+CUSTOM_ID: PLAN-008-org-section-level-editing

* Context
Revised context.
`);
		expect(text).not.toContain('"fileContent"');
		expect(createOrgToolMock).toHaveBeenCalledTimes(1);

		await tool.dispose();
	});
});
