import type { WebConfig } from "../../config/types";

export interface ArtifactCreatedEvent {
	sessionId: string;
	uri: string;
	agent: string;
	tool: string;
	filename: string;
	ext: string;
	mime: string;
	sizeBytes: number;
	ts: number;
}

export interface ArtifactRequestDeps {
	/**
	 * Resolve a session id to its on-disk artifact root directory. Wirer
	 * fills this from the unified session registry.
	 */
	sessionRoots: (sessionId: string) => string | undefined;
	web: WebConfig | undefined;
	signingKey: Buffer;
}

export interface ArtifactRef {
	sessionId: string;
	agent: string;
	tool: string;
	filename: string;
}
