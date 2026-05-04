import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, GetTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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

function getText(result: Awaited<ReturnType<GetTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

function makeChunk(
	nodes: Array<{ locator: string; kind: string; content?: { text?: string } }>,
): any {
	return {
		nodes: nodes.map(n => ({
			locator: n.locator,
			rangeStart: 0,
			rangeEnd: 0,
			kind: n.kind,
			content: n.content ? { kind: "text", ...n.content } : undefined,
			metadata: {},
			diagnostics: [],
		})),
		diagnostics: [],
		done: true,
	} as any;
}

describe("GetTool", () => {
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("dispatches bare path target to executeCodePath", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts", kind: "file", content: { text: "export const x = 1;" } }]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "src/main.ts" });
		expect(getText(result)).toContain("src/main.ts");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "get", target: "src/main.ts" }));
	});

	it("dispatches glob target to executeCodePath", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{ locator: "a.ts", kind: "file" },
				{ locator: "b.ts", kind: "file" },
			]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "*.ts" });
		expect(getText(result)).toContain("a.ts");
		expect(getText(result)).toContain("b.ts");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "*.ts" }));
	});

	it("passes line slice params (offset/limit) to native", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts:1:1", kind: "line", content: { text: "line one" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "src/main.ts", offset: 5, limit: 10 });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ offset: 5, limit: 10 }));
	});

	it("passes regex grep target to native", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts:3:5", kind: "match", content: { text: "foo()" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "/foo.+/" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "/foo.+/" }));
	});

	it("passes code symbol target to native", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts::foo", kind: "function", content: { text: "function foo() {}" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "src/main.ts::foo" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "src/main.ts::foo" }));
	});

	it("handles memory:// URI scheme target", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "memory://root", kind: "resource", content: { text: "memory content" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "memory://root" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "memory://root" }));
	});

	it("handles artifact:// URI scheme target", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "artifact://sess/1", kind: "artifact", content: { text: "artifact content" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "artifact://sess/1" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "artifact://sess/1" }));
	});

	it("formats output as locations when format=locations", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{ locator: "a.ts:1:1", kind: "match" },
				{ locator: "b.ts:2:3", kind: "match" },
			]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "foo", format: "locations" });
		const text = getText(result);
		expect(text).toContain("a.ts:1:1");
		expect(text).toContain("b.ts:2:3");
	});

	it("formats output as tree when format=tree", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{ locator: "src/a.ts:1:1", kind: "function" },
				{ locator: "src/b.ts:2:3", kind: "class" },
			]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "src", format: "tree" });
		const text = getText(result);
		expect(text).toContain("src/a.ts");
		expect(text).toContain("src/b.ts");
	});

	it("includes image content blocks for image nodes", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [
					{
						locator: "img.png",
						rangeStart: 0,
						rangeEnd: 0,
						kind: "image",
						content: { kind: "image", value: "base64data", mimeType: "image/png", text: "an image" },
						metadata: {},
						diagnostics: [],
					},
				],
				diagnostics: [],
				done: true,
			} as any,
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "img.png" });
		const images = result.content.filter(c => c.type === "image");
		expect(images.length).toBe(1);
		expect((images[0] as any).mimeType).toBe("image/png");
	});

	it("returns suffix-fallback diagnostic when native returns diagnostics", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [{ locator: "x.ts", rangeStart: 0, rangeEnd: 0, kind: "file", metadata: {}, diagnostics: [] }],
				diagnostics: [
					{ variant: "suffix_fallback", message: "Resolved via suffix match", span: { start: 0, end: 0 } },
				],
				done: true,
			} as any,
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "x.ts" });
		expect(getText(result)).toContain("suffix_fallback");
		expect(getText(result)).toContain("Resolved via suffix match");
	});

	it("applies doc extraction format as node-list by default", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "doc.md", kind: "doc", content: { text: "# Hello\nWorld" } }]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "doc.md" });
		expect(getText(result)).toContain("# Hello");
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "get")).toBe(true);
	});
});
