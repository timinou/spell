import { beforeAll, describe, expect, it } from "bun:test";
import { startEmacsSession } from "../src/daemon";
import { detectEmacs } from "../src/detection";

let emacsAvailable = false;

beforeAll(async () => {
	const d = await detectEmacs();
	emacsAvailable = d.found && d.meetsMinimum && d.socatFound && d.treesitAvailable;
});

describe.skipIf(!emacsAvailable)("buffer management (requires Emacs)", () => {
	it("placeholder — requires running daemon", () => {
		expect(true).toBe(true);
	});
});

describe("buffer module", () => {
	it("startEmacsSession is exported from daemon module", () => {
		expect(typeof startEmacsSession).toBe("function");
	});
});
