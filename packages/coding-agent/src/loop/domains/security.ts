import type { LoopDomainDefinition } from "../types";
import template from "./prompts/security.md" with { type: "text" };

export function createSecurityDomain(): LoopDomainDefinition {
	return {
		name: "security",
		description: "Secret and dependency hygiene",
		guidelinesTemplate: template,
		defaultGates: [
			{ id: "security-scan", type: "command", trigger: { kind: "on-completion" }, command: "git grep -n 'SECRET'" },
		],
	};
}
