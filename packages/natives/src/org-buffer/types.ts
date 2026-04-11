export interface OrgBufferOptions {
	command: string;
	source?: string;
	todoKeywords?: string[];
	category?: string;
	dir?: string;
	file?: string;
	includeBody?: boolean;
	query?: string;
	filter?: Record<string, unknown>;
	items?: unknown[];
	doneStates?: string[];
	section?: string;
	body?: string;
	mode?: string;
	itemStart?: number;
	itemEnd?: number;
}

export interface OrgBufferResult {
	output: unknown;
	error: boolean;
}

declare module "../bindings" {
	interface NativeBindings {
		executeOrg(options: OrgBufferOptions): OrgBufferResult;
	}
}
