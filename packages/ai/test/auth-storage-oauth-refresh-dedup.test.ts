import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

function expiredCredential(name: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${name}`,
		refresh: `refresh-${name}`,
		// Already expired so getApiKey is forced into the refresh path.
		expires: Date.now() - 60_000,
		accountId: `acct-${name}`,
		email: `${name}@example.com`,
	};
}

describe("AuthStorage OAuth refresh deduplication", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-refresh-dedup-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	// Regression: providers that rotate refresh tokens (e.g. Kimi Code) invalidate the
	// previously-used refresh token on each exchange. Without in-flight dedup, concurrent
	// callers race on the same RT, the loser gets `invalid_grant`, and AuthStorage blocks
	// the credential for 30 days — forcing the user to /login roughly daily.
	it("collapses concurrent expired-credential refreshes into a single network call", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("kimi-code", expiredCredential("primary"));

		// Gate the mock so callers pile up while one refresh is in flight.
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (provider, credentials) => {
			expect(provider).toBe("kimi-code");
			expect(credentials.refresh).toBe("refresh-primary");
			await gate;
			return {
				...(credentials as OAuthCredentials),
				access: "access-primary-rotated",
				refresh: "refresh-primary-rotated",
				expires: Date.now() + 60_000,
			};
		});

		const calls = Promise.all([
			authStorage.getApiKey("kimi-code", "session-a"),
			authStorage.getApiKey("kimi-code", "session-b"),
			authStorage.getApiKey("kimi-code", "session-c"),
		]);
		// Let the gated mock observe all three callers before unblocking.
		await Bun.sleep(20);
		release();
		const results = await calls;

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(results).toEqual(["access-primary-rotated", "access-primary-rotated", "access-primary-rotated"]);
		expect(store.getOAuth("kimi-code")?.refresh).toBe("refresh-primary-rotated");
	});

	// After a refresh completes the cache entry must be released so the next caller (which
	// by then sees the rotated refresh token on disk) starts a fresh exchange. Otherwise
	// dedup would degrade into a stuck-forever cached result.
	it("clears the in-flight entry once the refresh settles", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("kimi-code", expiredCredential("primary"));

		let rotation = 0;
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_, credentials) => {
			rotation += 1;
			return {
				...(credentials as OAuthCredentials),
				access: `access-primary-${rotation}`,
				refresh: `refresh-primary-${rotation}`,
				expires: Date.now() + 60_000,
			};
		});

		expect(await authStorage.getApiKey("kimi-code", "session-a")).toBe("access-primary-1");
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		// Re-expire the rotated credential so the next call must hit the refresh endpoint
		// again. If the in-flight entry had leaked, dedup would short-circuit and we'd see
		// the stale `access-primary-1` result with no extra spy invocation.
		await authStorage.set("kimi-code", {
			type: "oauth",
			access: "access-primary-1",
			refresh: "refresh-primary-1",
			expires: Date.now() - 60_000,
			accountId: "acct-primary",
			email: "primary@example.com",
		});

		expect(await authStorage.getApiKey("kimi-code", "session-a")).toBe("access-primary-2");
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});
});
