import { describe, expect, it } from "bun:test";
import { formatCodePathResult } from "@spell/pi-coding-agent/tools/codepath-result";
import type { CodePathChunk, NodeRefDto } from "@spell/pi-coding-agent/tools/codepath-types";

function makeNode(opts: Partial<NodeRefDto>): NodeRefDto {
	return {
		locator: opts.locator ?? "x.ts",
		rangeStart: 0,
		rangeEnd: 0,
		kind: opts.kind ?? "§file",
		content: opts.content,
		metadata: opts.metadata ?? {},
		diagnostics: opts.diagnostics ?? [],
	};
}

function formatNodes(nodes: NodeRefDto[], format: "node-list" | "locations" = "node-list"): string {
	const chunks: CodePathChunk[] = [{ nodes, diagnostics: [], done: true }];
	return formatCodePathResult(chunks, { format }).text;
}

describe("formatLocator (FEAT-705 LINE#ID)", () => {
	it("renders LINE#ID prefix when anchor id is present", () => {
		const node = makeNode({
			locator: "src/foo.ts::<line 5#QW>",
			kind: "§line",
			content: { kind: "text", value: "console.log(1);" },
		});
		const out = formatNodes([node], "locations");
		expect(out).toContain("5#QW");
		expect(out).toContain("src/foo.ts");
	});

	it("falls back to bare line when anchor missing", () => {
		const node = makeNode({
			locator: "src/foo.ts:42",
			kind: "§line",
			content: { kind: "text", value: "x" },
		});
		const out = formatNodes([node], "locations");
		expect(out).toContain("src/foo.ts:42");
		expect(out).not.toContain("#");
	});
});

describe("formatStatMetadata (FEAT-709)", () => {
	it("renders size and mtime for §file stat", () => {
		const node = makeNode({
			locator: "package.json",
			kind: "§file",
			metadata: { size: 1234, mtime: 1700000000 },
		});
		const out = formatNodes([node], "locations");
		expect(out).toContain("§file");
		// 1.2 KB-ish (formatBytes formatting may differ but should
		// include "KB" or a recognisable size unit).
		expect(out).toMatch(/size=\d/);
		expect(out).toContain("mtime=2023");
	});

	it("omits size when zero (e.g., empty dir)", () => {
		const node = makeNode({
			locator: "empty-dir",
			kind: "§dir",
			metadata: { size: 0, mtime: 1700000000 },
		});
		const out = formatNodes([node], "locations");
		expect(out).not.toContain("size=");
		expect(out).toContain("mtime=");
	});

	it("non-stat nodes unchanged", () => {
		const node = makeNode({
			locator: "src/foo.ts",
			kind: "§function",
			metadata: { name: "foo" },
		});
		const out = formatNodes([node], "locations");
		expect(out).not.toContain("[§function");
	});

	it("symlink target rendered", () => {
		const node = makeNode({
			locator: "ln",
			kind: "§symlink",
			metadata: { target: "real.txt", mtime: 1700000000 },
		});
		const out = formatNodes([node], "locations");
		expect(out).toContain("target=real.txt");
	});
});

