import type { AuthStorage } from "../session/auth-storage";

export const DEFAULT_SPELLCASTING_URL = "https://cast.spell.dev";

export function getSpellcastingServerUrl(): string {
	return (process.env.SPELLCASTING_URL || DEFAULT_SPELLCASTING_URL).replace(/\/+$/, "");
}

export async function validateSpellcastingToken(authStorage: AuthStorage): Promise<string | null> {
	const token = await authStorage.getApiKey("spellcasting", "spellcasting-session-validation");
	if (!token) {
		return null;
	}

	try {
		const response = await fetch(`${getSpellcastingServerUrl()}/api/auth/me`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (response.ok) {
			return null;
		}
		if (response.status === 401 || response.status === 403) {
			return "Spellcasting token expired. Run /login spellcasting to re-authenticate.";
		}
		return `Spellcasting authentication check failed (${response.status}).`;
	} catch (error) {
		return `Spellcasting server unreachable: ${error instanceof Error ? error.message : String(error)}`;
	}
}
