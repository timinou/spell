import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@spell/pi-ai";
import { MCPManager } from "@spell/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig } from "@spell/pi-coding-agent/mcp/types";
import { hookFetch } from "@spell/pi-utils";

/**
 * BUG-492 follow-up: client_secret is credential material (paired with a specific
 * access/refresh token pair), not project config. It must live in agent.db alongside
 * the OAuth tokens — never in the persisted MCPServerConfig / spell.kdl auth block —
 * and MCPManager's proactive/forced refresh must read it from there.
 */
describe("MCP OAuth client_secret storage (BUG-492 follow-up)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-secret-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads client_id/client_secret from the agent.db credential, not the server config, when refreshing", async () => {
		const credentialId = "mcp_oauth_test_credential";

		// Simulate what #handleOAuthFlow now does post-login: store client_id/client_secret
		// on the credential row itself (agent.db), never on the MCPServerConfig.
		await authStorage.set(credentialId, {
			type: "oauth",
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() - 1000, // already expired -> triggers proactive refresh
			clientId: "db-stored-client-id",
			clientSecret: "db-stored-client-secret",
		});

		let capturedBody: URLSearchParams | null = null;
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://mcp.example.com/token") {
				capturedBody = new URLSearchParams(String(init?.body ?? ""));
				return new Response(
					JSON.stringify({
						access_token: "new-access-token",
						refresh_token: "new-refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});

		const manager = new MCPManager(tempDir);
		manager.setAuthStorage(authStorage);

		// The persisted config carries only credentialId/tokenUrl/clientId (never the
		// secret) — matching what #persistServer now writes into spell.kdl.
		const config: MCPHttpServerConfig = {
			type: "http",
			url: "https://mcp.example.com/mcp",
			auth: {
				type: "oauth",
				credentialId,
				tokenUrl: "https://mcp.example.com/token",
				clientId: "config-stored-client-id", // stale/absent-secret config value
			},
		};

		const resolved = await manager.prepareConfig(config);

		// The refresh request must have used the agent.db-stored client_secret (paired
		// with the token it was issued under), not any config-level value (there is
		// none for client_secret anymore, and clientId should prefer the DB row too).
		expect(capturedBody).not.toBeNull();
		expect((capturedBody as unknown as URLSearchParams).get("client_id")).toBe("db-stored-client-id");
		expect((capturedBody as unknown as URLSearchParams).get("client_secret")).toBe("db-stored-client-secret");

		// The refreshed access token must be applied to the outgoing config.
		expect(resolved.type === "http" ? resolved.headers?.Authorization : undefined).toBe("Bearer new-access-token");

		// The refreshed credential persisted back to agent.db must still carry the
		// client_id/client_secret forward, so the NEXT refresh also has them.
		const updated = authStorage.get(credentialId);
		expect(updated?.type).toBe("oauth");
		if (updated?.type === "oauth") {
			expect(updated.clientId).toBe("db-stored-client-id");
			expect(updated.clientSecret).toBe("db-stored-client-secret");
		}
	});

	it("falls back to config-level clientId/clientSecret for legacy credentials with none stored", async () => {
		const credentialId = "mcp_oauth_legacy_credential";

		// Legacy credential predating this fix: no clientId/clientSecret on the row.
		await authStorage.set(credentialId, {
			type: "oauth",
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() - 1000,
		});

		let capturedBody: URLSearchParams | null = null;
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://mcp.example.com/token") {
				capturedBody = new URLSearchParams(String(init?.body ?? ""));
				return new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const manager = new MCPManager(tempDir);
		manager.setAuthStorage(authStorage);

		const config: MCPHttpServerConfig = {
			type: "http",
			url: "https://mcp.example.com/mcp",
			auth: {
				type: "oauth",
				credentialId,
				tokenUrl: "https://mcp.example.com/token",
				clientId: "legacy-kdl-client-id",
				clientSecret: "legacy-kdl-client-secret",
			},
		};

		await manager.prepareConfig(config);

		expect(capturedBody).not.toBeNull();
		expect((capturedBody as unknown as URLSearchParams).get("client_id")).toBe("legacy-kdl-client-id");
		expect((capturedBody as unknown as URLSearchParams).get("client_secret")).toBe("legacy-kdl-client-secret");
	});
});
