export interface CodeBufferOptions {
	command: string;
	file?: string;
	resolution?: number;
	offset?: number;
	limit?: number;
	action?: string;
	line?: number;
	column?: number;
	symbol?: string;
	operation?: string;
	content?: string;
	node_type?: string;
	mode?: string;
	depth?: number;
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
