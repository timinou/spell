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
			const { getSchema } = await import("@oh-my-pi/pi-coding-agent/tools/codepath-types");
			expect(Value.Check(getSchema, { target: "x" })).toBe(true);
			expect(Value.Check(getSchema, { target: "x", head: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", tail: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", offset: 5 })).toBe(false);
			expect(Value.Check(getSchema, { target: "x", limit: 5 })).toBe(false);
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

	describe("FEAT-815: JS-preferred scheme preempt", () => {
		it("resolves jobs://<id> via internal router instead of kernel", async () => {
			const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
			const { InternalUrlRouter, JobsProtocolHandler } = await import("@oh-my-pi/pi-coding-agent/internal-urls");

			const manager = new AsyncJobManager({ onJobComplete: async () => {} });
			const jobId = manager.register("bash", "echo hi", async () => "hello world", { id: "9-Feat238" });
			// Wait for the job's promise to resolve so the result is recorded.
			const job = manager.getJob(jobId);
			await job?.promise;

			const router = new InternalUrlRouter();
			router.register(new JobsProtocolHandler({ getAsyncJobManager: () => manager }));

			// The kernel must NOT be consulted — the JS preempt owns this scheme.
			const spy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);

			const tool = new GetTool(createSession({ internalRouter: router }));
			const result = await tool.execute("t", { target: "jobs://9-Feat238" });

			const text = getText(result);
			expect(text).toContain("# Job 9-Feat238");
			expect(text).toContain("hello world");
			expect(spy).not.toHaveBeenCalled();
		});

		it("resolves memory:// via JS router and forwards codepath suffix to kernel on sourcePath", async () => {
			const { InternalUrlRouter, MemoryProtocolHandler } = await import("@oh-my-pi/pi-coding-agent/internal-urls");

			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat815-memory");
			await fs.mkdir(tmp, { recursive: true });
			await fs.writeFile(nodePath.join(tmp, "memory_summary.md"), "# Memory\nline two\n", "utf-8");
			try {
				const router = new InternalUrlRouter();
				router.register(new MemoryProtocolHandler({ getMemoryRoot: () => tmp }));

				// Without codepath suffix: JS resolves directly, kernel untouched.
				const kernelSpy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);
				const tool = new GetTool(createSession({ internalRouter: router }));
				const plain = await tool.execute("t", { target: "memory://root" });
				expect(getText(plain)).toContain("# Memory");
				expect(kernelSpy).not.toHaveBeenCalled();
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("forwards codepath suffix on memory:// to kernel using resolved sourcePath", async () => {
			const { InternalUrlRouter, MemoryProtocolHandler } = await import("@oh-my-pi/pi-coding-agent/internal-urls");

			const tmp = nodePath.join(process.cwd(), "packages/coding-agent/test/tmp-feat815-memory-cp");
			await fs.mkdir(tmp, { recursive: true });
			const summary = nodePath.join(tmp, "memory_summary.md");
			await fs.writeFile(summary, "alpha\nbeta\ngamma\n", "utf-8");
			try {
				const router = new InternalUrlRouter();
				router.register(new MemoryProtocolHandler({ getMemoryRoot: () => tmp }));

				const kernelSpy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([
					makeChunk([{ locator: summary, kind: "file", content: { text: "beta\n" } }]),
				]);
				const tool = new GetTool(createSession({ internalRouter: router }));
				const sliced = await tool.execute("t", { target: "memory://root::§line[2..2]" });
				expect(getText(sliced)).toContain("beta");
				// Kernel was invoked, but with the resolved filesystem sourcePath +
				// suffix — not the original URI.
				expect(kernelSpy).toHaveBeenCalledWith(expect.objectContaining({ target: `${summary}::§line[2..2]` }));
			} finally {
				await fs.rm(tmp, { recursive: true });
			}
		});

		it("notes that codepath qualifiers on virtual resources are ignored (pi://)", async () => {
			const { InternalUrlRouter, PiProtocolHandler } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
			const router = new InternalUrlRouter();
			router.register(new PiProtocolHandler());

			const kernelSpy = spyOn(nativesModule, "executeCodePath").mockResolvedValue([]);
			const tool = new GetTool(createSession({ internalRouter: router }));
			// pi:// returns a virtual sourcePath — the kernel must not be consulted
			// for the codepath suffix; instead the response includes a [note].
			const result = await tool.execute("t", { target: "pi://nonexistent.md::§line[1..2]" });
			expect(getText(result)).toContain("[§error] pi://nonexistent.md::§line[1..2]");
			expect(kernelSpy).not.toHaveBeenCalled();
		});
	});

	it("falls through to kernel for unknown scheme", async () => {
		const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
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
});
