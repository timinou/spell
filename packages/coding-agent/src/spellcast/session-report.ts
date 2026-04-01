import type { SpellcastSessionContext } from "./index";

function pluralize(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}

export function formatSpellcastSessionReport(context: SpellcastSessionContext): string {
	const { discoveredManifests, publishState, discovery } = context;
	const warnings = discovery.warnings;
	if (discoveredManifests.length === 0 && warnings.length === 0) {
		return "";
	}

	const manifestSummary =
		discoveredManifests.length === 0
			? ""
			: `Found ${discoveredManifests.length} ${pluralize(discoveredManifests.length, "spellcast", "spellcasts")}: ${discoveredManifests
					.map(item => {
						const state = publishState[item.manifestPath];
						return state
							? `${item.manifest.name} (published, ${state.appUrl})`
							: `${item.manifest.name} (draft)`;
					})
					.join(", ")}`;

	const warningSummary =
		warnings.length === 0
			? ""
			: `Spellcast warnings (${warnings.length}): ${warnings.join(" | ")}`;

	return [manifestSummary, warningSummary].filter(Boolean).join("\n");
}
