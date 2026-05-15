const DEFAULT_DENYLIST = [
	"authorization",
	"x-api-key",
	"anthropic-api-key",
	"cookie",
	"set-cookie",
	"openai-organization",
	"x-goog-api-key",
];

export function applyDefaultRedaction(req: Request): Request {
	const headers: Record<string, string> = {};
	for (const [key, value] of req.headers.entries()) {
		const lower = key.toLowerCase();
		headers[lower] = DEFAULT_DENYLIST.includes(lower) ? "<redacted>" : value;
	}
	return new Request(req, { headers });
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		result[lower] = DEFAULT_DENYLIST.includes(lower) ? "<redacted>" : value;
	}
	return result;
}
