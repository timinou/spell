import type { DiscoveredSpellcastManifest, SpellcastManifestDiscoveryResult } from "./discovery";
import type { SpellcastManifestVisibility } from "./manifest";

export * from "./discovery";
export * from "./manifest";

export interface SpellcastPublishState {
	manifestPath: string;
	appId: string;
	appUrl: string;
	visibility: SpellcastManifestVisibility;
	updatedAt: string;
	contentHash?: string;
}

export type SpellcastPublishStateIndex = Record<string, SpellcastPublishState>;

export interface SpellcastSessionContext {
	discovery: SpellcastManifestDiscoveryResult;
	discoveredManifests: DiscoveredSpellcastManifest[];
	publishState: SpellcastPublishStateIndex;
}
