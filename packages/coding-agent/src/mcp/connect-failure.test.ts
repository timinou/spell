/**
 * WAVE 3 (FEAT-829): a startup MCP connect failure that is really an OAuth
 * authentication requirement must be surfaced as an ACTIONABLE prompt
 * ("run /mcp login <name>"), not a generic silent "MCP tool load failed".
 *
 * `classifyConnectFailure` is the pure core: given a connect error and whether
 * a credential is already stored for the server, it decides between
 * `oauth-required` (actionable) and `error` (plain). Kept pure so it is
 * testable without a live MCPManager.
 */

import { describe, expect, it } from "bun:test";

import { classifyConnectFailure } from "./connect-failure";

/** The exact 401 body the hosted Notion MCP returns without a token. */
const NOTION_401 = new Error(
	'HTTP 401: {"error":"invalid_token","error_description":"Missing or invalid access token"} ' +
		'[WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"]',
);

describe("classifyConnectFailure", () => {
	it("classifies an OAuth 401 with no stored credential as oauth-required", () => {
		const result = classifyConnectFailure("notion", NOTION_401, { hasCredential: false });
		expect(result.kind).toBe("oauth-required");
		expect(result.hint).toContain("/mcp login notion");
	});

	it("does NOT prompt for login when a credential already exists (real failure)", () => {
		// A 401 despite a stored credential is a genuine error (revoked/expired
		// past refresh) — surfacing "run login" would loop; treat as error.
		const result = classifyConnectFailure("notion", NOTION_401, { hasCredential: true });
		expect(result.kind).toBe("error");
	});

	it("classifies a non-auth connection failure as a plain error", () => {
		const econn = new Error("Unable to connect. Is the computer able to access the url?");
		const result = classifyConnectFailure("tidewave", econn, { hasCredential: false });
		expect(result.kind).toBe("error");
		expect(result.hint).toBeUndefined();
	});

	it("preserves the original error message on the result", () => {
		const result = classifyConnectFailure("notion", NOTION_401, { hasCredential: false });
		expect(result.message).toBe(NOTION_401.message);
	});
});
