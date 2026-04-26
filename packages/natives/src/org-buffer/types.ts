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
	body?: string | null;
	append?: string;
	mode?: string;
	itemStart?: number;
	itemEnd?: number;
	id?: string;
	title?: string;
	state?: string;
	properties?: Record<string, string>;
	sessionId?: string;
	transcriptPath?: string;
	initialMessage?: string;
	note?: string;
	property?: string;
	value?: string;
	root?: string;
	categories?: Array<{ absPath: string; name: string; dir: string; prefix?: string }>;
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
