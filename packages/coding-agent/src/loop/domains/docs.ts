import type { LoopDomainDefinition } from "../types";
import template from "./prompts/documentation.md" with { type: "text" };

export function createDocsDomain(): LoopDomainDefinition {
	return {
		name: "documentation",
		description: "Documentation and changelog validation",
		guidelinesTemplate: template,
		defaultGates: [
			{ id: "docs-artifacts", type: "artifact", trigger: { kind: "on-completion" }, path: "CHANGELOG.md" },
			{
				id: "docs-review",
				type: "llm-review",
				trigger: { kind: "on-completion" },
				criteria: "Validate docs updates",
			},
		],
	};
}
