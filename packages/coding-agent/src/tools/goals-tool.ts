export interface SpellSurfaceClientOptions {
	baseUrl: string;
	username: string;
	password: string;
	fetchImpl?: typeof fetch;
}

function authHeader(options: SpellSurfaceClientOptions): string {
	return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
}

export async function fetchGoalsToolView(options: SpellSurfaceClientOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(`${options.baseUrl}/api/goals`, {
		headers: { Authorization: authHeader(options) },
	});
	if (!response.ok) {
		throw new Error(`Goals request failed with ${response.status}`);
	}
	return response.json();
}
