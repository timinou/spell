/**
 * Tests for extractPlanWaves — the sole bridge between plan body text and
 * structured wave data consumed by the executor.
 *
 * Contracts:
 *   - Wave headings are `** <name> :wave:` with arbitrary internal whitespace
 *   - Entries are `- [[id:<orgItemId>]] <step>` lines beneath a wave heading
 *   - Returns undefined when no :wave: headings exist
 *   - Entries before any wave heading are discarded
 *   - Empty waves (heading with no entries) are preserved
 *   - Top-level IDs (no `::` separator) work as orgItemId
 *
 * PlanWave is the canonical intermediate representation for todo auto-init.
 * `extractPlanWaves` produces PlanWave[] directly from the PLAN body so plan
 * approval no longer depends on an org-fluid-plan MCP round-trip.
 * Canvas mode computes its own PlanWave[] from FluidPlan DAG data.
 * Both paths converge on the same todo materialization logic.
 */

import { describe, expect, test } from "bun:test";
import { extractPlanWaves } from "../../src/tools/exit-plan-mode";

describe("extractPlanWaves", () => {
	test("extracts multi-wave structure with correct names and entries", () => {
		const body = `* Execution Manifest
** foundation                                      :wave:
- [[id:FEAT-001::define-types]] Define TypeScript interfaces
- [[id:FEAT-002::define-schema]] Define parser schema types
** core                                            :wave:
- [[id:FEAT-001::implement-parser]] Implement parser logic
** verify                                          :wave:
- [[id:FEAT-001::write-tests]] Write parser tests`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(3);

		expect(waves![0].name).toBe("foundation");
		expect(waves![0].entries).toHaveLength(2);
		expect(waves![0].entries[0]).toEqual({
			id: "FEAT-001::define-types",
			orgItemId: "FEAT-001::define-types",
			step: "Define TypeScript interfaces",
		});
		expect(waves![0].entries[1]).toEqual({
			id: "FEAT-002::define-schema",
			orgItemId: "FEAT-002::define-schema",
			step: "Define parser schema types",
		});

		expect(waves![1].name).toBe("core");
		expect(waves![1].entries).toHaveLength(1);
		expect(waves![1].entries[0].orgItemId).toBe("FEAT-001::implement-parser");

		expect(waves![2].name).toBe("verify");
		expect(waves![2].entries).toHaveLength(1);
		expect(waves![2].entries[0].orgItemId).toBe("FEAT-001::write-tests");
	});

	test("returns undefined for body without wave headings", () => {
		const body = `* Execution Manifest
- [[id:FEAT-001]] Some entry
- [[id:FEAT-002]] Another entry

Some other text.`;

		expect(extractPlanWaves(body)).toBeUndefined();
	});

	test("entries before any wave heading are ignored", () => {
		const body = `- [[id:FEAT-000]] Orphan entry
** wave-1                                          :wave:
- [[id:FEAT-001::a]] Step A`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].entries).toHaveLength(1);
		expect(waves![0].entries[0].orgItemId).toBe("FEAT-001::a");
	});

	test("wave heading with no entries produces empty wave", () => {
		const body = `** empty-wave                                      :wave:
** next-wave                                       :wave:
- [[id:FEAT-001::a]] Step A`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(2);
		expect(waves![0].name).toBe("empty-wave");
		expect(waves![0].entries).toHaveLength(0);
		expect(waves![1].name).toBe("next-wave");
		expect(waves![1].entries).toHaveLength(1);
	});

	test("handles minimal whitespace in wave heading", () => {
		const body = `** foundation :wave:
- [[id:FEAT-001::a]] Step A`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].name).toBe("foundation");
		expect(waves![0].entries).toHaveLength(1);
	});

	test("non-wave headings reset the active wave section", () => {
		const body = `** wave-1                                          :wave:
		- [[id:FEAT-001::a]] Step A
		** Some other heading
		- [[id:FEAT-002::b]] Step B
		** wave-2                                          :wave:
		- [[id:FEAT-003::c]] Step C`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(2);

		expect(waves![0].name).toBe("wave-1");
		expect(waves![0].entries).toHaveLength(1);
		expect(waves![0].entries[0].orgItemId).toBe("FEAT-001::a");

		expect(waves![1].name).toBe("wave-2");
		expect(waves![1].entries).toHaveLength(1);
		expect(waves![1].entries[0].orgItemId).toBe("FEAT-003::c");
	});

	test("top-level IDs without :: separator work as orgItemId", () => {
		const body = `** wave-1                                          :wave:
- [[id:FEAT-001]] Full feature implementation`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].entries).toHaveLength(1);
		expect(waves![0].entries[0]).toEqual({
			id: "FEAT-001",
			orgItemId: "FEAT-001",
			step: "Full feature implementation",
		});
	});

	test("parses entries with description-style id links", () => {
		const body = `** wave-1                                          :wave:
- [[id:FEAT-001::step-a][FEAT-001]] Step A`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].entries).toHaveLength(1);
		expect(waves![0].entries[0]).toEqual({
			id: "FEAT-001::step-a",
			orgItemId: "FEAT-001::step-a",
			step: "Step A",
		});
	});

	test("handles mixed plain and description-form entries in the same wave", () => {
		const body = `** foundation                                      :wave:
- [[id:FEAT-001]] Plain entry
- [[id:FEAT-002][FEAT-002]] Description entry`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].entries).toHaveLength(2);
		expect(waves![0].entries[0].orgItemId).toBe("FEAT-001");
		expect(waves![0].entries[1].orgItemId).toBe("FEAT-002");
	});

	test("description-form entry with longer display text is fully parsed", () => {
		const body = `** verify                                          :wave:
- [[id:BUG-192-fix-extractplanwaves][BUG-192]] Fix extractPlanWaves regex rejecting description-style id links`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(1);
		expect(waves![0].entries).toHaveLength(1);
		expect(waves![0].entries[0]).toEqual({
			id: "BUG-192-fix-extractplanwaves",
			orgItemId: "BUG-192-fix-extractplanwaves",
			step: "Fix extractPlanWaves regex rejecting description-style id links",
		});
	});

	test("ignores readable DAG sections after wave sections", () => {
		const body = `* Execution Manifest
** wave-1                                          :wave:
- [[id:FEAT-001::types]] Define types
** File-level DAG
*** Nodes
- \`FEAT-001\` Feature 001 [ITEM]
- \`FEAT-002\` Feature 002 [ITEM]
*** Edges
- \`FEAT-002\` depends on \`FEAT-001\`
** Subfeature-level DAG
*** Nodes
- \`FEAT-001::types\` Define types [ITEM]
- \`FEAT-002::impl\` Implement [ITEM]
*** Edges
- \`FEAT-002::impl\` depends on \`FEAT-001::types\``;

		const waves = extractPlanWaves(body);

		expect(waves).toEqual([
			{
				name: "wave-1",
				entries: [{ id: "FEAT-001::types", orgItemId: "FEAT-001::types", step: "Define types" }],
			},
		]);
	});
});
