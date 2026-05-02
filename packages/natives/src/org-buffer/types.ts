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
	// recall
	text?: string;
	scope?: string[];
	focus?: string;
	graphHops?: number;
	graphKinds?: string[];
	limit?: number;
	weights?: Record<string, number>;
	profile?: string;
	includePersonal?: boolean;
	repoRoot?: string;
	// remember
	kind?: string;
	summary?: string;
	involves?: string[];
	about?: string[];
	produced?: string[];
	distilledFrom?: string[];
	supersedes?: string[];
	// timeline
	target?: string;
	// subgraph
	hops?: number;
	kinds?: string[];
	// link
	from?: string;
	to?: string;
	// payload (remember)
	payload?: unknown;
}

export interface OrgDagEdge {
	from: string;
	to: string;
}

export interface OrgDagNode {
	id: string;
	title: string;
	state: string;
	parent_id?: string;
}

export interface OrgDag {
	nodes: OrgDagNode[];
	edges: OrgDagEdge[];
}

export interface OrgWaveItem {
	custom_id: string;
	parent_id: string;
	title: string;
}

export interface OrgWave {
	number: number;
	items: OrgWaveItem[];
}

export interface OrgComputeWavesOutput {
	waves: OrgWave[];
	warnings: string[];
	total_sub_outlines: number;
	subfeature_dag: OrgDag;
	file_dag: OrgDag;
}

export interface OrgDuplicateIdErrorOutput {
	code: "DUPLICATE_CUSTOM_ID";
	message: string;
	duplicate_ids: string[];
	duplicate_count: number;
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
