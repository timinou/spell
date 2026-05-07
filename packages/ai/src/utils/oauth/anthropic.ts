/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
// offline_access required for long-lived refresh tokens (~12-24h without it)
const SCOPES = "org:create_api_key user:profile user:inference offline_access";

type AnthropicOAuthErrorPayload = {
	error?: string | { message?: unknown };
	message?: unknown;
	error_description?: unknown;
};

async function readAnthropicOAuthError(response: Response): Promise<string> {
	const raw = (await response.text()).trim();
	if (!raw) return `HTTP ${response.status}`;
	try {
		const parsed = JSON.parse(raw) as AnthropicOAuthErrorPayload;
		if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
		if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
			const message = parsed.error.message.trim();
			if (message) return message;
		}
		if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
		if (typeof parsed.error_description === "string" && parsed.error_description.trim()) {
			return parsed.error_description.trim();
		}
	} catch {}
	return raw;
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
		});

		const url = `${AUTHORIZE_URL}?${authParams.toString()}`;
		return { url };
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: exchangeCode,
				state: exchangeState,
				redirect_uri: redirectUri,
				code_verifier: this.#verifier,
			}),
		});

		if (!tokenResponse.ok) {
			let error: string;
			try {
				error = await tokenResponse.text();
			} catch {
				error = `HTTP ${tokenResponse.status}`;
			}
			throw new Error(`Token exchange failed: ${error}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		};
	}
}

/**
 * Login with Anthropic OAuth
 */
export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const error = await readAnthropicOAuthError(response);
		throw new Error(`Anthropic token refresh failed (${response.status}): ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}
