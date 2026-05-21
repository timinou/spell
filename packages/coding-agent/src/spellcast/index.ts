/**
 * @deprecated Spellcast (shareable spell packages) is currently inactive.
 * Tracked for reactivation + KDL manifest format change in FEAT-757.
 * Per PLAN-311 WAVE 5, no new code should extend this directory until
 * the follow-up work is scheduled.
 */
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
