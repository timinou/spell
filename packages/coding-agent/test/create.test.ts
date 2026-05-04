import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CreateTool, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

const tmpDir = path.join(process.cwd(), "packages/coding-agent/test/tmp-create");

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: Awaited<ReturnType<CreateTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("CreateTool", () => {
	beforeEach(async () => {
		try {
			await fs.mkdir(tmpDir, { recursive: true });
		} catch {}
	});

	afterEach(async () => {
		try {
			await fs.rmdir(tmpDir, { recursive: true });
		} catch {}
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("creates a text file via executeCodePath", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "hello.txt", content: "hello world" });
		expect(getText(result)).toContain("Created");
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "edit",
				target: path.join(tmpDir, "hello.txt"),
				actions: expect.arrayContaining([expect.objectContaining({ kind: "create", content: "hello world" })]),
			}),
		);
	});

	it("creates from base64 content", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", {
			path: "b64.txt",
			content: { kind: "base64", data: Buffer.from("hello").toString("base64") },
		});
		expect(getText(result)).toContain("Created");
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].content).toBe("hello");
	});

	it("rejects creation when file exists without force", async () => {
		const existingFile = path.join(tmpDir, "exists.txt");
		await fs.writeFile(existingFile, "old", "utf-8");
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "exists.txt", content: "new" });
		expect(getText(result)).toContain("already exists");
		expect(getText(result)).toContain("force=true");
	});

	it("overwrites existing file when force=true", async () => {
		const existingFile = path.join(tmpDir, "force.txt");
		await fs.writeFile(existingFile, "old", "utf-8");
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new CreateTool(createSession());
		const result = await tool.execute("t", { path: "force.txt", content: "new", force: true });
		expect(getText(result)).toContain("Created");
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				actions: expect.arrayContaining([expect.objectContaining({ kind: "create", force: true })]),
			}),
		);
	});

	it("resolves artifact URI for bytes content", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{ nodes: [], diagnostics: [], done: true } as any,
		]);
		const tool = new CreateTool(
			createSession({
				internalRouter: {
					canHandle: (url: string) => url.startsWith("artifact://"),
					resolve: async () => ({ content: "artifact bytes", sourcePath: "artifact://x" }),
				} as any,
			}),
		);
		const result = await tool.execute("t", {
			path: "art.txt",
			content: { kind: "bytes", artifactUri: "artifact://x" },
		});
		expect(getText(result)).toContain("Created");
		const call = spy.mock.calls[0]?.[0] as any;
		expect(call.actions[0].content).toBe("artifact bytes");
	});

	it("returns error for unresolvable artifact URI", async () => {
		const tool = new CreateTool(
			createSession({
				internalRouter: {
					canHandle: () => false,
					resolve: async () => {
						throw new Error("no");
					},
				} as any,
			}),
		);
		const result = await tool.execute("t", {
			path: "fail.txt",
			content: { kind: "bytes", artifactUri: "artifact://missing" },
		});
		expect(getText(result)).toContain("Cannot resolve artifact URI");
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "create")).toBe(true);
	});
});
