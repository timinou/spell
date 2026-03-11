export type Resolution = 0 | 1 | 2 | 3;

export interface OutlineEntry {
	name: string;
	type: string; // "function" | "class" | "method" | "interface" | "type" | "const" | "variable"
	line: number;
	end_line?: number;
	column?: number;
	exported?: boolean;
	signature?: string;
	children?: OutlineEntry[];
}

export interface BufferInfo {
	file: string;
	modified: boolean;
	size: number;
	language: string;
	lastAccessed: number;
}

export interface CodeEditTarget {
	line: number;
	node_type?: string;
}

export type CodeEditOperation =
	| "replace"
	| "insert-before"
	| "insert-after"
	| "splice"
	| "drag-up"
	| "drag-down"
	| "clone"
	| "kill"
	| "envelope";

export interface CodeEditOp {
	file: string;
	operation: CodeEditOperation;
	target: CodeEditTarget;
	content?: string;
	envelope?: string;
	save?: boolean;
}

export interface CodeEditResult {
	success: boolean;
	diff?: string;
	error?: string;
}

export interface EmacsCodeClient {
	read(file: string, resolution?: Resolution, offset?: number, limit?: number): Promise<string>;
	outline(file: string, depth?: number): Promise<OutlineEntry[]>;
	edit(op: CodeEditOp): Promise<CodeEditResult>;
	buffers(): Promise<BufferInfo[]>;
	bufferDiff(file: string): Promise<string>;
	navigate(file: string, action: string, line?: number, column?: number): Promise<unknown>;
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}
