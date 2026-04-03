import type { SpellSurfaceClientOptions } from "./goals-tool";

function authHeader(options: SpellSurfaceClientOptions): string {
	return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
}

export async function fetchApprovalsToolView(options: SpellSurfaceClientOptions): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(`${options.baseUrl}/api/approvals`, {
		headers: { Authorization: authHeader(options) },
	});
	if (!response.ok) {
		throw new Error(`Approvals request failed with ${response.status}`);
	}
	return response.json();
}
