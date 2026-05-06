import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, GetTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatCodePathResult } from "@oh-my-pi/pi-coding-agent/tools/codepath-result";
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
			makeChunk([{ locator: "src/main.ts", kind: "file", content: { text: "export const x = 1;" } }]),
		]);
		const tool = new GetTool();
		const result = await tool.execute("t", { target: "src/main.ts" });
		expect(getText(result)).toContain("src/main.ts");
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "get", target: "src/main.ts" }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#listing` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#listing` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#listing` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#tree` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#tree[depth=2]` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#tree[depth=3]` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		// T1.7: content: false + bare dir → unchanged (no auto-attach, escape hatch)
		it("does not auto-attach when content=false for a directory", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-get-nocontent");
			await fs.mkdir(tmp, { recursive: true });
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: tmp, kind: "dir" }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: tmp, content: false });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: tmp }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#tree[depth=1]` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#listing` }));
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
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${tmp}#tree[depth=5]` }));
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
	});

	// ─────────────────────────────────────────────────────────────
	// FEAT-713: source-extension files default to #raw, not #outline.
	// ─────────────────────────────────────────────────────────────
	describe("FEAT-713: bare-file default qualifier", () => {
		it("auto-attaches #raw for bare .ts path (no #outline)", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat713-ts");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "sample.ts");
			await fs.writeFile(real, "export const x = 1;\n", "utf-8");
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: "export const x = 1;\n" } }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: real });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("auto-attaches #raw for bare .md path", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat713-md");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "NOTES.md");
			await fs.writeFile(real, "# title\n", "utf-8");
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: "# title\n" } }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: real });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("auto-attaches #raw for bare .rs path", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat713-rs");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "lib.rs");
			await fs.writeFile(real, "fn main() {}\n", "utf-8");
			try {
				const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: "fn main() {}\n" } }]),
				]);
				const tool = new GetTool();
				await tool.execute("t", { target: real });
				expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: `${real}#raw` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

	// ─────────────────────────────────────────────────────────────
	// BUG-347: head/tail/offset/limit must slice single-node text
	// ─────────────────────────────────────────────────────────────
	describe("BUG-347: pagination on single-node text", () => {
		const FIVE_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n") + "\n";

		it("head N returns first N lines of single text-content node", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-head");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: FIVE_LINES } }]),
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, head: 2 });
				const text = getText(result);
				expect(text).toContain("alpha");
				expect(text).toContain("beta");
				expect(text).not.toContain("gamma");
				expect(text).not.toContain("epsilon");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("tail N returns last N lines of single text-content node", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-tail");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: FIVE_LINES } }]),
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, tail: 2 });
				const text = getText(result);
				expect(text).toContain("delta");
				expect(text).toContain("epsilon");
				expect(text).not.toContain("alpha");
				expect(text).not.toContain("beta");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("offset+limit returns the requested slice", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-slice");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: FIVE_LINES } }]),
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, offset: 2, limit: 2 });
				const text = getText(result);
				expect(text).toContain("gamma");
				expect(text).toContain("delta");
				expect(text).not.toContain("alpha");
				expect(text).not.toContain("epsilon");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("no pagination params returns full content", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-full");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: FIVE_LINES } }]),
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real });
				const text = getText(result);
				expect(text).toContain("alpha");
				expect(text).toContain("epsilon");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("slices content carried in node.content.value (kernel raw extractor)", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-value");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				// Mimic the kernel's TextResolver shape: content.value, not content.text.
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					{
						nodes: [
							{
								locator: real,
								rangeStart: 0,
								rangeEnd: FIVE_LINES.length,
								kind: "§file",
								content: { kind: "text", value: FIVE_LINES },
								metadata: {},
								diagnostics: [],
							},
						],
						diagnostics: [],
						done: true,
					} as any,
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, head: 2 });
				const text = getText(result);
				expect(text).toContain("alpha");
				expect(text).toContain("beta");
				expect(text).not.toContain("gamma");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("head 0 returns no content lines (param is honoured, not ignored)", async () => {
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug347-zero");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "file.txt");
			await fs.writeFile(real, FIVE_LINES, "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: real, kind: "file", content: { text: FIVE_LINES } }]),
				]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, head: 0 });
				const text = getText(result);
				expect(text).not.toContain("alpha");
				expect(text).not.toContain("beta");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

	// ─────────────────────────────────────────────────────────────
	// BUG-348: gitignore diagnostics — no false positives,
	// gitignore:false actually works for files outside walker root.
	// ─────────────────────────────────────────────────────────────
	describe("BUG-348: gitignore hint truth", () => {
		it("emits OUT_OF_PROJECT_ROOT for absolute paths outside cwd", async () => {
			const outsideRoot = nodePath.join("/tmp", `spell-bug348-${Date.now()}`);
			await fs.mkdir(outsideRoot, { recursive: true });
			const real = nodePath.join(outsideRoot, "out.txt");
			await fs.writeFile(real, "hello\n", "utf-8");
			try {
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real });
				const text = getText(result);
				expect(text).toContain("OUT_OF_PROJECT_ROOT");
				// Must not falsely claim the file is gitignored — only mention
				// the gitignore: false param as a possible repair.
				expect(text).not.toContain("may be excluded by .gitignore");
			} finally {
				await fs.rm(outsideRoot, { recursive: true });
			}
		});

		it("gitignore:false reads out-of-root file directly", async () => {
			const outsideRoot = nodePath.join("/tmp", `spell-bug348b-${Date.now()}`);
			await fs.mkdir(outsideRoot, { recursive: true });
			const real = nodePath.join(outsideRoot, "out.txt");
			await fs.writeFile(real, "out-of-root content\n", "utf-8");
			try {
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real, gitignore: false });
				const text = getText(result);
				expect(text).toContain("out-of-root content");
			} finally {
				await fs.rm(outsideRoot, { recursive: true });
			}
		});

		it("does not suggest gitignore for tracked file with empty kernel result", async () => {
			// A tracked file that the kernel happens to return zero nodes for
			// (e.g. due to pagination or query filter) must NOT trigger a
			// false gitignore hint.
			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-bug348-tracked");
			await fs.mkdir(tmp, { recursive: true });
			const real = nodePath.join(tmp, "tracked.txt");
			await fs.writeFile(real, "hi\n", "utf-8");
			try {
				spyOn(nativesModule, "executeCodePath").mockResolvedValue([makeChunk([])]);
				const tool = new GetTool();
				const result = await tool.execute("t", { target: real });
				const text = getText(result);
				expect(text).not.toContain("gitignore");
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});
	});

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
});
