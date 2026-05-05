import { describe, expect, it } from "bun:test";
import { formatCodePathResult } from "@oh-my-pi/pi-coding-agent/tools/codepath-result";
import type { CodePathChunk, NodeRefDto } from "@oh-my-pi/pi-coding-agent/tools/codepath-types";

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
