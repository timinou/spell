import { describe, expect, it, spyOn } from "bun:test";
import { CodeTool } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

function createSession() {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "abc",
		getSessionSpawns: () => "*",
		settings: { get: () => undefined } as never,
	};
}

function getText(result: Awaited<ReturnType<CodeTool["execute"]>>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("code tool peer activity footer", () => {
	it("renders peer activity footer when present", async () => {
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
		const tool = new CodeTool(createSession() as never);
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

	it("omits peer activity footer when empty", async () => {
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
			.mockReturnValueOnce({ output: { file, edits: [] }, error: false });
		const tool = new CodeTool(createSession() as never);
		const result = await tool.execute("tool", {
			command: "edit",
			operations: [{ targetId: file, actions: [{ kind: "write", content: "export const value = 2;\n" }] }],
		});
		expect(getText(result)).not.toContain("Peer activity:");
		executeSpy.mockRestore();
	});
});
