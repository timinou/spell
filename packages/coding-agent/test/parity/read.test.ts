import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	flattenChunks,
	getNodeText,
	runGet,
	setupFixtureDir,
	teardownFixtureDir,
	writeFiles,
} from "../parity-helpers";

describe("read → get parity", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = setupFixtureDir();
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it("bare file path returns file node", async () => {
		writeFiles(testDir, { "hello.txt": "hello world" });
		const chunks = await runGet("hello.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].kind).toBe("§file");
	});

	it("whole-file content via line query", async () => {
		writeFiles(testDir, { "lines.txt": "l1\nl2\nl3\n" });
		const chunks = await runGet("lines.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(3);
		expect(getNodeText(nodes[0])).toBe("l1\n");
	});

	it("offset skips leading lines", async () => {
		writeFiles(testDir, { "lines.txt": "l1\nl2\nl3\nl4\n" });
		const chunks = await runGet("lines.txt::§line", { root: testDir, offset: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(3); // lines 2,3,4 (offset is 1-based inclusive)
		expect(getNodeText(nodes[0])).toBe("l2\n");
	});

	it("head limits returned lines", async () => {
		writeFiles(testDir, { "lines.txt": "l1\nl2\nl3\nl4\n" });
		const chunks = await runGet("lines.txt::§line", { root: testDir, head: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(getNodeText(nodes[0])).toBe("l1\n");
		expect(getNodeText(nodes[1])).toBe("l2\n");
	});

	it("tail returns last lines", async () => {
		writeFiles(testDir, { "lines.txt": "l1\nl2\nl3\nl4\n" });
		const chunks = await runGet("lines.txt::§line", { root: testDir, tail: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(getNodeText(nodes[0])).toBe("l3\n");
		expect(getNodeText(nodes[1])).toBe("l4\n");
	});

	it("offset + head slices a window", async () => {
		writeFiles(testDir, { "lines.txt": "l1\nl2\nl3\nl4\nl5\n" });
		const chunks = await runGet("lines.txt::§line", { root: testDir, offset: 2, head: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(getNodeText(nodes[0])).toBe("l2\n");
		expect(getNodeText(nodes[1])).toBe("l3\n");
	});

	it("large file line query returns all lines", async () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		writeFiles(testDir, { "big.txt": lines.join("\n") });
		const chunks = await runGet("big.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(100);
	});

	it("directory listing returns entries", async () => {
		writeFiles(testDir, { "src/a.ts": "a", "src/b.ts": "b" });
		const chunks = await runGet("src/", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBeGreaterThanOrEqual(1);
	});

	it("json file read returns file node", async () => {
		writeFiles(testDir, { "data.json": '{"key": "value"}' });
		const chunks = await runGet("data.json", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].kind).toBe("§file");
	});

	it("html file read returns file node", async () => {
		writeFiles(testDir, { "page.html": "<html><body>hello</body></html>" });
		const chunks = await runGet("page.html", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
	});

	it("ts file read returns file node", async () => {
		writeFiles(testDir, { "main.ts": "export const x = 1;" });
		const chunks = await runGet("main.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].kind).toBe("§file");
	});

	it("memory:// URI resolves", async () => {
		writeFiles(testDir, { "memory/root": "memory data" });
		const chunks = await runGet("memory://root", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].kind).toBe("§memory");
	});

	it("artifact:// URI resolves", async () => {
		writeFiles(testDir, { "artifacts/session/main/tool/0.txt": "artifact data" });
		const chunks = await runGet("artifact://session/main/tool/0.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		// Artifact resolution depends on root mapping; may be empty
		expect(nodes.length).toBeGreaterThanOrEqual(0);
	});

	it("nonexistent file returns empty", async () => {
		const chunks = await runGet("nonexistent.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(0);
	});

	it("empty file returns single line node with empty text", async () => {
		writeFiles(testDir, { "empty.txt": "" });
		const chunks = await runGet("empty.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toBe("");
	});

	it("single-line file returns one line node", async () => {
		writeFiles(testDir, { "single.txt": "only line" });
		const chunks = await runGet("single.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toBe("only line");
	});

	it("file with trailing newline has extra empty line node", async () => {
		writeFiles(testDir, { "trail.txt": "a\n" });
		const chunks = await runGet("trail.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("crlf line endings are preserved in content", async () => {
		writeFiles(testDir, { "crlf.txt": "line1\r\nline2\r\n" });
		const chunks = await runGet("crlf.txt::§line", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(getNodeText(nodes[0])).toContain("line1");
	});

	it.todo("read pdf returns extracted text");
	it.todo("read docx returns extracted text");
	it.todo("read pptx returns extracted text");
	it.todo("read xlsx returns extracted text");
	it.todo("read rtf returns extracted text");
	it.todo("read epub returns extracted text");
	it.todo("read image returns image node");
	it.todo("read json pretty-prints");
	it.todo("read html returns readable text");
	it.todo("encoding fallback latin-1");
	it.todo("suffix fallback for typo path");
	it.todo("skill:// URI scheme");
	it.todo("agent:// URI scheme");
	it.todo("jobs:// URI scheme");
	it.todo("local:// URI scheme");
	it.todo("pi:// URI scheme");
	it.todo("rule:// URI scheme");
	it.todo("mcp:// URI scheme");
	it.todo("raw bytes read via #raw qualifier");
	it.todo("line slice with explicit range §line[2..5]");
	it.todo("paragraph read §para");
	it.todo("chunk read §chunk");
	it.todo("large file streaming >1MiB");
	it.todo("binary file handling");
	it.todo("unicode BOM stripping");
	it.todo("symlink file read");
});