describe("buildNodeList grep shape (FEAT-719)", () => {
	function matchLine(path: string, line: number, anchor: string, body: string): NodeRefDto {
		return makeNode({
			locator: `${path}::<line ${line}#${anchor}>`,
			kind: "\u00a7line",
			content: { kind: "text", value: body },
			metadata: { shape: "match", anchorId: anchor, line },
		});
	}

	function symbolMatchLine(
		path: string,
		line: number,
		symbolPath: string | undefined,
		symbolLine: number,
		body: string,
	): NodeRefDto {
		return makeNode({
			locator: `${path}::<line ${line}>`,
			kind: "\u00a7line",
			content: { kind: "text", value: body },
			metadata: symbolPath
				? { shape: "match", line, enclosingSymbolPath: symbolPath, enclosingSymbolLine: symbolLine }
				: { shape: "match", line },
		});
	}

	// W5a (FEAT-785): single text-match renders as a one-file heading group,
	// path on a heading line, hit indented beneath. No LINE#ID anchor.
	it("W5a: text-match renders ripgrep heading shape without LINE#ID anchor", () => {
		const node = matchLine("src/foo.ts", 42, "AB", "  const cached = useState(initial);");
		const out = formatNodes([node]);
		expect(out).toBe("src/foo.ts\n  42:    const cached = useState(initial);");
		expect(out).not.toContain("#AB");
		expect(out).not.toContain("[\u00a7line]");
	});

	// W5b (FEAT-785): multiple matches in one file share a single heading, rows
	// sorted ascending by line and indented beneath.
	it("W5b: multiple matches in one file share one heading, sorted by line", () => {
		const nodes = [
			matchLine("src/foo.ts", 58, "CD", "\tconst [_, setX] = useState(0);"),
			matchLine("src/foo.ts", 42, "AB", "\tconst cached = useState(initial);"),
		];
		const out = formatNodes(nodes);
		expect(out.split("\n")).toEqual([
			"src/foo.ts",
			"  42:  \tconst cached = useState(initial);",
			"  58:  \tconst [_, setX] = useState(0);",
		]);
	});

	// W5c (FEAT-785): glob — one heading block per file, files ordered by path,
	// lines ascending within; blocks separated by a blank line.
	it("W5c: glob matches group per file, files sorted by path", () => {
		const nodes = [
			matchLine("src/b.ts", 3, "M3", "todo"),
			matchLine("src/a.ts", 7, "M1", "todo seven"),
			matchLine("src/a.ts", 2, "M2", "todo two"),
		];
		const out = formatNodes(nodes);
		expect(out).toBe(["src/a.ts", "  2:  todo two", "  7:  todo seven", "", "src/b.ts", "  3:  todo"].join("\n"));
	});

	it("groups match rows by enclosing symbol when symbol metadata is present", () => {
		const nodes = [
			symbolMatchLine("src/foo.ts", 31, "second", 30, "TODO c"),
			symbolMatchLine("src/foo.ts", 12, "first", 10, "TODO b"),
			symbolMatchLine("src/foo.ts", 2, undefined, Number.MAX_SAFE_INTEGER, "TODO top"),
			symbolMatchLine("src/foo.ts", 11, "first", 10, "TODO a"),
		];
		const out = formatNodes(nodes);
		expect(out).toBe(
			[
				"src/foo.ts",
				"::first",
				"  11:  TODO a",
				"  12:  TODO b",
				"",
				"::second",
				"  31:  TODO c",
				"",
				"::<file>",
				"  2:  TODO top",
			].join("\n"),
		);
	});

	// W5d: §line[N] (no shape metadata) keeps LINE#ID block (regression).
	it("W5d: ordinal §line[N] keeps LINE#ID anchor block", () => {
		const node = makeNode({
			locator: "src/foo.ts::<line 5#QW>",
			kind: "\u00a7line",
			content: { kind: "text", value: "console.log(1);" },
			metadata: { anchorId: "QW", line: 5 },
		});
		const out = formatNodes([node]);
		expect(out).toContain("5#QW");
		expect(out).toContain("[\u00a7line]");
		expect(out).toContain("console.log(1);");
	});

	// W5e: §line[A..B] / shape=slice renders single body, unchanged path.
	it("W5e: slice shape (range) renders single body block", () => {
		const node = makeNode({
			locator: "src/foo.ts::<line 3#XX>",
			kind: "\u00a7line",
			content: { kind: "text", value: "line three\nline four\nline five" },
			metadata: { shape: "slice", line: 3 },
		});
		const out = formatNodes([node]);
		expect(out).toContain("line three\nline four\nline five");
		expect(out).toContain("[\u00a7line]");
		expect(out).not.toMatch(/^src\/foo\.ts:3: {2}/);
	});

	// Edge case: matched line containing colons stays verbatim after the separator.
	it("matched line containing colons preserves rest verbatim", () => {
		const node = matchLine("src/foo.ts", 10, "ZZ", "  url: 'http://x.y'; port: 80");
		const out = formatNodes([node]);
		expect(out).toBe("src/foo.ts\n  10:    url: 'http://x.y'; port: 80");
	});

	// Mixed shapes in one stream: match-shape block and ordinal block don't interleave.
	it("mixed match + ordinal nodes don't interleave", () => {
		const ordinal = makeNode({
			locator: "src/foo.ts::<line 1#QQ>",
			kind: "\u00a7line",
			content: { kind: "text", value: "first" },
			metadata: { anchorId: "QQ", line: 1 },
		});
		const m = matchLine("src/foo.ts", 7, "AB", "foo todo");
		const out = formatNodes([m, ordinal]);
		// Match block (heading group) flushed first, then ordinal LINE#ID block.
		expect(out).toBe("src/foo.ts\n  7:  foo todo\n\nsrc/foo.ts:1#QQ  [\u00a7line]\nfirst");
	});

	// Acceptance: 10 matches in 1000-line file < 1KB.
	it("byte-count for 10 matches ≤ 1KB", () => {
		const nodes = Array.from({ length: 10 }, (_, i) =>
			matchLine("src/big.ts", (i + 1) * 100, `H${i}`, `match number ${i} content`),
		);
		const out = formatNodes(nodes);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
	});
});

