export interface CodePathOptions {
	command: string;
	target: string;
	limit?: number;
	head?: number;
	tail?: number;
	offset?: number;
	format?: string;
	root?: string;
	actions?: any;
	manage?: string;
	/** Session ID for per-agent edit history attribution. */
	sessionId?: string;
	/** Abort signal for cancelling the operation. */
	abortSignal?: AbortSignal;
	/** Timeout in milliseconds for the operation. */
	timeoutMs?: number;
	artifactThreshold?: number;
}

export interface SpanDto {
	start: number;
	end: number;
}

export interface DiagnosticDto {
	variant: string;
	message: string;
	span?: SpanDto;
}

export interface ContentDto {
	kind: string;
	value?: string;
	artifactUri?: string;
	size?: number;
	handle?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	sourceKind?: string;
	text?: string;
}

export interface NodeRefDto {
	locator: string;
	rangeStart: number;
	rangeEnd: number;
	kind: string;
	content?: ContentDto;
	metadata: any;
	diagnostics: DiagnosticDto[];
}

export interface CodePathChunk {
	nodes: NodeRefDto[];
	diagnostics: DiagnosticDto[];
	done: boolean;
}

declare module "../bindings" {
	interface NativeBindings {
		executeCodePath(options: CodePathOptions): Promise<CodePathChunk[]>;
		parseCodePath(target: string): any;
		renderCodePath(ast: any): string;
		getRegisteredExtensions(): string[];
	}
}
