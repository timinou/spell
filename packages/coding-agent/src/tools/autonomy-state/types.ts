import type { OutputMeta } from "../output-meta";

export type AutonomyStateOperation =
	| { op: "get"; key: string }
	| { op: "set"; key: string; value: unknown }
	| { op: "list" }
	| { op: "delete"; key: string }
	| { op: "get_metadata" };

export interface RunMetadata {
	runId: string;
	startedAt: string;
	status: string;
	duration?: number;
	outputSummary?: string;
}

export interface AutonomyStateResult {
	success: boolean;
	value?: unknown;
	keys?: string[];
	metadata?: RunMetadata;
	error?: string;
	meta?: OutputMeta;
}

export interface StateSchemaColumn {
	name: string;
	type: "string" | "number" | "boolean" | "json";
}