describe("symbol-aware non-match node formatting", () => {
	it("renders a symbol header for structural nodes with symbol metadata", () => {
		const node = makeNode({
			locator: "src/foo.ts",
			kind: "\u00a7function_declaration",
			content: { kind: "text", value: "function parse() {\n  return 1;\n}" },
			metadata: { line: 10, symbolPath: "parse", symbolKind: "function_declaration", symbolLine: 10 },
		});

		const out = formatNodes([node]);
		expect(out).toBe("src/foo.ts\n::parse  [\u00a7function_declaration] L10\nfunction parse() {\n  return 1;\n}");
	});

	it("projects symbol metadata into the data channel", () => {
		const chunks: CodePathChunk[] = [
			{
				nodes: [
					makeNode({
						locator: "src/foo.ts::<line 12>",
						kind: "\u00a7line",
						content: { kind: "text", value: "TODO" },
						metadata: {
							line: 12,
							enclosingSymbolPath: "parse",
							enclosingSymbolKind: "function_declaration",
							enclosingSymbolLine: 10,
						},
					}),
				],
				diagnostics: [],
				done: true,
			},
		];

		const result = formatCodePathResult(chunks, { format: "node-list" });
		expect(result.data[0]).toMatchObject({
			path: "src/foo.ts",
			line: 12,
			enclosingSymbolPath: "parse",
			enclosingSymbolKind: "function_declaration",
			enclosingSymbolLine: 10,
		});
	});
});

describe("computeStats (FEAT-786)", () => {
	function matchNode(path: string, line: number, body: string): NodeRefDto {
		return makeNode({
			locator: `${path}::<line ${line}#ZZ>`,
			kind: "\u00a7line",
			content: { kind: "text", value: body },
			metadata: { shape: "match", line },
		});
	}

	it("counts nodes, matches, and distinct files", () => {
		const chunks: CodePathChunk[] = [
			{
				nodes: [
					matchNode("src/a.ts", 2, "todo"),
					matchNode("src/a.ts", 7, "todo"),
					matchNode("src/b.ts", 3, "todo"),
				],
				diagnostics: [],
				done: true,
			},
		];
		const { stats } = formatCodePathResult(chunks, { format: "node-list" });
		expect(stats).toEqual({ nodeCount: 3, matchCount: 3, fileCount: 2 });
	});

	it("matchCount excludes non-match nodes; fileCount dedupes", () => {
		const chunks: CodePathChunk[] = [
			{
				nodes: [makeNode({ locator: "src/a.ts", kind: "\u00a7file" }), matchNode("src/a.ts", 9, "todo")],
				diagnostics: [],
				done: true,
			},
		];
		const { stats } = formatCodePathResult(chunks, { format: "node-list" });
		expect(stats).toEqual({ nodeCount: 2, matchCount: 1, fileCount: 1 });
	});
});
