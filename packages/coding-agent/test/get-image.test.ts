import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createTools, GetTool } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

function createSession(): any {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: { isolated: () => ({}) },
	};
}

function makeChunk(nodes: Array<{ locator: string; kind: string; content?: { kind: string; value?: string; mimeType?: string; artifactUri?: string; width?: number; height?: number } }>): any {
	return {
		nodes: nodes.map(n => ({
			locator: n.locator,
			rangeStart: 0,
			rangeEnd: 0,
			kind: n.kind,
			content: n.content,
			metadata: {},
			diagnostics: [],
		})),
		diagnostics: [],
		done: true,
	} as any;
}

describe("GetTool image blocks", () => {
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("returns an image content block when executeCodePath yields a ContentDto::Image with value", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{
					locator: "logo.png",
					kind: "file",
					content: {
						kind: "image",
						value: "iVBORw0KGgo=",
						mimeType: "image/png",
						width: 32,
						height: 32,
					},
				},
			]),
		]);

		const tool = new GetTool();
		const result = await tool.execute("t", { target: "logo.png" }, undefined, undefined, createSession());

		const imageBlocks = result.content.filter((c: any) => c.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			type: "image",
			data: "iVBORw0KGgo=",
			mimeType: "image/png",
		});
		expect(spy).toHaveBeenCalled();
	});

	it("returns an image content block for large images using artifactUri", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{
					locator: "huge.png",
					kind: "file",
					content: {
						kind: "image",
						artifactUri: "artifact://blobs/code-path/large.bin",
						mimeType: "image/png",
						width: 2048,
						height: 2048,
					},
				},
			]),
		]);

		const tool = new GetTool();
		const result = await tool.execute("t", { target: "huge.png" }, undefined, undefined, createSession());

		const imageBlocks = result.content.filter((c: any) => c.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({
			type: "image",
			data: "artifact://blobs/code-path/large.bin",
			mimeType: "image/png",
		});
		expect(spy).toHaveBeenCalled();
	});
});
