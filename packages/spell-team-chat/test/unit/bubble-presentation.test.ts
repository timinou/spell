import { describe, expect, test } from "bun:test";
import { classifyDiffLines, looksLikeDiff, summariseArgs } from "../../src/lib/bubble-presentation";

describe("summariseArgs", () => {
	test("returns null for non-object input", () => {
		expect(summariseArgs(undefined)).toBeNull();
		expect(summariseArgs(null)).toBeNull();
		expect(summariseArgs("x")).toBeNull();
		expect(summariseArgs(42)).toBeNull();
	});

	test("picks the highest-priority identifying field", () => {
		expect(summariseArgs({ target: "a.ts::Foo", path: "b.ts" })).toBe("a.ts::Foo");
		expect(summariseArgs({ path: "b.ts" })).toBe("b.ts");
		expect(summariseArgs({ command: "cargo build" })).toBe("cargo build");
		expect(summariseArgs({ query: "todo:DOING" })).toBe("todo:DOING");
	});

	test("falls back to a short key list when no primary field", () => {
		expect(summariseArgs({ alpha: 1, beta: 2 })).toBe("alpha, beta");
		// caps at 4 keys
		expect(summariseArgs({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe("a, b, c, d");
	});

	test("ignores empty-string and nullish primaries", () => {
		expect(summariseArgs({ target: "", path: "real.ts" })).toBe("real.ts");
		expect(summariseArgs({ target: null, file: undefined })).toBeNull();
	});

	test("truncates over-long values with an ellipsis", () => {
		const long = "x".repeat(200);
		const out = summariseArgs({ target: long })!;
		expect(out.length).toBe(120);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("looksLikeDiff / classifyDiffLines", () => {
	test("plain prose is not a diff", () => {
		expect(looksLikeDiff("renamed Foo → Bar · 3 files")).toBe(false);
		expect(classifyDiffLines("renamed Foo → Bar")).toBeNull();
	});

	test("classifies hunk/add/del/context lines", () => {
		const body = ["@@ -1 +1 @@", "-old", "+new", " unchanged"].join("\n");
		expect(looksLikeDiff(body)).toBe(true);
		expect(classifyDiffLines(body)).toEqual([
			{ cls: "hunk", text: "@@ -1 +1 @@" },
			{ cls: "del", text: "-old" },
			{ cls: "add", text: "+new" },
			{ cls: "ctx", text: " unchanged" },
		]);
	});

	test("detects a diff even when the first line is context", () => {
		const body = ["context line", "+added"].join("\n");
		const lines = classifyDiffLines(body);
		expect(lines).not.toBeNull();
		expect(lines![1]).toEqual({ cls: "add", text: "+added" });
	});
});
