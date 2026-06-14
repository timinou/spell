import { describe, expect, it } from "bun:test";
import {
	classifyDiffLines,
	classifyEditResult,
	looksLikeDiff,
	summariseArgs,
} from "../../src/detail/chat-presentation";

describe("summariseArgs", () => {
	it("returns null for non-object input", () => {
		expect(summariseArgs(undefined)).toBeNull();
		expect(summariseArgs(null)).toBeNull();
		expect(summariseArgs("x")).toBeNull();
	});
	it("picks the highest-priority identifying field", () => {
		expect(summariseArgs({ target: "a.ts::Foo", path: "b.ts" })).toBe("a.ts::Foo");
		expect(summariseArgs({ command: "cargo build" })).toBe("cargo build");
	});
	it("falls back to a capped key list", () => {
		expect(summariseArgs({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe("a, b, c, d");
	});
	it("ignores empty/nullish primaries", () => {
		expect(summariseArgs({ target: "", path: "real.ts" })).toBe("real.ts");
		expect(summariseArgs({ target: null, file: undefined })).toBeNull();
	});
	it("truncates over-long values to exactly the cap with an ellipsis", () => {
		const out = summariseArgs({ target: "x".repeat(200) })!;
		expect(out.length).toBe(120);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("classifyDiffLines", () => {
	it("returns null for plain prose", () => {
		expect(looksLikeDiff("renamed Foo → Bar")).toBe(false);
		expect(classifyDiffLines("renamed Foo → Bar")).toBeNull();
	});
	it("does NOT treat markdown bullet lists as a diff (needs a @@ hunk)", () => {
		const md = "On your points:\n- first item\n- second item\n+ not a diff";
		expect(looksLikeDiff(md)).toBe(false);
		expect(classifyDiffLines(md)).toBeNull();
	});
	it("classifies hunk/add/del/context", () => {
		const body = ["@@ -1 +1 @@", "-old", "+new", " ctx"].join("\n");
		expect(classifyDiffLines(body)).toEqual([
			{ cls: "hunk", text: "@@ -1 +1 @@" },
			{ cls: "del", text: "-old" },
			{ cls: "add", text: "+new" },
			{ cls: "ctx", text: " ctx" },
		]);
	});
});

describe("classifyEditResult", () => {
	it("only classifies edit tool", () => {
		expect(classifyEditResult("bash", "undo · x")).toBeNull();
	});
	it("detects undo/redo/declined", () => {
		expect(classifyEditResult("edit", "undo · packages/x.ts")).toBe("undo");
		expect(classifyEditResult("edit", "redo · packages/x.ts")).toBe("redo");
		expect(classifyEditResult("edit", "undo declined: already committed — x")).toBe("declined");
	});
	it("returns null for normal edits", () => {
		expect(classifyEditResult("edit", "renamed Foo → Bar · 3 files")).toBeNull();
	});
});
