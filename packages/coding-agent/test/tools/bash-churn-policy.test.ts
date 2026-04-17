import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

function createTestToolSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string, extension?: string) => {
			const artifactDir = path.join(sessionDir, "main", toolType);
			fs.mkdirSync(artifactDir, { recursive: true });
			const ext = extension ?? "txt";
			const artifactPath = path.join(artifactDir, `0.${ext}`);
			return { id: "0", uri: `artifact://test-session/main/${toolType}/0.${ext}`, path: artifactPath };
		},
		settings,
	};
}

describe("bash churn policy", () => {
	let testDir: string;
	let bashTool: BashTool;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-churn-policy-"));
		bashTool = wrapToolWithMetaNotice(new BashTool(createTestToolSession(testDir)));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("returns digest-first output for pure wait commands", async () => {
		const result = await bashTool.execute("call-1", { command: "sleep 0.01" }, undefined, undefined, {
			hasUI: false,
		} as never);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const details = (result.details ?? {}) as { exitCode?: number };

		expect(text).toContain("low-signal status churn");
		expect(text).not.toContain("(no output)");
		expect(details.exitCode).toBe(0);
	});

	it("digests git inspection loops instead of returning raw status output", async () => {
		const result = await bashTool.execute(
			"call-2",
			{ command: "git init -q && touch tracked.txt && git status --short" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain("digest-first status output");
		expect(text).not.toContain("?? tracked.txt");
	});

	it("digests successful verification commands to compact summaries", async () => {
		const result = await bashTool.execute("call-3", { command: "bun test --help >/dev/null" }, undefined, undefined, {
			hasUI: false,
		} as never);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain("verification/build command");
		expect(text).not.toContain("Usage:");
	});
});
