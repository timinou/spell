import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { createTools, StatusTool, type ToolSession } from "@spell/pi-coding-agent/tools";
import * as nativesModule from "@spell/pi-natives";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: Awaited<ReturnType<StatusTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("StatusTool", () => {
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("dispatches languages command via the kernel manage command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [
					{ locator: "typescript", rangeStart: 0, rangeEnd: 0, kind: "language", metadata: {}, diagnostics: [] },
				],
				diagnostics: [],
				done: true,
			} as any,
		]);
		const tool = new StatusTool();
		const result = await tool.execute("t", { command: "languages" });
		expect(getText(result)).toContain("typescript");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "languages" }));
	});

	for (const command of ["index", "watcherStatus", "lockStatus", "status"] as const) {
		it(`dispatches ${command} command`, async () => {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				{ nodes: [], diagnostics: [], done: true } as any,
			]);
			const tool = new StatusTool();
			await tool.execute("t", { command });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: command }));
		});
	}

	it("forwards the file argument as kernel target", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new StatusTool();
		await tool.execute("t", { command: "lockStatus", file: "src/main.ts" });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "manage", manage: "lockStatus", target: "src/main.ts" }),
		);
	});

	it("is registered in createTools; manage is not", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "status")).toBe(true);
		expect(tools.some(t => t.name === "manage")).toBe(false);
	});

	it("renderResult returns a structured component", () => {
		const tool = new StatusTool();
		const result: any = {
			content: [{ type: "text", text: "watcher: healthy" }],
			details: { command: "watcherStatus" },
		};
		const component = tool.renderResult(result, { expanded: false } as any, {} as any);
		expect(component).toBeDefined();
	});
});
