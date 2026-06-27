import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

function expiredCredential(refresh: string, access: string): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() - 60_000,
	};
}

/**
 * Simulates two Spell processes sharing the same `agent.db`. Providers that rotate
 * refresh tokens (e.g. Kimi Code) invalidate the previous refresh token the moment
 * the first instance exchanges it; the second instance then sees `invalid_grant`
 * for an attempt that was, from the user's perspective, perfectly legitimate.
 *
 * Without recovery, AuthStorage blocks the credential for 30 days and forces the
 * user back through `/login`. With recovery, the loser observes the winner's
 * rotated credential on disk and silently adopts it.
 */
describe("AuthStorage cross-process OAuth refresh race recovery", () => {
	let tempDir = "";
	let dbPath = "";
	let storeA: AuthCredentialStore | null = null;
	let storeB: AuthCredentialStore | null = null;
	let authA: AuthStorage | null = null;
	let authB: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-xproc-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storeA?.close();
		storeB?.close();
		storeA = null;
		storeB = null;
		authA = null;
		authB = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
			dbPath = "";
		}
	});

	it("adopts the rotated refresh token when another process won the race", async () => {
		// ─── seed: both processes hold the same expired credential ───────────
		storeA = await AuthCredentialStore.open(dbPath);
		authA = new AuthStorage(storeA);
		await authA.set("kimi-code", expiredCredential("rt0", "at0"));

		storeB = await AuthCredentialStore.open(dbPath);
		authB = new AuthStorage(storeB);
		await authB.reload();

		expect(storeA.getOAuth("kimi-code")?.refresh).toBe("rt0");
		expect(storeB.getOAuth("kimi-code")?.refresh).toBe("rt0");

		// ─── race outcome: A wins (rotates rt0 → rt1), B loses (invalid_grant) ───
		let call = 0;
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (provider, creds) => {
			expect(provider).toBe("kimi-code");
			expect(creds.refresh).toBe("rt0");
			call += 1;
			if (call === 1) {
				return {
					...(creds as OAuthCredentials),
					access: "at1",
					refresh: "rt1",
					expires: Date.now() + 60_000,
				};
			}
			throw new Error("Kimi token refresh failed: 400: invalid_grant");
		});

		// Process A refreshes first and persists the rotated credential.
		expect(await authA.getApiKey("kimi-code", "sess-a")).toBe("at1");
		expect(storeA.getOAuth("kimi-code")?.refresh).toBe("rt1");

		// Process B attempts a refresh with the now-invalidated rt0. The refresh
		// endpoint returns invalid_grant. AuthStorage MUST detect that the on-disk
		// credential has already been rotated (rt1) and adopt it, not block.
		expect(await authB.getApiKey("kimi-code", "sess-b")).toBe("at1");
		// At minimum: A's successful refresh (rt0 → rt1) plus at least one B refresh
		// attempt that triggers the recovery path. Exact count depends on internal
		// pre-refresh / try-credential flow and is not a behavioural contract.
		expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

		// B's in-memory cache now reflects the rotated credential, AND the on-disk
		// state for B's connection sees the same row (no duplicate rows created).
		expect(storeB.getOAuth("kimi-code")?.refresh).toBe("rt1");
		expect(storeB.getOAuth("kimi-code")?.access).toBe("at1");

		// Critically: the credential must NOT be blocked. A follow-up call from B
		// (which won't trigger refresh, since the adopted credential is fresh) must
		// return the rotated access token, proving no 30-day block was applied.
		expect(await authB.getApiKey("kimi-code", "sess-b")).toBe("at1");
	});

	it("still blocks the credential when refresh truly fails (no rotation on disk)", async () => {
		// Counter-case: single-process invalid_grant with no concurrent rotation.
		// Recovery must NOT spuriously adopt a stale credential; the original
		// /login-after-block behaviour must remain intact.
		storeA = await AuthCredentialStore.open(dbPath);
		authA = new AuthStorage(storeA);
		await authA.set("kimi-code", expiredCredential("rt0", "at0"));

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("Kimi token refresh failed: 400: invalid_grant");
		});

		expect(await authA.getApiKey("kimi-code", "sess-a")).toBeUndefined();

		// Subsequent calls must remain blocked (no recovery loophole).
		expect(await authA.getApiKey("kimi-code", "sess-a")).toBeUndefined();
	});

	it("long-term blocks (not disables) on a bare 401 from the refresh endpoint", async () => {
		// A single 401 without explicit revocation language should not destroy
		// the credential. Upstream Kimi CLI treats this as a transient/racy
		// failure; we long-term block so the user can re-login without losing
		// visibility into the provider.
		storeA = await AuthCredentialStore.open(dbPath);
		authA = new AuthStorage(storeA);
		await authA.set("kimi-code", expiredCredential("rt0", "at0"));

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("Kimi token refresh failed: 401: API Key appears to be invalid");
		});

		expect(await authA.getApiKey("kimi-code", "sess-a")).toBeUndefined();

		// The credential must still be present (not disabled/deleted) and
		// blocked so the env fallback guard remains active.
		const oauth = storeA.getOAuth("kimi-code");
		expect(oauth).not.toBeNull();
		expect(oauth?.refresh).toBe("rt0");

		// Re-attempts continue to fail without disabling the credential.
		expect(await authA.getApiKey("kimi-code", "sess-a")).toBeUndefined();
		expect(storeA.getOAuth("kimi-code")).not.toBeNull();
	});

	it("permanently disables when the refresh error explicitly says revoked/unauthorized", async () => {
		// When the provider explicitly tells us the token is revoked, permanent
		// disable is the right behaviour.
		storeA = await AuthCredentialStore.open(dbPath);
		authA = new AuthStorage(storeA);
		await authA.set("kimi-code", expiredCredential("rt0", "at0"));

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error("token refresh failed: 401: unauthorized - token has been revoked");
		});

		expect(await authA.getApiKey("kimi-code", "sess-a")).toBeUndefined();

		// The credential should have been disabled/removed from active rows.
		expect(storeA.getOAuth("kimi-code")).toBeNull();
	});
});
