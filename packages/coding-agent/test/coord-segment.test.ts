import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { getProjectDir, setProjectDir } from "@spell/pi-utils";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";
import * as coordModule from "../src/session/edit-coordinator";
import type { CodeEditDetails } from "../src/tools/code-result";
import { formatCodeToolContent } from "../src/tools/code-result";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setProjectDir(originalProjectDir);
	try {
		spyOn(coordModule, "coordStatus").mockRestore();
	} catch {}
	try {
		spyOn(coordModule, "openCodeBufferPaths").mockRestore();
	} catch {}
	try {
		spyOn(coordModule, "recentPeerActivity").mockRestore();
	} catch {}
});

function createContext(sessionId: string = "self-session", width: number = 120): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getSessionId: () => sessionId },
		} as unknown as SegmentContext["session"],
		width,
		options: {},
		planMode: null,
		auditMode: undefined,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentInfo: null,
		canvasTaskCount: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
	};
}

function makeEditDetails(peerActivity: CodeEditDetails["data"]["peerActivity"]): CodeEditDetails {
	return {
		kind: "file",
		command: "edit",
		file: "/tmp/project/src/server.ts",
		displayPath: "src/server.ts",
		rawOutput: {},
		data: {
			status: "applied",
			files: [],
			version: 2,
			diff: "@@ handle @@\n+return 1;\n",
			editCount: 1,
			targets: [{ targetId: "src/server.ts::Server.handle", actions: ["write"] }],
			mutationState: "applied",
			persisted: true,
			peerActivity,
		},
	};
}

describe("coord TUI surfaces", () => {
	it("coord segment renders zero peers silently", () => {
		spyOn(coordModule, "coordStatus").mockReturnValue({
			brokerUp: true,
			peers: [],
			socketPath: "/tmp/edit-broker.sock",
		});
		spyOn(coordModule, "openCodeBufferPaths").mockReturnValue([]);
		expect(renderSegment("coord", createContext("self-zero"))).toEqual({ content: "", visible: false });
	});

	it("coord segment renders peer count excluding self", () => {
		spyOn(coordModule, "coordStatus").mockReturnValue({
			brokerUp: true,
			peers: [{ sessionId: "self-two" }, { sessionId: "peer-a" }, { sessionId: "peer-b" }],
			socketPath: "/tmp/edit-broker.sock",
		});
		spyOn(coordModule, "openCodeBufferPaths").mockReturnValue([]);
		const rendered = renderSegment("coord", createContext("self-two"));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("coord: 2 peers");
	});

	it("coord segment renders last activity", () => {
		fs.mkdirSync("/tmp/project/src", { recursive: true });
		setProjectDir("/tmp/project");
		spyOn(coordModule, "coordStatus").mockReturnValue({
			brokerUp: true,
			peers: [{ sessionId: "peer-a" }],
			socketPath: "/tmp/edit-broker.sock",
		});
		spyOn(coordModule, "openCodeBufferPaths").mockReturnValue(["/tmp/project/src/foo.ts"]);
		spyOn(coordModule, "recentPeerActivity").mockReturnValue({
			file: "/tmp/project/src/foo.ts",
			edits: [
				{ sessionId: "peer-a", revision: 5, codePaths: ["src/foo.ts::Server.handle"], ts: Date.now() - 12_000 },
			],
		});
		const rendered = renderSegment("coord", createContext("self-activity"));
		expect(rendered.content).toContain("coord: 1 peer");
		expect(rendered.content).toContain("src/foo.ts 12s ago");
	});

	it("coord segment truncates long paths", () => {
		fs.mkdirSync("/tmp/project/src", { recursive: true });
		setProjectDir("/tmp/project");
		const longPath = `/tmp/project/${"deep/".repeat(20)}foo.ts`;
		spyOn(coordModule, "coordStatus").mockReturnValue({
			brokerUp: true,
			peers: [{ sessionId: "peer-a" }],
			socketPath: "/tmp/edit-broker.sock",
		});
		spyOn(coordModule, "openCodeBufferPaths").mockReturnValue([longPath]);
		spyOn(coordModule, "recentPeerActivity").mockReturnValue({
			file: longPath,
			edits: [
				{ sessionId: "peer-a", revision: 5, codePaths: ["src/foo.ts::Server.handle"], ts: Date.now() - 12_000 },
			],
		});
		const rendered = renderSegment("coord", createContext("self-long"));
		expect(rendered.content).toContain("coord: 1 peer");
		expect(rendered.content).not.toContain(longPath);
	});

	it("tool render includes peer activity block when present", () => {
		const text = formatCodeToolContent(
			makeEditDetails([
				{
					file: "/tmp/project/src/server.ts",
					displayPath: "src/server.ts",
					edits: [
						{
							sessionId: "peer-session",
							codePath: "src/server.ts::Server.dispatch",
							ageSeconds: 12,
							ts: Date.now() - 12_000,
						},
					],
				},
			]),
		);
		expect(text).toContain("Peer activity:");
		expect(text).toContain("src/server.ts::Server.dispatch");
		expect(text).toContain("12s ago");
	});

	it("tool render omits peer activity block when empty", () => {
		const text = formatCodeToolContent(makeEditDetails([]));
		expect(text).not.toContain("Peer activity:");
	});
});
