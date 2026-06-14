async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
	const r = await fetch(path, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
	return r.json() as Promise<T>;
}

/** Minimal mirror of spell-server BlockingEventPayload (the fields the web renders). */
export interface AskQuestion {
	id: string;
	question: string;
	options: Array<{ label: string }>;
	recommended?: number;
	multi?: boolean;
}

export type BlockingEventPayload =
	| { kind: "plan_approval"; eventId: string; title: string; itemId: string; planSummary: string; selectorOptions: string[] }
	| { kind: "ask"; eventId: string; questions: AskQuestion[] }
	| { kind: "pending_action"; eventId: string; actionType: string; description: string }
	| { kind: "hook_selector"; eventId: string; title: string; options: string[] }
	| { kind: "hook_input"; eventId: string; title: string; placeholder?: string };

export type EventResponsePayload =
	| { kind: "plan_approval"; selectedOption: string }
	| { kind: "ask"; answers: Array<{ questionId: string; selectedIndices: number[] }> }
	| { kind: "hook_selector"; selectedIndex: number }
	| { kind: "hook_input"; value: string };

export interface SessionSummary {
	sessionId: string;
	kind: "external" | "spawned";
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	lastHeartbeat: number;
	currentBlockingEvent?: BlockingEventPayload;
	ownedBy?: string;
	templateName?: string;
	watchExtensions?: string[];
}

export interface ManifestTemplate {
	name: string;
	description?: string;
	setupRef: string;
	prompt: string;
	params: Array<{ name: string; type: "string" | "number" | "boolean"; required?: boolean }>;
	artifactWatch?: { ext: string[] };
}

export interface ArtifactRef {
	uri: string;
	agent: string;
	tool: string;
	filename: string;
	sizeBytes: number;
	ext: string;
}

export const api = {
	listSessions: (token: string) =>
		request<{ sessions: SessionSummary[] }>("/web/api/sessions", token),
	getSession: (token: string, id: string) =>
		request<SessionSummary>(`/web/api/sessions/${encodeURIComponent(id)}`, token),
	deleteSession: (token: string, id: string) =>
		request<unknown>(`/web/api/sessions/${encodeURIComponent(id)}`, token, { method: "DELETE" }).catch(() => undefined),
	listArtifacts: (token: string, id: string) =>
		request<{ artifacts: ArtifactRef[] }>(`/web/api/sessions/${encodeURIComponent(id)}/artifacts`, token),
	mintArtifactUrl: (token: string, id: string, artifactPath: string, ttlSec = 300) =>
		request<{ url: string; expiresAt: number }>(
			`/web/api/sessions/${encodeURIComponent(id)}/artifacts/url`,
			token,
			{ method: "POST", body: JSON.stringify({ artifactPath, ttlSec }) },
		),
	listTemplates: (token: string) =>
		request<{ templates: ManifestTemplate[] }>("/web/api/templates", token),
	runTemplate: (token: string, name: string, params: Record<string, unknown>) =>
		request<{ sessionId: string }>(`/web/api/templates/${encodeURIComponent(name)}/run`, token, {
			method: "POST",
			body: JSON.stringify({ params }),
		}),
};

// ── Edit history (PLAN-338) ─────────────────────────────────────────────────
/** One edit in the session's unified edit-history log. Mirrors coding-agent EditHistoryEntry. */
export interface EditHistoryEntry {
	id: string;
	file: string;
	workspace: string;
	groupId: string | null;
	reverted: boolean;
	committed: boolean;
	commit: string | null;
	agentLabel: string;
	timestamp: number;
}

/** Payload of an `edit_history` RPC response. */
export interface EditHistoryData {
	entries: EditHistoryEntry[];
	total: number;
	undoable: number;
	redoable: number;
}
