import type { LoopDomainDefinition } from "../types";
import template from "./prompts/code.md" with { type: "text" };

export function createCodeDomain(): LoopDomainDefinition {
	return {
		name: "code",
		description: "Compile, lint, and formatting validation",
		guidelinesTemplate: template,
		defaultGates: [
			{ id: "code-compile", type: "command", trigger: { kind: "on-completion" }, command: "bun check:ts" },
			{ id: "code-format", type: "command", trigger: { kind: "on-completion" }, command: "bun lint:ts" },
		],
	};
}
