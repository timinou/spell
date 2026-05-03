import {
	buildBetaHeader,
	claudeCodeBetaDefaults,
	claudeCodeHeaders,
	claudeCodeVersion,
	getHeaderCaseInsensitive,
	isAnthropicOAuthToken,
	isClaudeCodeClientUserAgent,
} from "./anthropic";

export interface BetterCcflareHeaderOptions {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
}

export function buildBetterCcflareHeaders(options: BetterCcflareHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
	const acceptHeader = stream ? "text/event-stream" : "application/json";
	const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
	const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
		? incomingUserAgent
		: `claude-cli/${claudeCodeVersion} (external, cli)`;

	const headers: Record<string, string> = {
		...claudeCodeHeaders,
		Accept: acceptHeader,
		"Accept-Encoding": "gzip, deflate, br",
		Connection: "keep-alive",
		"Content-Type": "application/json",
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Dangerous-Direct-Browser-Access": "true",
		"Anthropic-Beta": betaHeader,
		"User-Agent": userAgent,
		"X-App": "cli",
	};

	// Auth: OAuth passthrough when apiKey is empty/falsy
	if (options.apiKey) {
		if (oauthToken) {
			headers.Authorization = `Bearer ${options.apiKey}`;
		} else {
			headers["x-api-key"] = options.apiKey;
		}
	}
	// else: NO auth header → OAuth passthrough mode

	// Apply model-specific headers, respecting enforced keys
	const enforcedHeaderKeys = new Set(Object.keys(headers).map(key => key.toLowerCase()));
	if (options.modelHeaders) {
		for (const [key, value] of Object.entries(options.modelHeaders)) {
			if (!enforcedHeaderKeys.has(key.toLowerCase())) {
				headers[key] = value;
			}
		}
	}

	return headers;
}
