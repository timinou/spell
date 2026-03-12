import { describe, expect, it } from "bun:test";
import { _resolveUpdateMethodForTest } from "../src/cli/update-cli";

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized spell is inside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.bun/bin/spell", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized spell is outside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/spell", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/spell", undefined);

		expect(method).toBe("binary");
	});
});
