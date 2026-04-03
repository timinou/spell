import type { GrowthExaResult } from "../../types";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExaSearchRequest {
	query: string;
	numResults?: number;
}

export interface ExaSearchClient {
	search(request: ExaSearchRequest): Promise<GrowthExaResult[]>;
}

export interface HttpExaClientOptions {
	apiKey: string;
	apiBaseUrl?: string;
	fetchImpl?: FetchLike;
}

function normalizeResult(value: Record<string, unknown>): GrowthExaResult {
	return {
		url: typeof value.url === "string" ? value.url : "",
		title: typeof value.title === "string" ? value.title.trim() : "",
		...(typeof value.summary === "string" && value.summary.trim() ? { summary: value.summary.trim() } : {}),
		...(typeof value.text === "string" && value.text.trim() ? { text: value.text.trim() } : {}),
		...(typeof value.publishedAt === "string" && value.publishedAt.trim()
			? { publishedAt: value.publishedAt.trim() }
			: {}),
	};
}

export class HttpExaClient implements ExaSearchClient {
	#apiKey: string;
	#apiBaseUrl: string;
	#fetchImpl: FetchLike;

	constructor(options: HttpExaClientOptions) {
		this.#apiKey = options.apiKey;
		this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.exa.ai";
		this.#fetchImpl = options.fetchImpl ?? fetch;
	}

	async search(request: ExaSearchRequest): Promise<GrowthExaResult[]> {
		const response = await this.#fetchImpl(`${this.#apiBaseUrl}/search`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.#apiKey,
			},
			body: JSON.stringify({
				query: request.query,
				numResults: request.numResults ?? 5,
			}),
		});
		if (!response.ok) {
			throw new Error(`Exa search failed with ${response.status}: ${await response.text()}`);
		}
		const payload = (await response.json()) as { results?: Record<string, unknown>[] };
		return (payload.results ?? []).map(normalizeResult);
	}
}

export function normalizeExaResults(payload: { results?: Record<string, unknown>[] }): GrowthExaResult[] {
	return (payload.results ?? []).map(normalizeResult);
}
