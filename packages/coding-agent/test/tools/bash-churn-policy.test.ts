import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "@spell/pi-coding-agent/tools";
import { BashTool } from "@spell/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@spell/pi-coding-agent/tools/output-meta";

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

describe("bash context-pressure policy", () => {
	let testDir: string;
	let bashTool: BashTool;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-churn-policy-"));
		bashTool = wrapToolWithMetaNotice(new BashTool(createTestToolSession(testDir)));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps raw bash output inline when it fits the inline budget", async () => {
		const result = await bashTool.execute("call-small", { command: "printf 'hello world\n'" }, undefined, undefined, {
			hasUI: false,
		} as never);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const details = result.details as
			| { meta?: { contextPressure?: { category?: string; presentation?: string; persistence?: string } } }
			| undefined;

		expect(text).toContain("hello world");
		expect(details?.meta?.contextPressure?.category).toBe("other");
		expect(details?.meta?.contextPressure?.presentation).toBe("inline");
		expect(details?.meta?.contextPressure?.persistence).toBe("allow-raw");
	});

	it("marks bash output summary-first when it spills to an artifact", async () => {
		// Emit more bytes than the default inline bash spill budget so the executor
		// truncates and allocates an artifact.
		const result = await bashTool.execute(
			"call-large",
			{ command: "yes spell-context-pressure-test | head -n 20000" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		const details = result.details as
			| {
					meta?: {
						truncation?: { artifactUri?: string };
						contextPressure?: {
							category?: string;
							presentation?: string;
							persistence?: string;
							summary?: string;
						};
					};
			  }
			| undefined;

		const artifactUri = details?.meta?.truncation?.artifactUri;
		expect(artifactUri).toBeDefined();
		expect(details?.meta?.contextPressure?.category).toBe("other");
		expect(details?.meta?.contextPressure?.presentation).toBe("summary-first");
		expect(details?.meta?.contextPressure?.persistence).toBe("summary-only");
		if (artifactUri) {
			expect(details?.meta?.contextPressure?.summary).toContain(artifactUri);
		}
	});
});
