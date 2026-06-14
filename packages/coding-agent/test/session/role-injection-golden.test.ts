/**
 * Golden capture of role-context injection (FEAT-816 W4.1).
 *
 * The Option-A cutover routes role injection through the SAME shared discipline
 * mechanism as tool-disciplines (injectBody + cadence). These goldens pin the
 * exact injected content for the project roles BEFORE the cutover so the
 * mechanism swap is provably behaviour-preserving for the sections roles use
 * (context/instructions/focus-areas). Examples/custom sections were never read
 * by the old `#buildUserModeMessage`, so the cutover INTENTIONALLY widens to
 * cover them — asserted separately in the discipline unit tests.
 */
import { describe, expect, test } from "bun:test";

import type { ModeConfigSections } from "@spell/pi-coding-agent/capability/mode";
import { injectBody } from "@spell/pi-coding-agent/config/discipline";

/** Mirror of the legacy `#buildUserModeMessage` content join (the 3 role sections). */
function legacyRoleContent(sections: ModeConfigSections): string {
	const { context, instructions, focusAreas } = sections;
	return [context, instructions, focusAreas]
		.map(s => s?.trim())
		.filter((s): s is string => !!s)
		.join("\n\n");
}

describe("role injection golden — legacy vs unified injectBody parity", () => {
	const cases: Array<{ name: string; sections: ModeConfigSections }> = [
		{
			name: "all three sections",
			sections: { context: "the goal", instructions: "do x", focusAreas: "watch y", custom: {} },
		},
		{ name: "context only", sections: { context: "just ctx", custom: {} } },
		{ name: "instructions only", sections: { instructions: "just do", custom: {} } },
		{ name: "trailing whitespace trimmed", sections: { context: "  ctx  ", instructions: "do\n", custom: {} } },
		{ name: "empty", sections: { custom: {} } },
	];

	for (const { name, sections } of cases) {
		test(`parity: ${name}`, () => {
			// For the three role sections, the unified injectBody must produce
			// byte-identical output to the legacy join.
			expect(injectBody({ cadence: "carry", sections })).toBe(legacyRoleContent(sections));
		});
	}

	test("unified path additionally covers examples/custom (intentional widening)", () => {
		const sections: ModeConfigSections = { examples: "ex", custom: { extra: "cust" } };
		// Legacy dropped these; unified keeps them. Documents the intended behaviour change.
		expect(legacyRoleContent(sections)).toBe("");
		expect(injectBody({ cadence: "carry", sections })).toContain("ex");
		expect(injectBody({ cadence: "carry", sections })).toContain("cust");
	});
});
