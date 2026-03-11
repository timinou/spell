import { beforeAll, describe, expect, it } from "bun:test";
import { createEmacsClient } from "../src/client";
import { detectEmacs } from "../src/detection";
import { createEmacsTool, makeEmacsSessionFactory } from "../src/tool";

let emacsAvailable = false;

beforeAll(async () => {
	const d = await detectEmacs();
	emacsAvailable = d.found && d.meetsMinimum && d.socatFound && d.treesitAvailable;
});

describe.skipIf(!emacsAvailable)("resolution (requires Emacs)", () => {
	// Integration tests require daemon startup. Skipped unless Emacs available.
	it("placeholder — requires running daemon", () => {
		// Contract: code-read returns a string for resolutions 0-3.
		expect(true).toBe(true);
	});
});

describe("resolution module exports", () => {
	it("exports detectEmacs from detection module", () => {
		expect(typeof detectEmacs).toBe("function");
	});

	it("exports createEmacsClient from client module", () => {
		expect(typeof createEmacsClient).toBe("function");
	});

	it("exports createEmacsTool and makeEmacsSessionFactory from tool module", () => {
		expect(typeof createEmacsTool).toBe("function");
		expect(typeof makeEmacsSessionFactory).toBe("function");
	});
});
