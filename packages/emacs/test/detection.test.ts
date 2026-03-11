import { describe, expect, it } from "bun:test";
import { detectEmacs } from "../src/detection";

// Detection tests run always — they just test that detection works,
// not that Emacs is available.
describe("detectEmacs", () => {
	it("returns an object with the expected shape", async () => {
		const result = await detectEmacs();
		expect(result).toHaveProperty("found");
		expect(result).toHaveProperty("meetsMinimum");
		expect(result).toHaveProperty("socatFound");
		expect(result).toHaveProperty("treesitAvailable");
		expect(result).toHaveProperty("errors");
		expect(Array.isArray(result.errors)).toBe(true);
	});

	it("when emacs not found, path and version are null", async () => {
		// Call with a guaranteed-bad path.
		const result = await detectEmacs("/nonexistent/emacs");
		// Either found=false (bad path forced) or found=true (PATH emacs found anyway)
		// We can't assert found=false because PATH may have emacs.
		// What we can assert: shape is always correct.
		expect(typeof result.found).toBe("boolean");
		if (!result.found) {
			expect(result.path).toBeNull();
			expect(result.version).toBeNull();
			expect(result.meetsMinimum).toBe(false);
		}
	});

	it("treesitAvailable is false when emacs not found", async () => {
		const result = await detectEmacs("/nonexistent/emacs");
		if (!result.found) {
			// When emacs not found, treesit can't be checked — must be false.
			expect(result.treesitAvailable).toBe(false);
		}
	});
});
