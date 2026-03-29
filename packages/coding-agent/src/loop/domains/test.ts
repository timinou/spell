import type { LoopDomainDefinition } from "../types";
import template from "./prompts/test.md" with { type: "text" };

export function createTestDomain(): LoopDomainDefinition {
	return {
		name: "test",
		description: "Focused test validation",
		guidelinesTemplate: template,
		defaultGates: [{ id: "test-suite", type: "command", trigger: { kind: "on-completion" }, command: "bun test" }],
	};
}
