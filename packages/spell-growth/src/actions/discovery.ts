import type { WorkflowEngine } from "@oh-my-pi/spell-server";
import type { GrowthDiscoveryActionInput, GrowthReviewUpsertStore } from "./types";
import type { GrowthReviewRecord } from "../types";
import { dedupeCandidates } from "../discovery/canonicalize";
import { scoreCandidate } from "../scoring/lexical";
import { createGrowthReviewApprovalActions } from "../workflow/presets";

export class InMemoryReviewStore implements GrowthReviewUpsertStore {
	#records = new Map<string, GrowthReviewRecord>();

	get(canonicalUrl: string): GrowthReviewRecord | undefined {
		const record = this.#records.get(canonicalUrl);
		return record ? structuredClone(record) : undefined;
	}

	set(record: GrowthReviewRecord): void {
		this.#records.set(record.candidate.canonicalUrl, structuredClone(record));
	}

	list(): GrowthReviewRecord[] {
		return [...this.#records.values()].map(record => structuredClone(record));
	}
}

export function ingestDiscoveryCandidates(
	input: GrowthDiscoveryActionInput & { store?: GrowthReviewUpsertStore },
): GrowthReviewRecord[] {
	const store = input.store ?? new InMemoryReviewStore();
	const deduped = dedupeCandidates(input.candidates);
	const records: GrowthReviewRecord[] = [];
	for (const candidate of deduped) {
		const existing = store.get(candidate.canonicalUrl);
		if (existing) {
			records.push(existing);
			continue;
		}
		const reviewItem = input.engine.createApproval({
			workflowId: "growth-review",
			targetId: candidate.canonicalUrl,
			title: candidate.title,
			summary: candidate.summary,
			actions: createGrowthReviewApprovalActions(),
			metadata: {
				canonicalUrl: candidate.canonicalUrl,
				sourceSlug: candidate.sourceSlug,
			},
		});
		const record: GrowthReviewRecord = {
			candidate,
			scores: scoreCandidate(candidate, input.personas),
			reviewItemId: reviewItem.id,
		};
		store.set(record);
		records.push(record);
	}
	return records;
}
