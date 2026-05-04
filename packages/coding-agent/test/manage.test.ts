import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, ManageTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

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

function getText(result: Awaited<ReturnType<ManageTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("ManageTool", () => {
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("dispatches save command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "save", file: "src/main.ts" });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "manage", manage: "save", target: "src/main.ts" }),
		);
	});

	it("dispatches undo command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "undo", file: "src/main.ts" });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "manage", manage: "undo", target: "src/main.ts" }),
		);
	});

	it("dispatches redo command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "redo", file: "src/main.ts" });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "manage", manage: "redo", target: "src/main.ts" }),
		);
	});

	it("dispatches diff command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "diff", file: "src/main.ts" });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ command: "manage", manage: "diff", target: "src/main.ts" }),
		);
	});

	it("dispatches buffers command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [{ locator: "buf.ts", rangeStart: 0, rangeEnd: 0, kind: "buffer", metadata: {}, diagnostics: [] }],
				diagnostics: [],
				done: true,
			} as any,
		]);
		const tool = new ManageTool(createSession());
		const result = await tool.execute("t", { command: "buffers" });
		expect(getText(result)).toContain("buf.ts");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "buffers", target: "" }));
	});

	it("dispatches languages command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [
					{ locator: "typescript", rangeStart: 0, rangeEnd: 0, kind: "language", metadata: {}, diagnostics: [] },
				],
				diagnostics: [],
				done: true,
			} as any,
		]);
		const tool = new ManageTool(createSession());
		const result = await tool.execute("t", { command: "languages" });
		expect(getText(result)).toContain("typescript");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "languages" }));
	});

	it("dispatches index command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "index" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "index" }));
	});

	it("dispatches watcherStatus command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "watcherStatus" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "watcherStatus" }));
	});

	it("dispatches lockStatus command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "lockStatus" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "lockStatus" }));
	});

	it("dispatches status command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "status" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "status" }));
	});

	it("dispatches context command", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new ManageTool(createSession());
		await tool.execute("t", { command: "context" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "manage", manage: "context" }));
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "manage")).toBe(true);
	});
});
