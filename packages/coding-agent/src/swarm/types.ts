export type SwarmBlackboardEntryType = "artifact" | "contract" | "finding" | "lifecycle" | "progress";

export interface SwarmBlackboardRunContext {
	sessionId: string;
	agent: string;
	title: string;
	category?: string;
	parentId?: string;
}

export interface SwarmBlackboardEntryInput {
	type: SwarmBlackboardEntryType;
	agent: string;
	title: string;
	body: string;
	dataUri?: string;
	properties?: Record<string, string>;
}

export interface SwarmBlackboardEntry extends SwarmBlackboardEntryInput {
	id: string;
	runId: string;
	file: string;
}

export interface SwarmArtifactEvent {
	runId: string;
	entryId: string;
	agent: string;
	dataUri: string;
	type: SwarmBlackboardEntryType;
}
