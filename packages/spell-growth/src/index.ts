import type { ActionDescriptor, ActionRegistry } from "../../spell-server/src/actions";

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

const GROWTH_ACTIONS: ActionDescriptor[] = [
	{ id: "growth.discovery", source: "first-party" },
	{ id: "growth.feed.send", source: "first-party" },
	{ id: "growth.export.publish", source: "first-party" },
	{ id: "growth.curation.writeback", source: "first-party" },
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
