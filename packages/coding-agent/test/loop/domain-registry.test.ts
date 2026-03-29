import { describe, expect, it } from "bun:test";
import { LoopDomainRegistry } from "../../src/loop/domains/registry";

describe("LoopDomainRegistry", () => {
	it("registers the six default domains", () => {
		const registry = new LoopDomainRegistry();
		expect(
			registry
				.list()
				.map(domain => domain.name)
				.sort(),
		).toEqual(["architecture", "code", "documentation", "security", "test", "ui"]);
	});

	it("rejects duplicate domains and allows plugins", () => {
		const registry = new LoopDomainRegistry();
		registry.register({ name: "custom", description: "desc", guidelinesTemplate: "template", defaultGates: [] });
		expect(registry.get("custom")?.name).toBe("custom");
		expect(() =>
			registry.register({ name: "custom", description: "dup", guidelinesTemplate: "t", defaultGates: [] }),
		).toThrow("Duplicate loop domain: custom");
	});
});
