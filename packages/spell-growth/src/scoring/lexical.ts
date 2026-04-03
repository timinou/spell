import type { GrowthDiscoveredCandidate, GrowthPersonaRecord, GrowthPersonaScore } from "../types";

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function scoreCandidate(
	candidate: GrowthDiscoveredCandidate,
	personas: GrowthPersonaRecord[],
): GrowthPersonaScore[] {
	const haystack = `${candidate.title}\n${candidate.summary ?? ""}`.toLowerCase();
	return personas
		.map(persona => {
			const matchedKeywords = uniqueSorted(
				persona.keywords.filter(keyword => haystack.includes(keyword.toLowerCase())),
			);
			const matchedChallenges = uniqueSorted(
				persona.challenges.filter(challenge => haystack.includes(challenge.toLowerCase())),
			);
			const score = matchedKeywords.length * 3 + matchedChallenges.length * 2;
			const rationale =
				matchedKeywords.length === 0 && matchedChallenges.length === 0
					? `Low lexical overlap with ${persona.name}.`
					: `Matched ${matchedKeywords.length} keyword(s) and ${matchedChallenges.length} challenge phrase(s) for ${persona.name}.`;
			return {
				persona,
				score,
				matchedKeywords,
				matchedChallenges,
				rationale,
			} satisfies GrowthPersonaScore;
		})
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			if (right.matchedKeywords.length !== left.matchedKeywords.length) {
				return right.matchedKeywords.length - left.matchedKeywords.length;
			}
			return left.persona.slug.localeCompare(right.persona.slug);
		});
}
