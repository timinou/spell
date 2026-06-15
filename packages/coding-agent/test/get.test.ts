import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { createTools, GetTool, type ToolSession } from "@spell/pi-coding-agent/tools";
import { formatCodePathResult } from "@spell/pi-coding-agent/tools/codepath-result";
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

function getText(result: Awaited<ReturnType<GetTool["execute"]>>): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

function makeChunk(nodes: Array<{ locator: string; kind: string; content?: { text?: string } }>): any {
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

	it("dispatches bare path target (non-existent file passes through unchanged)", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "nonexistent-feat816", kind: "file", content: { text: "content" } }]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "nonexistent-feat816" });
		expect(getText(result)).toContain("nonexistent-feat816");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "get", target: "nonexistent-feat816" }));
	});

	it("auto-attaches #raw when target is a bare path to an existing file", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-raw");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "hello.txt");
		await fs.writeFile(real, "hi", "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: real, kind: "file", content: { text: "hi" } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: real });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("auto-attaches #outline (not #raw) for a bare code file", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-outline");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "mod.ts");
		await fs.writeFile(real, "export function foo() { return 1; }\n", "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: real, kind: "§outline", content: { text: `${real}  ·  outline (1 symbol)` } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: real });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#outline` }));
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("keeps #raw for a bare non-code text file (.json)", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-json");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "data.json");
		await fs.writeFile(real, '{"a":1}\n', "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: real, kind: "file", content: { text: '{"a":1}' } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: real });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("honors an explicit #raw on a code file (no outline override)", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-explicit-raw");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "mod.ts");
		await fs.writeFile(real, "export const x = 1;\n", "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: real, kind: "file", content: { text: "export const x = 1;" } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: `${real}#raw` });
			// Explicit qualifier is not bare-plain → passes through verbatim.
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("appends the teaching hint only once per (session, filetype)", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-hint");
		await fs.mkdir(tmp, { recursive: true });
		const a = nodePath.join(tmp, "a.ts");
		const b = nodePath.join(tmp, "b.ts");
		await fs.writeFile(a, "export const x = 1;\n", "utf-8");
		await fs.writeFile(b, "export const y = 2;\n", "utf-8");
		try {
			spyOn(nativesModule, "executeCodePath").mockImplementation(async (opts: any) => [
				makeChunk([
					{ locator: opts.target, kind: "§outline", content: { text: `${opts.target} · outline (1 symbol)` } },
				]),
			]);
			const sessionId = `sess-${Date.now()}`;
			const tool = new GetTool(createSession({ getSessionId: () => sessionId }));
			const first = getText(await tool.execute("t", { target: a }));
			const second = getText(await tool.execute("t", { target: b }));
			expect(first).toContain("outline shown");
			// Same session + same .ts extension → hint suppressed on the second read.
			expect(second).not.toContain("outline shown");
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("does not auto-attach #raw when content=false is set explicitly", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-noraw");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "hello.txt");
		await fs.writeFile(real, "hi", "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: real, kind: "file" }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: real, content: false });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: real }));
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
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

	it("passes line shorthand target unchanged to native", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts:1:1", kind: "line", content: { text: "line one" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "src/main.ts:5-15" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "src/main.ts:5-15" }));
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

	// Regression (adversarial test-drive): a bare `file::Symbol` read resolves to
	// a SINGLE AST node whose kind starts with `§` (e.g. §function_declaration)
	// and carries NO `content`. The scheme-node detector must not mistake it for a
	// kernel §<scheme> URI node — doing so routed it to renderSchemeNode, which
	// reads the absent content and emitted `[§empty] …` instead of the node label.
	it("renders bare symbol node label, not [§empty], for content-less AST node", async () => {
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "src/main.ts", kind: "§function_declaration" }]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "src/main.ts::alpha" });
		const text = getText(result);
		expect(text).not.toContain("[§empty]");
		expect(text).toContain("[§function_declaration]");
	});

	// Regression guard for the inverse: a genuine `scheme://` target whose single
	// node kind names that scheme (§<scheme>) MUST still route to the scheme
	// renderer (content body, no `[§kind]` label).
	it("still routes a real §<scheme> node to the scheme renderer", async () => {
		// Kernel scheme nodes carry content as `{ kind: "text", value }` — match that
		// shape directly (makeChunk's `text` helper field is not what renderSchemeNode
		// reads), so this exercises the real scheme-render path end to end.
		spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			{
				nodes: [
					{
						locator: "skill://coding",
						rangeStart: 0,
						rangeEnd: 0,
						kind: "§skill",
						content: { kind: "text", value: "# Coding" },
						metadata: {},
						diagnostics: [],
					},
				],
				diagnostics: [],
				done: true,
			} as any,
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "skill://coding" });
		const text = getText(result);
		expect(text).toContain("# Coding");
		expect(text).not.toContain("[§skill]");
	});

	// BUG: a binary `scheme://` URL (artifact/agent/…) that the kernel resolved
	// to a real on-disk file came back as `[§empty]` + a note saying "use
	// sourcePath-aware tools" — WITHOUT ever surfacing the resolved path. The
	// agent then scanned the filesystem (`find /`) and timed out. A URL that
	// resolved to a real file must behave like reading that file.
	it("surfaces the resolved fs path for a binary artifact:// URL (never path-less [§empty])", async () => {
		// Real PNG header so classifyFileForRead sniffs it as an image.
		const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const tmp = nodePath.join(process.cwd(), `packages/coding-agent/test/tmp-bug-artifact-${Date.now()}`);
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "410.png");
		await fs.writeFile(real, pngMagic);
		try {
			spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				{
					nodes: [
						{
							locator: "artifact://sess/main/generate_image/410.png",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "§artifact",
							content: { kind: "bytes", artifactUri: "artifact-bytes-pending://x", size: 8 },
							metadata: {
								source_path: real,
								notes: ["Binary artifact (png). Use sourcePath-aware tools to inspect it."],
							},
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				} as any,
			]);
			const tool = new GetTool();
			const result = await tool.execute("t", {
				target: "artifact://sess/main/generate_image/410.png",
			});
			// PNG magic → routed through the image reader → an image content block.
			const hasImage = result.content.some(c => c.type === "image");
			expect(hasImage).toBe(true);
			// And NEVER the dead-end marker.
			expect(getText(result)).not.toContain("[§empty]");
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	// Non-image binary (e.g. pdf, or a png that fails image-load): the textual
	// marker MUST name the concrete resolved path so the agent never has to hunt.
	it("names the resolved fs path for a non-image binary scheme node", async () => {
		const tmp = nodePath.join(process.cwd(), `packages/coding-agent/test/tmp-bug-bin-${Date.now()}`);
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "doc.pdf");
		// Non-UTF8, non-image bytes → classifyFileForRead returns "binary".
		await fs.writeFile(real, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
		try {
			spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				{
					nodes: [
						{
							locator: "artifact://sess/main/x/doc.pdf",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "§artifact",
							content: { kind: "bytes", artifactUri: "artifact-bytes-pending://x", size: 5 },
							metadata: { source_path: real, notes: ["Binary artifact (pdf)."] },
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				} as any,
			]);
			const tool = new GetTool();
			const result = await tool.execute("t", { target: "artifact://sess/main/x/doc.pdf" });
			const text = getText(result);
			expect(text).toContain(real);
			expect(text).not.toContain("[§empty]");
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
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

	describe("target-rewrite", () => {
		afterEach(() => {
			try {
				(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
			} catch {}
		});

		// T1.1: bare path → existing directory → #listing
		it("auto-attaches #listing when target is a bare path to an existing directory", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-dir");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp });
				// BUG-380: bare dir target self-roots to itself; root-equal
				// case collapses to `.` (kernel can't address `<root>#listing`).
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.2: trailing-slash → #listing (normalized)
		it("normalizes trailing slash and auto-attaches #listing", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-trailing");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: `${tmp}/` });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.3: absolute path to existing directory
		it("auto-attaches #listing for absolute path to directory", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-absdir");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.4: recursive: true + bare dir → #tree
		it("auto-attaches #tree when recursive=true for a directory", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-recursive");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, recursive: true });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.5: depth: 2 + bare dir → #tree[depth=2]
		it("auto-attaches #tree[depth=N] when depth is set", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-depth");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, depth: 2 });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree[depth=2]", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.6: recursive: true + depth: 3 → depth wins
		it("depth wins when both recursive=true and depth are set", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-both");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, recursive: true, depth: 3 });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree[depth=3]", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.7: content: false + bare dir → unchanged at the qualifier level, but
		// still self-roots and addresses root via `.` (kernel quirk, BUG-380).
		it("does not auto-attach when content=false for a directory", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-nocontent");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, content: false });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.8: bare path → existing file → #raw (existing behavior preserved)
		it("auto-attaches #raw when target is an existing file", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-file");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "hello.txt");
			await fs.writeFile(real, "hi", "utf-8");
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: "hi" } }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: real });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.9: FEAT-711 — non-existent bare path returns PATH_NOT_FOUND
		// at the TS layer (no kernel call) so the agent gets an
		// actionable error instead of generic "Inaccessible: ENOENT".
		it("returns PATH_NOT_FOUND for non-existent paths without invoking kernel", async () => {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: "nonexistent", kind: "file" }]),
			]);
			const tool = new GetTool();
			const result = await tool.execute("t", { target: "./nonexistent/path" });
			expect(spy).not.toHaveBeenCalled();
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("PATH_NOT_FOUND");
			expect(text).toContain("./nonexistent/path");
		});

		// T1.10: already-qualified target → unchanged
		it("does not modify already-qualified targets", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-qual");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: `${tmp}#tree[depth=1]` });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree[depth=1]", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.11: recursive: true + already-qualified target → unchanged (caller's qualifier wins)
		it("preserves caller's qualifier when recursive=true on already-qualified target", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-qual-rec");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: `${tmp}#listing`, recursive: true });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.12: depth: 5 + recursive: false → #tree[depth=5] (depth implies tree)
		it("depth implies #tree even when recursive=false", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-depth-no-rec");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, depth: 5, recursive: false });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree[depth=5]", root: tmp }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

	it("is registered in createTools", async () => {
		const tools = await createTools(createSession());
		expect(tools.some(t => t.name === "get")).toBe(true);
	});

	describe("fs-listing render", () => {
		const makeNode = (locator: string, kind: string, text?: string) => ({
			locator,
			rangeStart: 0,
			rangeEnd: 0,
			kind,
			content: text ? { kind: "text", text } : undefined,
			metadata: {},
			diagnostics: [],
		});

		// T2.1: only §file + §dir nodes, format unset → fs-listing layout
		it("auto-promotes to fs-listing layout when all nodes are fs nodes (format unset)", () => {
			const chunks = [
				{
					nodes: [
						makeNode("specs/README.md", "file", undefined),
						makeNode("specs/plan.md", "file", undefined),
						makeNode("specs/subdir", "dir", undefined),
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).not.toContain("  [file]");
			expect(result.text).not.toContain("  [dir]");
			expect(result.text).toContain("specs/README.md");
			expect(result.text).toContain("specs/plan.md");
			expect(result.text).toContain("specs/subdir/");
		});

		// T2.2: same nodes, format: "node-list" explicit → existing node-list shape
		it("honors explicit format even when all nodes are fs nodes", () => {
			const chunks = [
				{
					nodes: [makeNode("specs/README.md", "file", "content")],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, { format: "node-list" });
			expect(result.text).toContain("  [file]");
			expect(result.text).toContain("specs/README.md");
		});

		// T2.3: mixed §file + §symbol node → falls back to existing node-list
		it("falls back to node-list when nodes are mixed fs and non-fs", () => {
			const chunks = [
				{
					nodes: [
						makeNode("src/server.ts", "file", undefined),
						makeNode("src/server.ts", "symbol", "handleRequest"),
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("  [file]");
			expect(result.text).toContain("  [symbol]");
		});

		// T2.4: §stat node from #stat qualifier → metadata rendered
		it("renders metadata for §stat nodes", () => {
			const chunks = [
				{
					nodes: [
						{
							locator: "specs",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "stat",
							content: undefined,
							metadata: { size: 4096, mtime: "2026-01-15T10:30:00Z" },
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("size=4096");
			expect(result.text).toContain("2026-01-15T10:30:00Z");
		});

		// T2.5: single §dir with no children → degenerate hint
		it("emits degenerate-result hint when only a single §dir node is returned", () => {
			const chunks = [
				{
					nodes: [makeNode("specs", "dir", undefined)],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("specs/");
			expect(result.text).toContain("hint");
		});

		// T2.6: §file + §symlink nodes → fs-listing layout
		it("auto-promotes mixed §file + §symlink nodes to fs-listing", () => {
			const chunks = [
				{
					nodes: [makeNode("lib", "symlink", undefined), makeNode("lib/foo.ts", "file", undefined)],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).not.toContain("  [file]");
			expect(result.text).not.toContain("  [symlink]");
		});

		// T2.7: empty dir → placeholder
		it("renders placeholder for empty directory", () => {
			const chunks = [
				{
					nodes: [],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("(no entries)");
		});

		// T2.8: §stat node with metadata kind
		it("renders stat kind for stat nodes", () => {
			const chunks = [
				{
					nodes: [
						{
							locator: "specs",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "stat",
							content: undefined,
							metadata: { size: 0, mtime: "2026-01-15T10:30:00Z", kind: "§dir" },
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("kind=§dir");
		});

		// T2.9: §stat node for file with size
		it("renders metadata for §stat on file", () => {
			const chunks = [
				{
					nodes: [
						{
							locator: "package.json",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "stat",
							content: undefined,
							metadata: { size: 2048, mtime: "2026-01-15T10:30:00Z", kind: "§file" },
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			expect(result.text).toContain("size=2048");
			expect(result.text).toContain("kind=§file");
		});

		// ── §-prefixed kinds (the REAL kernel output) ──────────────────────
		// The kernel emits §file/§dir/§symlink, not bare file/dir/symlink. These
		// guard the prefix-aware FS_KINDS gate so live #tree output no longer
		// falls through to the flat `[§dir]` node-list dump (the reported bug).
		const makeFsNode = (
			locator: string,
			kind: string,
			depth: number,
			name: string,
			rangeEnd = 0,
		) => ({
			locator,
			rangeStart: 0,
			rangeEnd,
			kind,
			content: undefined,
			metadata: { depth, name },
			diagnostics: [],
		});

		it("auto-promotes §-prefixed fs nodes (real kernel kinds) to fs-listing", () => {
			const chunks = [
				{
					nodes: [
						makeNode("specs/README.md", "§file", undefined),
						makeNode("specs/subdir", "§dir", undefined),
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			// Must NOT be the flat node-list `[§dir]` shape from the bug report.
			expect(result.text).not.toContain("[§dir]");
			expect(result.text).not.toContain("[§file]");
		});

		it("renders an indented tree from depth metadata (#tree)", () => {
			const chunks = [
				{
					nodes: [
						makeFsNode("pkg", "§dir", 0, "pkg"),
						makeFsNode("pkg/src", "§dir", 1, "src"),
						makeFsNode("pkg/src/main.ts", "§file", 2, "main.ts", 1024),
						makeFsNode("pkg/readme.md", "§file", 1, "readme.md", 512),
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			const lines = result.text.split("\n");
			// Base dir at depth 0, no indent, basename + trailing slash.
			expect(lines[0]).toBe("pkg/");
			// depth-1 dir indented one level, basename only (no repeated path).
			expect(lines).toContain("  src/");
			// depth-2 file indented two levels, basename + size.
			expect(lines.some(l => l.startsWith("    main.ts") && l.includes("1.0K"))).toBe(true);
			// Full path must NOT repeat on child rows.
			expect(result.text).not.toContain("pkg/src/main.ts");
		});

		it("indents a #listing relative to its depth-1 children", () => {
			const chunks = [
				{
					nodes: [
						makeFsNode("src/a.rs", "§file", 1, "a.rs", 100),
						makeFsNode("src/b", "§dir", 1, "b"),
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			const lines = result.text.split("\n");
			// Children-only listing: min depth is 1, so they anchor at zero indent.
			expect(lines).toContain("a.rs  100B");
			expect(lines).toContain("b/");
		});

		it("surfaces §inaccessible entries inline within a tree", () => {
			const chunks = [
				{
					nodes: [
						makeFsNode("dir", "§dir", 0, "dir"),
						{
							locator: "dir/locked",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "§inaccessible",
							content: undefined,
							metadata: {},
							diagnostics: [{ variant: "inaccessible", message: "permission denied" }],
						},
					],
					diagnostics: [],
					done: true,
				},
			];
			const result = formatCodePathResult(chunks as any, {});
			// One inaccessible entry must not demote the tree to node-list.
			expect(result.text).toContain("dir/");
			expect(result.text).toContain("inaccessible");
		});
	});

	// ─────────────────────────────────────────────────────────────
	// PLAN-306 (supersedes FEAT-713): bare reads of outline-capable code files
	// default to #outline (symbol-first map), steering edits toward symbol scopes.
	// Non-code text (.json, .txt, unknown) still defaults to #raw.
	// ─────────────────────────────────────────────
	describe("PLAN-306: bare-file default qualifier (symbol-first)", () => {
		for (const [ext, name, body] of [
			["ts", "sample.ts", "export const x = 1;\n"],
			["md", "NOTES.md", "# title\n"],
			["rs", "lib.rs", "fn main() {}\n"],
		] as const) {
			it(`auto-attaches #outline for bare .${ext} path`, async () => {
				const tmp = nodePath.join(process.cwd(), `packages/coding-agent/test/tmp-plan306-${ext}`);
				await fs.mkdir(tmp, { recursive: true });
				const real = nodePath.join(tmp, name);
				await fs.writeFile(real, body, "utf-8");
				try {
					const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
						makeChunk([{ locator: real, kind: "§outline", content: { text: `${real} · outline` } }]),
					]);
					const tool = new GetTool();
					await tool.execute("t", { target: real });
					expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#outline` }));
				} finally {
					await fs.rm(tmp, { recursive: true });
				}
			});
		}
	});

	// ─────────────────────────────────────────────────────────────
	// FEAT-720: line-shorthand targets pass through to kernel; the
	// agent no longer applies any post-slicing.
	// ─────────────────────────────────────────────────────────────
	describe("FEAT-720: line shorthand passthrough", () => {
		it.each([
			["foo.ts:50", "head N"],
			["foo.ts:-50", "tail N"],
			["foo.ts:80-130", "range A-B"],
			["foo.ts:80-", "A to EOF"],
			["foo.ts:80+50", "A+N"],
			["foo.ts::Sym:80-90", "absolute slice within symbol"],
			["foo.ts::Sym:±5", "symbol ±5"],
			["foo.ts#stat", "#stat qualifier"],
		])("forwards %s (%s) to kernel unchanged", async (target: string) => {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: target, kind: "file", content: { text: "x" } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target }));
		});

		it("renders grep shape for §line[text~=...] results", async () => {
			spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([
					{ locator: "src/a.ts:12:1", kind: "line", content: { text: "// TODO fix" } },
					{ locator: "src/b.ts:34:1", kind: "line", content: { text: "const x = TODO();" } },
				]),
			]);
			const tool = new GetTool();
			const result = await tool.execute("t", { target: '**/*.ts::§line[text~="TODO"]' });
			const text = getText(result);
			expect(text).toContain("TODO");
		});

		it("slices target body when kernel returns shape: 'slice' §line node", async () => {
			// FEAT-716/715: kernel returns a single sliced body for `path:A-B`.
			// We assert the agent surfaces it verbatim (no second-pass slicing).
			spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				{
					nodes: [
						{
							locator: "src/server.ts::<line 80..130>",
							rangeStart: 0,
							rangeEnd: 0,
							kind: "§line",
							content: { kind: "text", value: "line 80\nline 81\nline 82" },
							metadata: { shape: "slice", lineStart: 80, lineEnd: 130 },
							diagnostics: [],
						},
					],
					diagnostics: [],
					done: true,
				} as unknown as ReturnType<typeof makeChunk>,
			]);
			const tool = new GetTool();
			const result = await tool.execute("t", { target: "src/server.ts:80-130" });
			const text = getText(result);
			expect(text).toContain("line 80");
			expect(text).toContain("line 82");
		});

		// BUG-442 (PLAN-332 Thesis B): a line-slice on an ABSOLUTE path must read
		// the same lines as the relative form — previously the absolute slice was
		// misclassified bare-plain, hit the literal fs.stat fast-path on
		// `…foo.ts:5-7`, and returned PATH_NOT_FOUND before the kernel could strip
		// the slice. This exercises the REAL kernel (no executeCodePath mock).
		it("reads a line slice from an absolute path (no PATH_NOT_FOUND)", async () => {
			(spyOn(nativesModule, "executeCodePath") as unknown as { mockRestore?: () => void }).mockRestore?.();
			const tmp = nodePath.join(process.cwd(), "test/tmp-bug442-slice");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "lines.ts");
			await fs.writeFile(real, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n", "utf-8");
			try {
				const tool = new GetTool();
				const absResult = await tool.execute("t", { target: `${real}:2-3` });
				const absText = getText(absResult);
				expect(absText).not.toContain("PATH_NOT_FOUND");
				expect(absText).toContain("const b = 2;");
				expect(absText).toContain("const c = 3;");
				expect(absText).not.toContain("const a = 1;");
				expect(absText).not.toContain("const d = 4;");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("#stat qualifier surfaces lineCount metadata", async () => {
			// Real kernel; #stat should expose lineCount per FEAT-717.
			(spyOn(nativesModule, "executeCodePath") as unknown as { mockRestore?: () => void }).mockRestore?.();
			const tmp = nodePath.join(process.cwd(), "test/tmp-feat720-stat");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "f.txt");
			await fs.writeFile(real, "a\nb\nc\n", "utf-8");
			try {
				const tool = new GetTool();
				const result = await tool.execute("t", { target: `${real}#stat` });
				const text = getText(result);
				expect(text).toContain("lineCount");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

	// ─────────────────────────────────────────────────────────────
	// FEAT-720: schema rejects removed pagination params.
	// ─────────────────────────────────────────────────────────────
	describe("FEAT-720: schema removed pagination fields", () => {
		it("getSchema rejects head, tail, offset, limit (additionalProperties: false)", async () => {
			const { Value } = await import("@sinclair/typebox/value");
			const { getSchema } = await import("@spell/pi-coding-agent/tools/codepath-types");
			expect(Value.Check(getSchema, { target: "x" })).toBe(true);
			expect(Value.Check(getSchema, { target: "x", head: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", tail: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", offset: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", limit: 5 })).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────

	// ─────────────────────────────────────────────────────────────
	// FEAT-714: enriched §no-results diagnostic with reason + try-next
	// ─────────────────────────────────────────────────────────────
	describe("FEAT-714: enriched §no-results", () => {
		it("includes attached qualifier when kernel returns empty for bare path", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat714-attached");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "empty.txt");
			await fs.writeFile(real, "", "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([makeChunk([])]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real });
				const text = getText(result);
				expect(text).toContain("§no-results");
				expect(text).toContain("attached:");
				expect(text).toContain("#raw");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("emits try-next hint pointing to a different qualifier", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat714-trynext");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "empty.txt");
			await fs.writeFile(real, "", "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([makeChunk([])]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real });
				const text = getText(result);
				expect(text).toContain("try next:");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

	// FEAT-815 "JS-preferred scheme preempt" block removed by PLAN-310. All
	// schemes it covered (jobs, memory, pi) are kernel-owned; behavior is
	// covered by Rust integration tests in crates/pi-natives/tests/:
	//   scheme_e2e_w4.rs        — forwards-suffix + pi-virtual
	//   scheme-bridge-e2e.test  — jobs callback bridge (TS-side)

	it("falls through to kernel for unknown scheme", async () => {
		const { InternalUrlRouter } = await import("@spell/pi-coding-agent/internal-urls");
		const router = new InternalUrlRouter();
		// nope:// is not registered, so router.canHandle returns false.

		const kernelSpy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([
				{ locator: "nope://x", kind: "text", content: { text: "[§error] Unknown locator scheme 'nope'" } },
			]),
		]);
		const tool = new GetTool(createSession({ internalRouter: router }));
		const result = await tool.execute("t", { target: "nope://x" });
		expect(kernelSpy).toHaveBeenCalledWith(expect.objectContaining({ target: "nope://x" }));
		expect(getText(result)).toContain("Unknown locator scheme");
	});
	it("surfaces resource.notes as [note] lines in output", async () => {
		const { InternalUrlRouter } = await import("@spell/pi-coding-agent/internal-urls");
		const router = new InternalUrlRouter();
		router.register({
			scheme: "stub",
			async resolve() {
				return {
					url: "stub://x.png",
					content: "",
					contentType: "text/plain" as const,
					sourcePath: "/tmp/x.png",
					notes: ["Binary artifact (png)"],
				};
			},
		});

		const kernelSpy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);
		const tool = new GetTool(createSession({ internalRouter: router }));
		const result = await tool.execute("t", { target: "stub://x.png" });

		expect(kernelSpy).not.toHaveBeenCalled();
		expect(getText(result)).toContain("[note] Binary artifact (png)");
	});
});

// ─────────────────────────────────────────────────────────────
// FEAT-816: absolute targets outside session cwd self-root via
// effectiveRoot computation — no OUT_OF_PROJECT_ROOT wall.
// ─────────────────────────────────────────────────────────────
describe("FEAT-816: absolute targets self-root", () => {
	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("reads an absolute file outside session cwd", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-read-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		const real = nodePath.join(outsideRoot, "out.txt");
		await fs.writeFile(real, "hello world\n", "utf-8");
		try {
			const tool = new GetTool();
			const result = await tool.execute("t", { target: real });
			const text = getText(result);
			expect(text).toContain("hello world");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("lists an absolute directory outside session cwd", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-list-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "a.txt"), "", "utf-8");
		await fs.writeFile(nodePath.join(outsideRoot, "b.txt"), "", "utf-8");
		try {
			const tool = new GetTool();
			const result = await tool.execute("t", { target: outsideRoot });
			const text = getText(result);
			expect(text).toContain("a.txt");
			expect(text).toContain("b.txt");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("trees an absolute directory outside session cwd with #tree", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-tree-${Date.now()}-${Math.random()}`);
		await fs.mkdir(nodePath.join(outsideRoot, "a", "b"), { recursive: true });
		const leaf = nodePath.join(outsideRoot, "a", "b", "leaf.txt");
		await fs.writeFile(leaf, "", "utf-8");
		try {
			const tool = new GetTool();
			const result = await tool.execute("t", { target: `${outsideRoot}#tree` });
			const text = getText(result);
			expect(text).toContain("leaf.txt");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("walks an absolute glob outside session cwd", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-glob-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "a.ts"), "", "utf-8");
		await fs.writeFile(nodePath.join(outsideRoot, "b.ts"), "", "utf-8");
		await fs.writeFile(nodePath.join(outsideRoot, "c.md"), "", "utf-8");
		try {
			const tool = new GetTool();
			const result = await tool.execute("t", { target: `${outsideRoot}/*.ts` });
			const text = getText(result);
			expect(text).toContain("a.ts");
			expect(text).toContain("b.ts");
			expect(text).not.toContain("c.md");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("applies grep qualifier to an absolute path outside session cwd", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-grep-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "notes.txt"), "TODO: fix me\n", "utf-8");
		try {
			const tool = new GetTool();
			const result = await tool.execute("t", {
				target: `${outsideRoot}/*.txt::§line[text~="TODO"]`,
			});
			const text = getText(result);
			expect(text).toContain("TODO");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("explicit root: override still wins over auto-root", async () => {
		const outDir = nodePath.join("/tmp", `spell-feat816-root-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outDir, { recursive: true });
		const absFile = nodePath.join(outDir, "x.txt");
		await fs.writeFile(absFile, "data", "utf-8");
		const otherDir = nodePath.join("/tmp", `spell-feat816-other-${Date.now()}-${Math.random()}`);
		await fs.mkdir(otherDir, { recursive: true });
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: absFile, kind: "file", content: { text: "data" } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: absFile, root: otherDir });
			expect(spy).toHaveBeenCalledWith(
				expect.objectContaining({ command: "get", target: `${absFile}#raw`, root: otherDir }),
			);
		} finally {
			await fs.rm(outDir, { recursive: true });
			await fs.rm(otherDir, { recursive: true });
		}
	});

	it("relative bare glob still scoped to session cwd", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "nonexistent-feat816-marker", kind: "file" }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "**/*.nonexistent-feat816-marker" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ root: process.cwd() }));
	});

	// BUG-473: a relative `../` target that ESCAPES cwd must WIDEN the walker root
	// to a dir that contains it (the kernel can't climb above its own root), so
	// the file actually resolves. Previously it was pinned to `root=cwd` and the
	// escaping target silently matched nothing. We assert the widened root is an
	// ancestor of cwd and the target was absolutized — the shape the absolute-
	// target machinery then resolves correctly (proven end-to-end by the real-
	// kernel invariance suite below).
	it("relative path with ../ widens root to resolve an escaping target", async () => {
		const relPath = `../spell-feat816-relative-${Date.now()}-${Math.random()}.txt`;
		const absPath = nodePath.resolve(process.cwd(), relPath);
		await fs.writeFile(absPath, "relative test\n", "utf-8");
		try {
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
				makeChunk([{ locator: absPath, kind: "file", content: { text: "relative test\n" } }]),
			]);
			const tool = new GetTool();
			await tool.execute("t", { target: relPath });
			const call = spy.mock.calls[0][0] as { root: string; target: string };
			// Root widened to an ancestor of cwd (parent dir holding the escaped file),
			// NOT pinned to the too-narrow cwd (the pre-BUG-473 behaviour).
			const parent = nodePath.dirname(process.cwd());
			expect(call.root).toBe(parent);
			expect(call.root).not.toBe(process.cwd());
			// Target was absolutized then re-relativized under the WIDENED root, so it
			// no longer carries a `../` escape and resolves under that root.
			const locator = call.target.split("#")[0];
			expect(locator.startsWith("..")).toBe(false);
			expect(nodePath.resolve(call.root, locator)).toBe(absPath);
		} finally {
			await fs.rm(absPath, { force: true });
		}
	});

	it("gitignore: false still works for in-root gitignored files", async () => {
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "gitignored.txt", kind: "file", content: { text: "ignored" } }]),
		]);
		const tool = new GetTool();
		await tool.execute("t", { target: "gitignored.txt", gitignore: false });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ gitignore: false }));
	});

	it("find tool surfaces same absolute-target reads", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-find-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "listed.txt"), "", "utf-8");
		try {
			const { FindTool } = await import("@spell/pi-coding-agent/tools");
			const findTool = new FindTool();
			const result = await findTool.execute("t", { target: outsideRoot });
			const text = getText(result);
			expect(text).toContain("listed.txt");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("find tool auto-roots absolute target even when session.cwd is set", async () => {
		// Regression: session.cwd must NOT clobber auto-root for absolute
		// targets. Otherwise find from a spell session would re-introduce
		// the OUT_OF_PROJECT_ROOT wall this BUG-379 deletes.
		const outsideRoot = nodePath.join("/tmp", `spell-feat816-findses-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "anchored.txt"), "", "utf-8");
		try {
			const { FindTool } = await import("@spell/pi-coding-agent/tools");
			const findTool = new FindTool(createSession({ cwd: process.cwd() }));
			const result = await findTool.execute("t", { target: outsideRoot });
			const text = getText(result);
			expect(text).toContain("anchored.txt");
			expect(text).not.toContain("OUT_OF_PROJECT_ROOT");
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("find tool anchors relative target to session.cwd", async () => {
		// The auto-root opt-out for absolute targets must NOT regress
		// the relative-path case: relative targets still resolve against
		// session.cwd, not process.cwd().
		const { FindTool } = await import("@spell/pi-coding-agent/tools");
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([makeChunk([])]);
		const findTool = new FindTool(createSession({ cwd: "/tmp" }));
		await findTool.execute("t", { target: "relative/path.ts" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ root: "/tmp" }));
	});
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-380: absolute target equal to walker root must list/tree the root,
// not silently return [§no-results]. Original repro:
//   session.cwd === process.cwd() === /abs/repo
//   find { target: "/abs/repo/#tree" } → [§no-results]   (was)
//                                       → tree of /abs/repo  (now)
// ───────────────────────────────────────────────────────────────────────────
describe("BUG-380: absolute target equal to root", () => {
	// The kernel walker treats `target` as a path inside `root`. When `target`
	// resolves to the root itself, the kernel returns []. The TS layer must map
	// the root-equal case to `.` + suffix so the kernel resolves to root.
	// These tests assert the conversion at the kernel boundary directly
	// (kernel-path-specific quirks are not hermetically reproducible).

	afterEach(() => {
		try {
			(spyOn(nativesModule, "executeCodePath") as any).mockRestore?.();
		} catch {}
	});

	it("converts bare absolute target equal to root into '.'", async () => {
		// Bare dir target auto-attaches `#listing`. The kernel rejects
		// `.#listing` ("Not a directory"), so the root-equal mapping collapses
		// to plain `.` which produces the same listing.
		const outsideRoot = nodePath.join("/tmp", `spell-bug380-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "alpha.txt", kind: "file", content: { text: "" } }]),
		]);
		try {
			const tool = new GetTool();
			await tool.execute("t", { target: outsideRoot });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".", root: outsideRoot }));
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("converts qualified absolute target equal to root into '.#tree'", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-bug380-tree-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "leaf.txt", kind: "file", content: { text: "" } }]),
		]);
		try {
			const tool = new GetTool();
			await tool.execute("t", { target: `${outsideRoot}#tree` });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree", root: outsideRoot }));
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("converts trailing-slash absolute target equal to root into '.'", async () => {
		const outsideRoot = nodePath.join("/tmp", `spell-bug380-slash-${Date.now()}-${Math.random()}`);
		await fs.mkdir(outsideRoot, { recursive: true });
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "x.txt", kind: "file", content: { text: "" } }]),
		]);
		try {
			const tool = new GetTool();
			await tool.execute("t", { target: `${outsideRoot}/#tree` });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: ".#tree", root: outsideRoot }));
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});

	it("sub-path under explicit root still converts to relative, not '.'", async () => {
		// Regression: don't break the FEAT-816 non-equal case. With an
		// explicit `root:` that anchors above the target, the relative path
		// must be non-empty.
		const outsideRoot = nodePath.join("/tmp", `spell-bug380-sub-${Date.now()}-${Math.random()}`);
		await fs.mkdir(nodePath.join(outsideRoot, "sub"), { recursive: true });
		await fs.writeFile(nodePath.join(outsideRoot, "sub", "x.txt"), "", "utf-8");
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: "sub/x.txt", kind: "file", content: { text: "" } }]),
		]);
		try {
			const tool = new GetTool();
			await tool.execute("t", { target: `${outsideRoot}/sub`, root: outsideRoot });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: "sub#listing", root: outsideRoot }));
		} finally {
			await fs.rm(outsideRoot, { recursive: true });
		}
	});
});

describe("GetTool bare-path content routing (images / binaries)", () => {
	// 1×1 transparent PNG.
	const PNG_1X1 = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f9c0000000049454e44ae426082",
		"hex",
	);

	it("returns an image content block (not a #raw text dump) for a bare image path", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-img");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "dot.png");
		await fs.writeFile(real, PNG_1X1);
		// Spy asserts we never round-trip the kernel with a #raw target for images.
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);
		try {
			const tool = new GetTool(createSession());
			const result = await tool.execute("t", { target: real });
			const imageBlocks = result.content.filter(c => c.type === "image");
			expect(imageBlocks).toHaveLength(1);
			expect(imageBlocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
			expect((imageBlocks[0] as { data: string }).data.length).toBeGreaterThan(0);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			(spy as any).mockRestore?.();
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("emits a text marker (no image, no mojibake) for a bare non-image binary path", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-bin");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "blob.bin");
		// NUL byte + non-UTF8 bytes → binary sniff.
		await fs.writeFile(real, Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00]));
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);
		try {
			const tool = new GetTool(createSession());
			const result = await tool.execute("t", { target: real });
			expect(result.content.filter(c => c.type === "image")).toHaveLength(0);
			expect(getText(result)).toContain("binary file");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			(spy as any).mockRestore?.();
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("respects images.blockImages — marker instead of image block", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-img-block");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "dot.png");
		await fs.writeFile(real, PNG_1X1);
		const settings = Settings.isolated({ "images.blockImages": true });
		try {
			const tool = new GetTool(createSession({ settings }));
			const result = await tool.execute("t", { target: real });
			expect(result.content.filter(c => c.type === "image")).toHaveLength(0);
			expect(getText(result)).toContain("image submission disabled");
		} finally {
			await fs.rm(tmp, { recursive: true });
		}
	});

	it("still reads a UTF-8 text file as #raw text (no false-positive binary marker)", async () => {
		const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-txt");
		await fs.mkdir(tmp, { recursive: true });
		const real = nodePath.join(tmp, "hello.txt");
		await fs.writeFile(real, "héllo 世界", "utf-8");
		const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
			makeChunk([{ locator: real, kind: "file", content: { text: "héllo 世界" } }]),
		]);
		try {
			const tool = new GetTool(createSession());
			await tool.execute("t", { target: real });
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
		} finally {
			(spy as any).mockRestore?.();
			await fs.rm(tmp, { recursive: true });
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-473: locator-spelling invariance (REAL kernel — no mock).
//
// The SAME target, addressed via {relative, absolute, ./-prefixed, ..-within-
// root, ..-escaping-from-subdir, trailing-slash} spellings, MUST resolve to the
// SAME nodes through the real FindTool→GetTool→kernel pipeline. The mocked
// GetTool tests above only assert the STRING handed to the kernel; they cannot
// catch the kernel/TS divergence this bug was about. These drive the live
// resolver so a regression in either layer fails the suite.
// ───────────────────────────────────────────────────────────────────────────
describe("BUG-473: locator-spelling invariance (real kernel)", () => {
	// Build a small real tree under a unique tmp root:
	//   <root>/pkg/a.txt, <root>/pkg/b.txt, <root>/pkg/c.md
	//   <root>/sub/deep/   (a deep subdir to climb out of with `..`)
	async function makeTree(): Promise<string> {
		const root = await fs.mkdtemp(nodePath.join(require("node:os").tmpdir(), "bug473-"));
		await fs.mkdir(nodePath.join(root, "pkg"), { recursive: true });
		await fs.writeFile(nodePath.join(root, "pkg", "a.txt"), "ALPHA\n", "utf-8");
		await fs.writeFile(nodePath.join(root, "pkg", "b.txt"), "BETA\n", "utf-8");
		await fs.writeFile(nodePath.join(root, "pkg", "c.md"), "# gamma\n", "utf-8");
		await fs.mkdir(nodePath.join(root, "sub", "deep"), { recursive: true });
		return root;
	}

	// Drive the real FindTool (which delegates to GetTool) with a given cwd, no mock.
	async function findNodes(target: string, cwd: string): Promise<string[]> {
		const { FindTool } = await import("@spell/pi-coding-agent/tools");
		const tool = new FindTool(createSession({ cwd }));
		const result = await tool.execute("t", { target });
		const text = (result.content ?? []).map((b: any) => b.text ?? "").join("");
		// A glob over pure filesystem nodes auto-promotes to the fs-listing layout:
		// one entry per line as `<locator>` (dirs get a trailing `/`, files an
		// optional `  <size>` suffix) — no `[§kind]` marker. Strip the size/slash
		// decoration and normalise to basenames for set comparison (absolute
		// spellings echo absolute locators, relative echo relative).
		return text
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean)
			// Drop hint / placeholder / diagnostic lines.
			.filter(l => !l.startsWith("(") && !l.startsWith("Diagnostics") && !l.startsWith("[§"))
			// Path token is everything before a two-space size suffix; trailing
			// `/` (dir) and `@` (symlink) markers are decoration.
			.map(l => l.split("  ")[0].replace(/[/@]$/, ""))
			.map(l => nodePath.basename(l))
			.filter(Boolean)
			.sort();
	}

	async function rawText(target: string, cwd: string): Promise<string> {
		const { FindTool } = await import("@spell/pi-coding-agent/tools");
		const tool = new FindTool(createSession({ cwd }));
		const result = await tool.execute("t", { target });
		return (result.content ?? []).map((b: any) => b.text ?? "").join("");
	}

	it("file glob resolves identically across spellings", async () => {
		const root = await makeTree();
		const deep = nodePath.join(root, "sub", "deep");
		try {
			const baseline = await findNodes("pkg/*.txt", root);
			expect(baseline).toEqual(["a.txt", "b.txt"]);

			// Absolute spelling.
			expect(await findNodes(`${root}/pkg/*.txt`, root)).toEqual(baseline);
			// ./-prefixed.
			expect(await findNodes("./pkg/*.txt", root)).toEqual(baseline);
			// ..-within-root (dip into sub/ then back to pkg/).
			expect(await findNodes("sub/../pkg/*.txt", root)).toEqual(baseline);
			// ..-escaping from a deep subdir back to pkg/ (the user's repro shape).
			expect(await findNodes("../../pkg/*.txt", deep)).toEqual(baseline);
		} finally {
			await fs.rm(root, { recursive: true });
		}
	});

	it("trailing-slash dir-glob matches the slashless form", async () => {
		const root = await makeTree();
		try {
			const noSlash = await findNodes("*", root);
			const withSlash = await findNodes("*/", root);
			// Both enumerate the top-level entries; trailing slash no longer drops them.
			expect(withSlash).toEqual(noSlash);
			expect(noSlash).toContain("pkg");
		} finally {
			await fs.rm(root, { recursive: true });
		}
	});

	it("#raw reads identical content across spellings", async () => {
		const root = await makeTree();
		const deep = nodePath.join(root, "sub", "deep");
		try {
			const want = "ALPHA";
			expect(await rawText("pkg/a.txt#raw", root)).toContain(want);
			expect(await rawText(`${root}/pkg/a.txt#raw`, root)).toContain(want);
			expect(await rawText("./pkg/a.txt#raw", root)).toContain(want);
			expect(await rawText("sub/../pkg/a.txt#raw", root)).toContain(want);
			// ..-escaping from a deep subdir (the bug's headline failure).
			expect(await rawText("../../pkg/a.txt#raw", deep)).toContain(want);
		} finally {
			await fs.rm(root, { recursive: true });
		}
	});

	it("recursive glob resolves identically across spellings", async () => {
		const root = await makeTree();
		const deep = nodePath.join(root, "sub", "deep");
		try {
			const baseline = await findNodes("**/*.txt", root);
			expect(baseline).toEqual(["a.txt", "b.txt"]);
			expect(await findNodes(`${root}/**/*.txt`, root)).toEqual(baseline);
			expect(await findNodes("./**/*.txt", root)).toEqual(baseline);
			// Escaping from deep subdir.
			expect(await findNodes("../../**/*.txt", deep)).toEqual(baseline);
		} finally {
			await fs.rm(root, { recursive: true });
		}
	});
});
