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
	/** Honour .gitignore rules when resolving file targets (default: true). */
	gitignore?: boolean;
	/** PLAN-310: user home dir for UserRoot scheme templates (org://). */
	home?: string;
	/** PLAN-310: per-session dir for SessionRoot scheme templates (local, agent, etc.). */
	sessionDir?: string;
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

// ── Introspection types ────────────────────────────────────────────

export interface OpKindInfo {
	kind: string;
	family: string;
	target_shape: string;
	required_fields: string[];
	optional_fields: string[];
}

export interface QualifierInfo {
	name: string;
	args_schema: string | null;
	applies_to: string[];
}

export interface EdgeKindInfo {
	symbol: string;
	name: string;
	description: string;
}

export interface DiagnosticVariantInfo {
	variant: string;
	severity: string;
	template: string;
}

export interface OpSchemaDto {
	kind:          string;
	targetFamily:  string;
	fields:        FieldSchemaDto[];
	description:   string;
}

export interface FieldSchemaDto {
	name:        string;
	typeName:    string;
	required:    boolean;
	description: string;
}

export interface LanguageDialectInfo {
	id: string;
	extensions: string[];
	capabilities: string[];
}

declare module "../bindings" {
	interface NativeBindings {
		executeCodePath(options: CodePathOptions): Promise<CodePathChunk[]>;
		parseCodePath(target: string): any;
		renderCodePath(ast: any): string;
		getRegisteredExtensions(): string[];
		listOpKinds(): OpKindInfo[];
		listQualifiers(): QualifierInfo[];
		listEdgeKinds(): EdgeKindInfo[];
		listDiagnosticVariants(): DiagnosticVariantInfo[];
		listLanguageDialects(): LanguageDialectInfo[];
		listOps(): OpSchemaDto[];
	}
}
