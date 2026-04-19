import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { _resetSupportedExtensionsForTest, CodeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

const TEST_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"rs",
	"py",
	"html",
	"css",
	"typ",
	"md",
	"org",
]);

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "abc",
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "lsp.enabled": false }),
		...overrides,
	};
}

function getText(result: Awaited<ReturnType<CodeTool["execute"]>>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("code tool coordination wiring", () => {
	beforeEach(() => {
		_resetSupportedExtensionsForTest(TEST_EXTENSIONS);
	});

	afterEach(() => {
		_resetSupportedExtensionsForTest();
		try {
			spyOn(nativesModule, "executeCodeBuffer").mockRestore();
		} catch {}
	});

	it("every mutating code call includes session id", async () => {
		const file = "/tmp/test/src/example.ts";
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					status: "staged",
					saveMode: "staged",
					fileResults: [
						{
							file,
							status: "staged",
							version: 1,
							diff: "@@ value @@\n+export const value = 1;\n",
							editCount: 1,
							targets: [{ targetId: file, actions: ["write"] }],
							persisted: false,
							dirty: true,
						},
					],
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false })
			.mockReturnValueOnce({ output: { file, edits: [] }, error: false });
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const value = 1;\n" }] }],
		});
		expect(result.details).toEqual(expect.objectContaining({ kind: "file", command: "edit" }));
		expect(executeSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ command: "edit", sessionId: "abc" }));
		expect(executeSpy.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ command: "save", sessionId: "abc" }));
		executeSpy.mockRestore();
	});

	it("read only code calls do not require session id", async () => {
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		const tool = new CodeTool(createSession({ getSessionId: () => null }));
		await tool.execute("tool", { command: "outline", file: "src/example.ts" });
		expect(executeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "outline", file: "/tmp/test/src/example.ts" }),
		);
		expect(executeSpy.mock.calls[0]?.[0]).not.toHaveProperty("sessionId");
		executeSpy.mockRestore();
	});

	it("peer conflict surfaces as a retryable tool error", async () => {
		const file = "/tmp/test/src/conflict.ts";
		const peerConflict = {
			sessionId: "peerB",
			codePath: "src/conflict.ts::Foo.bar#body",
			peerRevision: 43,
			peerCommitTs: 1_745_000_000_000,
		};
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: { code: "PEER_CONFLICT", peerConflict, message: "peer conflict" },
				error: true,
			});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const value = 1;\n" }] }],
		});
		expect(result.details).toEqual(
			expect.objectContaining({
				kind: "error",
				failureKind: "peer_conflict",
				retryable: true,
				peerConflict,
			}),
		);
		expect(getText(result)).toContain("Peer session peerB committed src/conflict.ts::Foo.bar#body");
		expect(getText(result)).toContain("Retryable: yes");
		executeSpy.mockRestore();
	});

	it("peer activity footer renders when present", async () => {
		const file = "/tmp/test/src/activity.ts";
		const executeSpy = spyOn(nativesModule, "executeCodeBuffer")
			.mockReturnValueOnce({ output: [], error: false })
			.mockReturnValueOnce({
				output: {
					status: "staged",
					saveMode: "staged",
					fileResults: [
						{
							file,
							status: "staged",
							version: 1,
							diff: "@@ value @@\n+export const value = 2;\n",
							editCount: 1,
							targets: [{ targetId: file, actions: ["write"] }],
							persisted: false,
							dirty: true,
						},
					],
				},
				error: false,
			})
			.mockReturnValueOnce({ output: { success: true, version: 2 }, error: false })
			.mockReturnValueOnce({
				output: {
					file,
					edits: [
						{
							sessionId: "peer-session",
							revision: 5,
							codePaths: ["src/activity.ts::Server.handle"],
							ts: Date.now() - 12_000,
						},
					],
				},
				error: false,
			});
		const tool = new CodeTool(createSession());
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const value = 2;\n" }] }],
		});
		expect(getText(result)).toContain("Peer activity:");
		expect(getText(result)).toContain("src/activity.ts::Server.handle");
		expect(getText(result)).toContain("12s ago");
		expect(executeSpy.mock.calls[3]?.[0]).toEqual(expect.objectContaining({ command: "coord_peer_activity", file }));
		executeSpy.mockRestore();
	});
});
