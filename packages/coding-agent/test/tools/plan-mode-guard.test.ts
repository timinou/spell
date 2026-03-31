import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforceModeWrite } from "@oh-my-pi/pi-coding-agent/tools/mode-guard";

function createSession(options?: {
	cwd?: string;
	settings?: Settings;
	planFilePath?: string;
	planModeEnabled?: boolean;
}): ToolSession {
	const planFilePath = options?.planFilePath ?? "PLAN.md";
	const planModeEnabled = options?.planModeEnabled ?? true;

	return {
		cwd: options?.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: options?.settings ?? Settings.isolated(),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => (planModeEnabled ? { type: "plan" as const, enabled: true, planFilePath } : undefined),
		getActiveModeState: () => (planModeEnabled ? { type: "plan" as const, enabled: true, planFilePath } : undefined),
	} as unknown as ToolSession;
}

describe("enforceModeWrite", () => {
	it("allows writes inside a configured folder", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./docs/plans": "Architecture notes and plan artifacts",
				},
			}),
		});

		expect(() => enforceModeWrite(session, "docs/plans/overview.md", { op: "create" })).not.toThrow();
	});

	it("allows writes inside nested subdirectories of a configured folder", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./docs/plans": "Architecture notes and plan artifacts",
				},
			}),
		});

		expect(() => enforceModeWrite(session, "docs/plans/archive/v1/overview.md", { op: "update" })).not.toThrow();
	});

	it("blocks writes outside configured folders", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./docs/plans": "Architecture notes and plan artifacts",
				},
			}),
		});

		expect(() => enforceModeWrite(session, "notes/todo.md", { op: "create" })).toThrow("configured allowed folders");
	});

	it("blocks deletes even inside configured folders", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./docs/plans": "Architecture notes and plan artifacts",
				},
			}),
		});

		expect(() => enforceModeWrite(session, "docs/plans/overview.md", { op: "delete" })).toThrow(
			"deleting files is not allowed",
		);
	});

	it("blocks moves even inside configured folders", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./docs/plans": "Architecture notes and plan artifacts",
				},
			}),
		});

		expect(() =>
			enforceModeWrite(session, "docs/plans/overview.md", {
				op: "update",
				move: "docs/plans/archive/overview.md",
			}),
		).toThrow("renaming files is not allowed");
	});

	it("allows plan file writes when allowedFolders is empty", () => {
		const session = createSession({ settings: Settings.isolated(), planFilePath: "PLAN.md" });

		expect(() => enforceModeWrite(session, "PLAN.md", { op: "update" })).not.toThrow();
	});

	it("does not treat matching prefixes as allowed folders without a separator boundary", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"./foo": "Allowed prefix",
				},
			}),
		});

		expect(() => enforceModeWrite(session, "foobar/notes.md", { op: "create" })).toThrow(
			"configured allowed folders",
		);
	});

	it("expands tilde-prefixed allowed folders", () => {
		const session = createSession({
			settings: Settings.isolated({
				"planMode.allowedFolders": {
					"~/shared-plans": "Cross-project plan output directory",
				},
			}),
		});

		expect(() =>
			enforceModeWrite(session, path.join(os.homedir(), "shared-plans", "notes.md"), { op: "create" }),
		).not.toThrow();
	});

	it("bypasses write restrictions when plan mode is disabled", () => {
		const session = createSession({ planModeEnabled: false });

		expect(() => enforceModeWrite(session, "notes/todo.md", { op: "create" })).not.toThrow();
	});
});
