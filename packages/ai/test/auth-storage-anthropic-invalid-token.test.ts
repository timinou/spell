import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

function createCredential(name: string): OAuthCredential {
	return {
		type: "oauth",
		access: `sk-ant-oat-${name}`,
		refresh: `refresh-${name}`,
		expires: Date.now() + 60_000,
		accountId: `acct-${name}`,
		email: `${name}@example.com`,
	};
}

function readDisabledCauses(dbPath: string, provider: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
			)
			.all(provider) as Array<{ disabled_cause?: string | null }>;
		return rows.flatMap(row => (typeof row.disabled_cause === "string" ? [row.disabled_cause] : []));
	} finally {
		db.close();
	}
}

describe("AuthStorage anthropic invalid bearer handling", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-anthropic-invalid-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await AuthCredentialStore.open(dbPath);
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
			dbPath = "";
		}
	});

	it("refreshes the rejected anthropic oauth credential for the pinned session", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("anthropic", createCredential("primary"));
		const sessionId = "session-refresh";

		expect(await authStorage.getApiKey("anthropic", sessionId)).toBe("sk-ant-oat-primary");

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (provider, credentials) => {
			expect(provider).toBe("anthropic");
			expect(credentials.access).toBe("sk-ant-oat-primary");
			return {
				...(credentials as OAuthCredentials),
				access: "sk-ant-oat-primary-new",
				refresh: "refresh-primary-new",
				expires: Date.now() + 120_000,
			};
		});

		expect(await authStorage.markAuthFailure("anthropic", sessionId, "401 Invalid bearer token")).toBe(true);
		expect(await authStorage.getApiKey("anthropic", sessionId)).toBe("sk-ant-oat-primary-new");
		expect(store.getOAuth("anthropic")?.access).toBe("sk-ant-oat-primary-new");
		expect(readDisabledCauses(dbPath, "anthropic")).toEqual([]);
	});

	it("drops the rejected anthropic oauth credential and switches the session when refresh keeps the same token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("anthropic", [createCredential("first"), createCredential("second")]);
		const sessionId = "session-switch";

		const selected = await authStorage.getApiKey("anthropic", sessionId);
		expect(selected === "sk-ant-oat-first" || selected === "sk-ant-oat-second").toBe(true);
		const rejectedName = selected === "sk-ant-oat-first" ? "first" : "second";
		const alternateKey = selected === "sk-ant-oat-first" ? "sk-ant-oat-second" : "sk-ant-oat-first";

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (provider, credentials) => {
			expect(provider).toBe("anthropic");
			expect(credentials.refresh).toBe(`refresh-${rejectedName}`);
			return {
				...(credentials as OAuthCredentials),
				access: credentials.access,
				expires: Date.now() + 120_000,
			};
		});

		expect(await authStorage.markAuthFailure("anthropic", sessionId, "401 Invalid bearer token")).toBe(true);
		expect(await authStorage.getApiKey("anthropic", sessionId)).toBe(alternateKey);
		expect(store.listAuthCredentials("anthropic")).toHaveLength(1);
		expect(readDisabledCauses(dbPath, "anthropic")).toEqual(["oauth rejected by provider: 401 Invalid bearer token"]);
	});
});
