import type {
	GrowthDiscoveredCandidate,
	GrowthFeedDigestItem,
	GrowthPersonaRecord,
	GrowthReviewRecord,
	GrowthSourceRecord,
	GrowthPublicationItem,
} from "../types";
import type { WorkflowEngine } from "../../../spell-server/src/workflow";

export interface GrowthDiscoveryActionInput {
	engine: WorkflowEngine;
	sources: GrowthSourceRecord[];
	personas: GrowthPersonaRecord[];
	candidates: GrowthDiscoveredCandidate[];
}

export interface GrowthFeedActionInput {
	items: GrowthFeedDigestItem[];
	outboxDir: string;
	maxCharacters?: number;
}

export interface GrowthPublicationExportInput {
	items: GrowthPublicationItem[];
	cmsOutboxDir: string;
	repoDraftDir: string;
}

export interface GrowthCurationWritebackInput {
	registryPath: string;
	record: GrowthSourceRecord;
	operation: "append" | "update";
	artifactDir: string;
}

export interface GrowthReviewUpsertStore {
	get(canonicalUrl: string): GrowthReviewRecord | undefined;
	set(record: GrowthReviewRecord): void;
	list(): GrowthReviewRecord[];
}
