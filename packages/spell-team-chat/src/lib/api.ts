import type { SessionSummary } from "./protocol";

export interface ArtifactRef {
	uri: string;
	agent: string;
	tool: string;
	filename: string;
	sizeBytes: number;
	ext: string;
}

export interface ManifestTemplate {
	name: string;
	description?: string;
	setupRef: string;
	prompt: string;
	params: Array<{ name: string; type: "string" | "number" | "boolean"; required?: boolean; description?: string }>;
	artifactWatch?: { ext: string[] };
}

async function req<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
	const r = await fetch(path, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!r.ok) {
		const body = await r.text().catch(() => "");
		throw new Error(`${path}: ${r.status} ${body || r.statusText}`);
	}
	return (await r.json()) as T;
}

export const api = {
	listSessions: (token: string) => req<{ sessions: SessionSummary[] }>("/web/api/sessions", token),
	getSession: (token: string, id: string) =>
		req<SessionSummary>(`/web/api/sessions/${encodeURIComponent(id)}`, token),
	killSession: (token: string, id: string) =>
		req<unknown>(`/web/api/sessions/${encodeURIComponent(id)}`, token, { method: "DELETE" }).catch(() => undefined),
	listArtifacts: (token: string, id: string) =>
		req<{ artifacts: ArtifactRef[] }>(`/web/api/sessions/${encodeURIComponent(id)}/artifacts`, token),
	mintArtifactUrl: (token: string, id: string, artifactPath: string, ttlSec = 300) =>
		req<{ url: string; expiresAt: number }>(
			`/web/api/sessions/${encodeURIComponent(id)}/artifacts/url`,
			token,
			{ method: "POST", body: JSON.stringify({ artifactPath, ttlSec }) },
		),
	listTemplates: (token: string) => req<{ templates: ManifestTemplate[] }>("/web/api/templates", token),
};

/* -- Token persistence ------------------------------------------------- */
const TOKEN_KEY = "spell-team-chat:token";

export const tokenStore = {
	get(): string | null {
		try {
			return localStorage.getItem(TOKEN_KEY);
		} catch {
			return null;
		}
	},
	set(token: string): void {
		try {
			localStorage.setItem(TOKEN_KEY, token);
		} catch {
			/* ignore */
		}
	},
	clear(): void {
		try {
			localStorage.removeItem(TOKEN_KEY);
		} catch {
			/* ignore */
		}
	},
};
