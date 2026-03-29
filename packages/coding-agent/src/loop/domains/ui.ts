import type { LoopDomainDefinition } from "../types";
import template from "./prompts/ui.md" with { type: "text" };

export function createUiDomain(): LoopDomainDefinition {
	return {
		name: "ui",
		description: "Visual artifact validation",
		guidelinesTemplate: template,
		defaultGates: [
			{ id: "ui-artifacts", type: "artifact", trigger: { kind: "on-completion" }, path: "artifacts/ui.png" },
		],
	};
}
