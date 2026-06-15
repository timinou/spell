import { describe, expect, it } from "bun:test";
import { editSchema } from "../src/tools/codepath-types";

describe("edit tool schema", () => {
	it("does not expose recursive child operations", () => {
		const serialized = JSON.stringify(editSchema);

		expect(serialized).not.toContain("$ref");
		expect(serialized).not.toContain("Nested child target operations");
		expect(serialized).not.toContain('"children"');
	});
});
