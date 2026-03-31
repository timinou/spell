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
 * Note on type hierarchy: extractPlanWaves produces PlanWave[] (text-extracted,
 * name-based). The org package has a separate ComputedWave type (elisp-computed,
 * number-based) used by formatWaveManifest. These serve different code paths:
 * ComputedWave is for elisp -> TS manifest generation, PlanWave is for
 * plan body -> executor. They don't interact and the split is intentional.
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
			orgItemId: "FEAT-001::define-types",
			step: "Define TypeScript interfaces",
		});
		expect(waves![0].entries[1]).toEqual({
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

	test("non-wave headings between waves accumulate entries into preceding wave", () => {
		// This test documents current behavior: extractPlanWaves does NOT reset
		// `current` on non-wave `**` headings. The entry regex matches any
		// `- [[id:...]]` line while current is set, so entries under a non-wave
		// heading are added to the last active wave.
		//
		// This is a known limitation (not a bug for current usage, since plan
		// bodies are generated with waves only). If this behavior changes in the
		// future, update this test accordingly.
		const body = `** wave-1                                          :wave:
- [[id:FEAT-001::a]] Step A
** Some other heading
- [[id:FEAT-002::b]] Step B
** wave-2                                          :wave:
- [[id:FEAT-003::c]] Step C`;

		const waves = extractPlanWaves(body);
		expect(waves).toBeDefined();
		expect(waves).toHaveLength(2);

		// FEAT-002::b leaks into wave-1 because current is not reset on non-wave headings
		expect(waves![0].name).toBe("wave-1");
		expect(waves![0].entries).toHaveLength(2);
		expect(waves![0].entries[0].orgItemId).toBe("FEAT-001::a");
		expect(waves![0].entries[1].orgItemId).toBe("FEAT-002::b");

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
			orgItemId: "FEAT-001",
			step: "Full feature implementation",
		});
	});
});
