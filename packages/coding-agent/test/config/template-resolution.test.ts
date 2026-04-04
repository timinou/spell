import { describe, expect, it } from "bun:test";

import { parseTaskPoliciesKdl } from "../../src/config/task-policies-kdl";
import { resolveTemplate, TEMPLATE_NAMESPACES } from "../../src/templates/index";

describe("template resolution", () => {
	it("resolves every built-in namespace to non-empty KDL", () => {
		for (const namespace of TEMPLATE_NAMESPACES) {
			const template = resolveTemplate(namespace);

			expect(template).toBeDefined();
			expect(template?.trim().length).toBeGreaterThan(0);
		}
	});

	it("returns undefined for unknown namespaces", () => {
		expect(resolveTemplate("spell.unknown.template")).toBeUndefined();
	});

	it("parses every template as valid task policy KDL", () => {
		for (const namespace of TEMPLATE_NAMESPACES) {
			const template = resolveTemplate(namespace);
			expect(template).toBeDefined();
			if (!template) {
				throw new Error(`Expected built-in template for ${namespace}`);
			}

			const parsed = parseTaskPoliciesKdl(template);
			expect(parsed).toBeDefined();
			if (!parsed) {
				throw new Error(`Expected ${namespace} template to parse as task policy KDL`);
			}

			expect(Object.keys(parsed.layers).length).toBeGreaterThan(0);
			expect(parsed.policies.length).toBeGreaterThan(0);
		}
	});
});
