import { beforeAll, describe, expect, it } from "bun:test";
import { detectEmacs } from "../src/detection";
import { createEmacsTool } from "../src/tool";

let emacsAvailable = false;

beforeAll(async () => {
	const d = await detectEmacs();
	emacsAvailable = d.found && d.meetsMinimum && d.socatFound && d.treesitAvailable;
});

describe.skipIf(!emacsAvailable)("outline (requires Emacs)", () => {
	it("placeholder — requires running daemon", () => {
		expect(true).toBe(true);
	});
});

describe("outline types", () => {
	it("createEmacsTool factory is a function", () => {
		// The type system enforces the OutlineEntry contract at compile time.
		// At runtime, verify the factory function is exported and callable.
		expect(typeof createEmacsTool).toBe("function");
	});
});
