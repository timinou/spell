import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	flattenChunks,
	getNodeText,
	runGet,
	setupFixtureDir,
	teardownFixtureDir,
	writeFiles,
} from "../parity-helpers";

describe("grep → get parity", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = setupFixtureDir();
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it("simple regex match over single file", async () => {
		writeFiles(testDir, { "a.txt": "foo\nbar\nbaz\n" });
		const chunks = await runGet(`a.txt::§line[text~="ba."]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toContain("bar");
	});

	it("regex match over glob", async () => {
		writeFiles(testDir, { "a.txt": "foo\nbar\n", "b.txt": "qux\nbar\n" });
		const chunks = await runGet(`*.txt::§line[text~="ba."]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		const locators = nodes.map(n => n.locator);
		expect(locators.some(l => l.includes("a.txt"))).toBe(true);
		expect(locators.some(l => l.includes("b.txt"))).toBe(true);
	});

	it("case-sensitive regex", async () => {
		writeFiles(testDir, { "a.txt": "TODO\ntodo\n" });
		const chunks = await runGet(`a.txt::§line[text~="TODO"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toBe("TODO\n");
	});

	it("literal string with anchors", async () => {
		writeFiles(testDir, { "a.txt": "start middle end\n" });
		const chunks = await runGet(`a.txt::§line[text~="^start"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toContain("start");
	});

	it("match at end of line", async () => {
		writeFiles(testDir, { "a.txt": "hello world\ngoodbye world\n" });
		const chunks = await runGet(`a.txt::§line[text~="world$"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("numeric match", async () => {
		writeFiles(testDir, { "a.txt": "line 123\nline 456\n" });
		const chunks = await runGet(`a.txt::§line[text~="\\d{3}"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("no match returns empty", async () => {
		writeFiles(testDir, { "a.txt": "hello\nworld\n" });
		const chunks = await runGet(`a.txt::§line[text~="zzz"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(0);
	});

	it("match count across multiple files", async () => {
		writeFiles(testDir, { "a.txt": "needle\n", "b.txt": "needle\nneedle\n", "c.txt": "none\n" });
		const chunks = await runGet(`*.txt::§line[text~="needle"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(3);
	});

	it("limit truncates matches", async () => {
		writeFiles(testDir, { "a.txt": "n1\nn2\nn3\nn4\n" });
		const chunks = await runGet(`a.txt::§line[text~="n\\d"]`, { root: testDir, limit: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("double-star glob with regex", async () => {
		writeFiles(testDir, { "src/a.ts": "foo\n", "src/b/c.ts": "foo\n" });
		const chunks = await runGet(`src/**/*.ts::§line[text~="foo"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("glob filter by extension implicit in pattern", async () => {
		writeFiles(testDir, { "a.ts": "match\n", "b.js": "match\n" });
		const chunks = await runGet(`*.ts::§line[text~="match"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].locator).toContain("a.ts");
	});

	it("match in deeply nested file", async () => {
		writeFiles(testDir, { "a/b/c/d.txt": "deep\n" });
		const chunks = await runGet(`**/*.txt::§line[text~="deep"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
	});

	it("special regex chars are treated as regex", async () => {
		writeFiles(testDir, { "a.txt": "a.b\nabc\n" });
		const chunks = await runGet(`a.txt::§line[text~="a\\.b"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toContain("a.b");
	});

	it("unicode text match", async () => {
		writeFiles(testDir, { "a.txt": "héllo\nwörld\n" });
		const chunks = await runGet(`a.txt::§line[text~="héllo"]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(getNodeText(nodes[0])).toContain("héllo");
	});

	it("empty file returns no matches", async () => {
		writeFiles(testDir, { "empty.txt": "" });
		const chunks = await runGet(`empty.txt::§line[text~="."]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(0);
	});

	it("single char regex matches all non-empty lines", async () => {
		writeFiles(testDir, { "a.txt": "a\nb\n\nc\n" });
		const chunks = await runGet(`a.txt::§line[text~="."]`, { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(3);
	});

	it.todo("multiline regex spanning lines");
	it.todo("case-insensitive flag /i");
	it.todo("post context lines >>");
	it.todo("pre context lines <<");
	it.todo("type filter ts-only");
	it.todo("semantic mode def→ lookup");
	it.todo("semantic mode references lookup");
	it.todo("semantic mode impl lookup");
	it.todo("global limit across files");
	it.todo("round-robin distribution");
	it.todo("grouped headings per file");
	it.todo("word boundary regex \\b");
	it.todo("alternation regex a|b");
	it.todo("capture groups in regex");
	it.todo("backreference in regex");
	it.todo("lookahead assertion");
	it.todo("lookbehind assertion");
	it.todo("paragraph-level grep §para[text~=...]");
	it.todo("chunk-level grep §chunk[text~=...]");
	it.todo("gitignore respected in grep glob");
	it.todo("hidden files included in grep glob");
	it.todo("diagnostic for invalid regex");
});
