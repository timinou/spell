import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider } from "../../packages/ai/src/utils/oauth";
import { spellcastingProvider } from "../../packages/ai/src/utils/oauth/spellcasting";
import { validateSpellcastingToken } from "../../packages/coding-agent/src/spellcast/config";

describe("SpellcastingProvider", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-spellcast-auth-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		registerOAuthProvider(spellcastingProvider);
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

	it("register flow prompts for email and password and stores token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ token: "tok_abc", user_id: "u1" }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
		);

		const prompts: string[] = [];
		await authStorage.login("spellcasting", {
			onAuth: () => {},
			onPrompt: async prompt => {
				prompts.push(prompt.message);
				return prompts.length === 1 ? "test@test.com" : "pass123";
			},
		});

		expect(prompts[0]).toContain("email");
		expect(prompts[1]).toContain("password");
		expect(await authStorage.getApiKey("spellcasting", "session-test")).toBe("tok_abc");
	});

	it("login fallback uses /api/auth/login after register 409", async () => {
		if (!authStorage) throw new Error("test setup failed");
		spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "tok_def", user_id: "u1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		await authStorage.login("spellcasting", {
			onAuth: () => {},
			onPrompt: async prompt => (prompt.message.includes("email") ? "test@test.com" : "pass123"),
		});

		expect(await authStorage.getApiKey("spellcasting", "session-test")).toBe("tok_def");
	});

	it("surfaces wrong password errors clearly", async () => {
		if (!authStorage) throw new Error("test setup failed");
		spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "invalid credentials" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			);

		await expect(
			authStorage.login("spellcasting", {
				onAuth: () => {},
				onPrompt: async prompt => (prompt.message.includes("email") ? "test@test.com" : "wrong-pass"),
			}),
		).rejects.toThrow(/invalid credentials/i);
	});

	it("surfaces unreachable server errors clearly", async () => {
		if (!authStorage) throw new Error("test setup failed");
		spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

		await expect(
			authStorage.login("spellcasting", {
				onAuth: () => {},
				onPrompt: async prompt => (prompt.message.includes("email") ? "test@test.com" : "pass123"),
			}),
		).rejects.toThrow(/unreachable/i);
	});

	it("returns no warning for a valid stored token", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("spellcasting", { type: "api_key", key: "tok_valid" });
		spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ user_id: "u1", email: "test@test.com" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		expect(await validateSpellcastingToken(authStorage)).toBeNull();
	});

	it("returns expiry warning for an invalid stored token", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("spellcasting", { type: "api_key", key: "tok_invalid" });
		spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 }));

		expect(await validateSpellcastingToken(authStorage)).toContain("expired");
	});

	it("returns soft warning when spellcasting server is unreachable during validation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("spellcasting", { type: "api_key", key: "tok_valid" });
		spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

		expect(await validateSpellcastingToken(authStorage)).toContain("unreachable");
	});
});
