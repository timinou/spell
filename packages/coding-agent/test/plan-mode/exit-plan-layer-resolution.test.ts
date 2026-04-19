import { describe, expect, test } from "bun:test";
import { resolveLayerFromProperties } from "../../src/config/task-policies";
import { extractPlanWaves } from "../../src/tools/exit-plan-mode";

describe("exit plan sub-outline layer resolution", () => {
	test("layer_resolution_uses_parent_layer_when_sub_outline_has_no_own", () => {
		const waves = extractPlanWaves(
			["* Execution Manifest", "** wave-1 :wave:", "- [[id:FEAT-A::api]] Define API"].join("\n"),
		);
		expect(waves).toBeDefined();
		const entry = waves?.[0]?.entries[0];
		expect(entry?.orgItemId).toBe("FEAT-A::api");
		const layer = resolveLayerFromProperties(entry?.orgItemId, itemId => {
			if (itemId === "FEAT-A::api") return {} as Record<string, string>;
			if (itemId === "FEAT-A") return { LAYER: "backend" };
			return undefined;
		});
		expect(layer).toBe("backend");
	});
});
