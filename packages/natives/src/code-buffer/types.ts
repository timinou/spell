export interface CodeAction {
	kind: string;
	scope?: "target" | "body";
	content?: string;
	find?: string;
	mode?: string;
	direction?: "up" | "down";
	line?: number;
	column?: number;
	nodeType?: string;
	allowSiblingDelete?: boolean;
	occurrence?: "first" | "last" | "all" | number;
}

export interface CodeOperation {
	targetId: string;
	actions: CodeAction[];
	children?: CodeOperation[];
}

export interface CodeProofData {
	basis?: string;
	reason?: string;
	confidence?: string;
	matches?: number | null;
}

export interface CodeEditTargetSummary {
	targetId: string;
	actions: string[];
	children?: CodeEditTargetSummary[];
}

export interface CodeEditOutput {
	version?: number;
	diff?: string;
	editCount?: number;
	created?: boolean;
	targets?: CodeEditTargetSummary[];
	proof?: CodeProofData;
}

export interface CodeErrorOutput {
	code?: string;
	message?: string;
	targetId?: string;
	action?: string;
	proof?: CodeProofData;
	lostDecls?: string[];
	targetSpan?: { start?: number; end?: number };
	budgetMs?: number;
}

export interface CodeBufferOptions {
	command: string;
	root?: string;
	file?: string;
	resolution?: number;
	offset?: number;
	limit?: number;
	action?: string;
	line?: number;
	column?: number;
	symbol?: string;
	query?: string;
	content?: string;
	depth?: number;
	operations?: CodeOperation[];
}

export interface CodeBufferResult {
	output: unknown;
	error: boolean;
}

declare module "../bindings" {
	interface NativeBindings {
		executeCodeBuffer(options: CodeBufferOptions): CodeBufferResult;
	}
}
