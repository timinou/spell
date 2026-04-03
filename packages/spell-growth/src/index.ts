import type { ActionDescriptor, ActionRegistry } from "@oh-my-pi/spell-server";

export * from "./actions/curation-writeback";
export * from "./actions/discovery";
export * from "./actions/export-publish";
export * from "./actions/feed-send";
export * from "./actions/types";
export * from "./discovery/canonicalize";
export * from "./discovery/planner";
export * from "./discovery/providers/exa";
export * from "./registries/persona-loader";
export * from "./registries/source-loader";
export * from "./registries/types";
export * from "./scoring/lexical";
export * from "./types";
export * from "./workflow/presets";

import { EMPTY_GROWTH_ACTION_PARAMS, EMPTY_GROWTH_ACTION_PROMPT_SLOTS } from "./actions/types";

const GROWTH_ACTIONS: ActionDescriptor[] = [
	{
		id: "growth.discovery",
		source: "first-party",
		params: EMPTY_GROWTH_ACTION_PARAMS,
		promptSlots: EMPTY_GROWTH_ACTION_PROMPT_SLOTS,
	},
	{
		id: "growth.feed.send",
		source: "first-party",
		params: EMPTY_GROWTH_ACTION_PARAMS,
		promptSlots: EMPTY_GROWTH_ACTION_PROMPT_SLOTS,
	},
	{
		id: "growth.export.publish",
		source: "first-party",
		params: EMPTY_GROWTH_ACTION_PARAMS,
		promptSlots: EMPTY_GROWTH_ACTION_PROMPT_SLOTS,
	},
	{
		id: "growth.curation.writeback",
		source: "first-party",
		params: EMPTY_GROWTH_ACTION_PARAMS,
		promptSlots: EMPTY_GROWTH_ACTION_PROMPT_SLOTS,
	},
];

export function registerGrowthActions(registry: ActionRegistry): void {
	for (const descriptor of GROWTH_ACTIONS) {
		if (!registry.has(descriptor.id)) {
			registry.register(descriptor);
		}
	}
}

export function getGrowthActionDescriptors(): ActionDescriptor[] {
	return GROWTH_ACTIONS.map(descriptor => structuredClone(descriptor));
}
