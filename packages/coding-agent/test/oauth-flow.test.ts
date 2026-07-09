import { describe, expect, it } from "bun:test";
import { MCPOAuthFlow } from "@spell/pi-coding-agent/mcp/oauth-flow";
import { hookFetch } from "@spell/pi-utils";

describe("mcp oauth flow", () => {
	it("uses Codex client name for dynamic client registration", async () => {
		let registrationPayload: Record<string, unknown> | null = null;

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({ registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://api.figma.com/v1/oauth/mcp/register") {
				registrationPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						client_id: "registered-client-id",
						client_secret: "registered-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53172/callback");
		const authUrl = new URL(url);

		expect(registrationPayload).not.toBeNull();
		expect((registrationPayload as { client_name?: string } | null)?.client_name).toBe("Codex");
		expect(authUrl.searchParams.get("client_id")).toBe("registered-client-id");
		expect(authUrl.searchParams.get("state")).toBe("test-state");
	});

	it("exposes DCR-issued client_id/client_secret via public getters (BUG-492)", async () => {
		// Simulates a Dynamic Client Registration (RFC 7591) only provider, e.g. Notion:
		// no static client_id in auth-server metadata, registration mints a fresh one.
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
				return new Response(JSON.stringify({ registration_endpoint: "https://mcp.example.com/register" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://mcp.example.com/register") {
				return new Response(
					JSON.stringify({
						client_id: "dcr-client-id",
						client_secret: "dcr-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://mcp.example.com/authorize",
				tokenUrl: "https://mcp.example.com/token",
			},
			{},
		);

		// No client_id configured and none derivable from the authorization URL: getters
		// start undefined until registration runs (mirrors real login() sequencing, where
		// generateAuthUrl triggers DCR before the client_id is ever needed downstream).
		expect(flow.resolvedClientId).toBeUndefined();
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53173/callback");

		// Post-DCR, the getters must surface exactly what the provider issued so a caller
		// persisting the server config can store it (BUG-492: previously this value was
		// trapped in private fields and never made it into the persisted auth block,
		// breaking proactive/forced token refresh for DCR-only providers).
		expect(flow.resolvedClientId).toBe("dcr-client-id");
		expect(flow.registeredClientSecret).toBe("dcr-client-secret");
	});
});
