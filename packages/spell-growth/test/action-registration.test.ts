import { describe, expect, it } from "bun:test";
import { createServerActionRegistry } from "../../spell-server/src/actions";
import { getGrowthActionDescriptors } from "../src/index";

describe("action registration", () => {
	it("loads growth actions with explicit empty param and prompt contracts", () => {
		const registry = createServerActionRegistry();
		expect(registry.get("growth.discovery")).toEqual({
			id: "growth.discovery",
			source: "first-party",
			params: {},
			promptSlots: {},
		});
		expect(getGrowthActionDescriptors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "growth.discovery", params: {}, promptSlots: {} }),
				expect.objectContaining({ id: "growth.feed.send", params: {}, promptSlots: {} }),
				expect.objectContaining({ id: "growth.export.publish", params: {}, promptSlots: {} }),
				expect.objectContaining({ id: "growth.curation.writeback", params: {}, promptSlots: {} }),
			]),
		);
	});
});
