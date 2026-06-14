import { describe, expect, it } from "bun:test";
import { buildLensTarget, LENSES, nodeLocation } from "../../src/detail/code-lens";

describe("buildLensTarget", () => {
	it("returns null for an empty base", () => {
		expect(buildLensTarget("", "callers")).toBeNull();
		expect(buildLensTarget("   ", "type")).toBeNull();
	});
	it("appends the right graph edge / qualifier per lens", () => {
		const b = "src/foo.ts::Bar.method";
		expect(buildLensTarget(b, "callers")).toBe(`${b} def→`);
		expect(buildLensTarget(b, "definition")).toBe(`${b} ref→`);
		expect(buildLensTarget(b, "implementers")).toBe(`${b} implements→`);
		expect(buildLensTarget(b, "baseTypes")).toBe(`${b} inherits→`);
		expect(buildLensTarget(b, "type")).toBe(`${b}#hover`);
		expect(buildLensTarget(b, "outline")).toBe(`${b}#outline`);
		expect(buildLensTarget(b, "diagnostics")).toBe(`${b}#diagnostics`);
	});
	it("trims the base before composing", () => {
		expect(buildLensTarget("  a.ts  ", "outline")).toBe("a.ts#outline");
	});
	it("has a spec for every lens kind it builds", () => {
		for (const spec of LENSES) {
			expect(buildLensTarget("x.ts", spec.kind)).toBeTruthy();
		}
	});
});

describe("nodeLocation", () => {
	it("formats path:line, line optional", () => {
		expect(nodeLocation({ path: "a.ts", line: 12 })).toBe("a.ts:12");
		expect(nodeLocation({ path: "a.ts" })).toBe("a.ts");
		expect(nodeLocation({})).toBe("");
	});
});
