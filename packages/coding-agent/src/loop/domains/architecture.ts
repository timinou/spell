import type { LoopDomainDefinition } from "../types";
import template from "./prompts/architecture.md" with { type: "text" };

export function createArchitectureDomain(): LoopDomainDefinition {
	return {
		name: "architecture",
		description: "Contract and dependency review",
		guidelinesTemplate: template,
		defaultGates: [
			{
				id: "architecture-review",
				type: "llm-review",
				trigger: { kind: "on-reflection" },
				criteria: "Validate architecture invariants",
			},
		],
	};
}
