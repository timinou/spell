import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { flattenChunks, runGet, setupFixtureDir, teardownFixtureDir, writeFiles } from "../parity-helpers";

describe("find → get parity", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = setupFixtureDir();
	});

	afterEach(() => {
		teardownFixtureDir(testDir);
	});

	it("bare file path returns single file", async () => {
		writeFiles(testDir, { "single.txt": "x" });
		const chunks = await runGet("single.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(1);
		expect(nodes[0].kind).toBe("§file");
	});

	it("single-star glob matches files in current dir", async () => {
		writeFiles(testDir, { "a.txt": "a", "b.txt": "b", "c.rs": "c" });
		const chunks = await runGet("*.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(nodes.map(n => n.locator).sort()).toEqual(["a.txt", "b.txt"]);
	});

	it("double-star glob matches nested files", async () => {
		writeFiles(testDir, { "src/a/x.ts": "x", "src/b.ts": "b", "root.txt": "r" });
		const chunks = await runGet("src/**/*.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		const locators = nodes.map(n => n.locator);
		expect(locators).toContain("src/a/x.ts");
		expect(locators).toContain("src/b.ts");
	});

	it("double-star at root finds deeply nested files", async () => {
		writeFiles(testDir, { "a/b/c/d.ts": "d", "a/b/e.ts": "e", "f.ts": "f" });
		const chunks = await runGet("**/*.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(3);
	});

	it("wildcard prefix matches suffix patterns", async () => {
		writeFiles(testDir, { "alpha.test.ts": "a", "beta.test.ts": "b", "gamma.ts": "g" });
		const chunks = await runGet("*.test.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("wildcard infix matches mid-string patterns", async () => {
		writeFiles(testDir, { "foo-bar.ts": "a", "foo-baz.ts": "b", "qux.ts": "c" });
		const chunks = await runGet("foo-*.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("glob with question mark matches single char", async () => {
		writeFiles(testDir, { "a1.ts": "a", "a2.ts": "b", "ab.ts": "c" });
		const chunks = await runGet("a?.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("hidden files are included by default", async () => {
		writeFiles(testDir, { ".secret/hidden.txt": "h", "visible.txt": "v" });
		const chunks = await runGet("**/*.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		const locators = nodes.map(n => n.locator);
		expect(locators).toContain("visible.txt");
		expect(locators).toContain(".secret/hidden.txt");
	});

	it("gitignored files are excluded by default", async () => {
		writeFiles(testDir, { ".git/config": "", ".gitignore": "ignored.txt\n", "ignored.txt": "i", "kept.txt": "k" });
		const chunks = await runGet("**/*.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		const locators = nodes.map(n => n.locator);
		expect(locators).toContain("kept.txt");
		expect(locators).not.toContain("ignored.txt");
	});

	it("limit truncates results", async () => {
		writeFiles(testDir, { "a.txt": "a", "b.txt": "b", "c.txt": "c", "d.txt": "d" });
		const chunks = await runGet("*.txt", { root: testDir, limit: 2 });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("format=simple-list returns bare paths", async () => {
		writeFiles(testDir, { "a.txt": "a", "b.txt": "b" });
		const chunks = await runGet("*.txt", { root: testDir, format: "simple-list" });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(nodes.map(n => n.locator).sort()).toEqual(["a.txt", "b.txt"]);
	});

	it("format=locations returns file:line:col", async () => {
		writeFiles(testDir, { "a.txt": "line1\nline2\n" });
		const chunks = await runGet("a.txt::§line", { root: testDir, format: "locations" });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
		expect(nodes[0].locator).toMatch(/^a\.txt:\d+/);
	});

	it("format=tree groups by file", async () => {
		writeFiles(testDir, { "src/a.ts": "a", "src/b.ts": "b" });
		const chunks = await runGet("src/**/*.ts", { root: testDir, format: "tree" });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("empty glob returns empty result", async () => {
		writeFiles(testDir, { "a.rs": "a" });
		const chunks = await runGet("*.nonexistent", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(0);
	});

	it("directory target returns children", async () => {
		writeFiles(testDir, { "src/a.ts": "a", "src/b.ts": "b" });
		const chunks = await runGet("src/", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBeGreaterThanOrEqual(1);
	});

	it("nested directory glob with multiple levels", async () => {
		writeFiles(testDir, { "a/b/c/d.ts": "d", "a/b/e.ts": "e" });
		const chunks = await runGet("a/**/*.ts", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("glob with multiple extensions", async () => {
		writeFiles(testDir, { "a.ts": "a", "b.js": "b", "c.rs": "c" });
		const chunks = await runGet("*.{ts,js}", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(2);
	});

	it("large directory returns many files", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 50; i++) {
			files[`f${i}.txt`] = `${i}`;
		}
		writeFiles(testDir, files);
		const chunks = await runGet("*.txt", { root: testDir });
		const nodes = flattenChunks(chunks);
		expect(nodes.length).toBe(50);
	});

	it.todo("brace expansion with nested braces");
	it.todo("character class ranges like [0-9].txt");
	it.todo("negation patterns like !exclude.ts");
	it.todo("case-sensitive vs case-insensitive glob");
	it.todo("mtime sorting");
	it.todo("explicit hidden=false filter");
	it.todo("explicit gitignore=false includes ignored files");
	it.todo("multi-path list target");
	it.todo("symlink handling in glob walk");
	it.todo("circular symlink detection");
	it.todo("glob with spaces in filename");
	it.todo("glob with unicode characters");
	it.todo("glob with special regex chars in name");
	it.todo("chunking for >64 nodes");
	it.todo("format=stats returns file counts");
	it.todo("format=content-only for files");
});
