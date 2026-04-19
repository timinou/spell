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
		fs.mkdirSync(path.join(testDir, ".spell/agent/sessions"), { recursive: true });
		fs.writeFileSync(path.join(testDir, ".spell/agent/sessions/recent.jsonl"), "one\ntwo\nthree\n");
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

	it("keeps truthful raw output for successful verification commands", async () => {
		const result = await bashTool.execute(
			"call-3",
			{ command: "bun test --help >/dev/null; printf 'verification-ok\n'" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const details = result.details as
			| { meta?: { contextPressure?: { category?: string; persistence?: string } } }
			| undefined;

		expect(text).toContain("verification-ok");
		expect(text).not.toContain("verification/build command");
		expect(details?.meta?.contextPressure?.category).toBe("verification");
		expect(details?.meta?.contextPressure?.persistence).toBe("summary-only");
	});

	it("bypasses summary suppression for transcript spelunking with head opt-in", async () => {
		const result = await bashTool.execute(
			"call-4",
			{ command: "cat ./.spell/agent/sessions/recent.jsonl", head: 2 },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const details = result.details as
			| { meta?: { contextPressure?: { category?: string; persistence?: string } } }
			| undefined;

		expect(text).toContain("one");
		expect(text).toContain("two");
		expect(text).not.toContain("Raw output suppressed");
		expect(text).not.toContain("low-signal status churn");
		expect(details?.meta?.contextPressure?.category).toBe("transcript-spelunking");
		expect(details?.meta?.contextPressure?.persistence).toBe("allow-raw");
	});

	it("keeps raw failure text for verification command errors", async () => {
		await expect(
			bashTool.execute(
				"call-5",
				{ command: "bun test --help >/dev/null; printf 'verification-failed\n' >&2; exit 1" },
				undefined,
				undefined,
				{ hasUI: false } as never,
			),
		).rejects.toThrow(/verification-failed[\s\S]*Command exited with code 1/u);
	});
});
