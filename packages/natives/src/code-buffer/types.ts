export interface Patch {
	find: string;
	replace: string;
}

export interface EditEntry {
	symbol?: string;
	line?: number;
	column?: number;
	operation: string;
	content?: string;
	patches?: Patch[];
	mode?: string;
}

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
	mode?: string;
	depth?: number;
	patches?: Patch[];
	edits?: EditEntry[];
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
