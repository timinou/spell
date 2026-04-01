import type { OAuthLoginCallbacks, OAuthProviderInterface } from "./types";

const DEFAULT_SPELLCASTING_URL = "https://cast.spell.dev";

function getSpellcastingServerUrl(): string {
	return (process.env.SPELLCASTING_URL || DEFAULT_SPELLCASTING_URL).replace(/\/+$/, "");
}

async function requestJson(pathname: string, body: Record<string, string>): Promise<Response> {
	const url = `${getSpellcastingServerUrl()}${pathname}`;
	try {
		return await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Error(`Spellcasting server unreachable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const data = (await response.json()) as { error?: unknown };
		if (typeof data.error === "string" && data.error.trim().length > 0) {
			return data.error;
		}
	} catch {
		// Fall through to status-based message.
	}
	return `Spellcasting authentication failed (${response.status})`;
}

async function authenticate(email: string, password: string): Promise<string> {
	const registerResponse = await requestJson("/api/auth/register", { email, password });
	let response = registerResponse;
	if (registerResponse.status === 409) {
		response = await requestJson("/api/auth/login", { email, password });
	}
	if (!response.ok) {
		throw new Error(await readErrorMessage(response));
	}

	const data = (await response.json()) as { token?: unknown };
	if (typeof data.token !== "string" || data.token.length === 0) {
		throw new Error("Spellcasting server returned an invalid token payload");
	}
	return data.token;
}

export const spellcastingProvider: OAuthProviderInterface = {
	id: "spellcasting",
	name: "Spellcasting",
	sourceId: "spellcasting",
	async login(callbacks: OAuthLoginCallbacks): Promise<string> {
		callbacks.onProgress?.("Authenticating with Spellcasting");
		const email = (await callbacks.onPrompt({ message: "Spellcasting email" })).trim();
		const password = await callbacks.onPrompt({ message: "Spellcasting password" });
		if (!email) {
			throw new Error("Spellcasting email is required");
		}
		if (!password) {
			throw new Error("Spellcasting password is required");
		}
		return authenticate(email, password);
	},
};
