import { ActionRegistry } from "./registry";
import type { ActionDescriptor } from "./types";

export * from "./registry";
export * from "./types";

const BUILTIN_ACTION_DESCRIPTORS: ActionDescriptor[] = [
	{
		id: "spell.noop",
		source: "first-party",
	},
	{
		id: "spell.prompt",
		source: "first-party",
		params: {
			prompt: {
				type: "string",
				required: true,
			},
		},
	},
];

export function createBuiltinActionRegistry(): ActionRegistry {
	const registry = new ActionRegistry();
	registry.registerMany(BUILTIN_ACTION_DESCRIPTORS);
	return registry;
}

export function getBuiltinActionDescriptors(): ActionDescriptor[] {
	return BUILTIN_ACTION_DESCRIPTORS.map(descriptor => structuredClone(descriptor));
}
