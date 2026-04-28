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

export interface SessionSummary {
	sessionId: string;
	kind: "external" | "spawned";
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	lastHeartbeat: number;
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
