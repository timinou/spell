import type { Cancellable } from "../bindings";

export interface CodeGraphOptions extends Cancellable {
	command: string;
	root?: string;
	file?: string;
	symbol?: string;
	query?: string;
	depth?: number;
	limit?: number;
	semantic?: boolean;
}

export interface CodeGraphResult {
	output: string;
	cacheStatus: string;
	rebuilt: boolean;
	fileCount: number;
	symbolCount: number;
	edgeCount: number;
	semanticStatus?: string;
}

declare module "../bindings" {
	interface NativeBindings {
		executeCodeGraph(options: CodeGraphOptions): Promise<CodeGraphResult>;
	}
}
