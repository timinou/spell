const KEY = "spell.web.token";
let memoryFallback: string | null = null;

function safeStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function getToken(): string | null {
	const storage = safeStorage();
	if (storage) return storage.getItem(KEY);
	return memoryFallback;
}

export function setToken(value: string | null): void {
	const storage = safeStorage();
	if (storage) {
		if (value === null) storage.removeItem(KEY);
		else storage.setItem(KEY, value);
		return;
	}
	memoryFallback = value;
}
