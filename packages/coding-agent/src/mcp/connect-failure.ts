/**
 * WAVE 3 (FEAT-829): classify an MCP connect failure so the loader can surface
 * an actionable OAuth-login prompt instead of a generic "MCP tool load failed".
 *
 * Pure by design — takes an error and a credential-presence flag, returns a
 * verdict. No manager/session/fs dependency, so it is unit-testable.
 */

import { analyzeAuthError } from "./oauth-discovery";

export interface ConnectFailureContext {
	/** Whether a credential is already stored for this server (agent.db hit). */
	hasCredential: boolean;
}

export interface ConnectFailureVerdict {
	/**
	 * `oauth-required`: the server needs an OAuth login the user has not yet
	 * completed → surface `hint`. `error`: a genuine failure to report as-is.
	 */
	kind: "oauth-required" | "error";
	/** Original error message, always preserved for reporting. */
	message: string;
	/** Actionable hint (only for `oauth-required`). */
	hint?: string;
}

/**
 * Decide whether a connect failure is an unmet OAuth-login requirement or a
 * plain error.
 *
 * A 401/403 whose body advertises OAuth AND for which no credential is stored
 * is an unmet login → actionable. The same 401 WITH a stored credential is a
 * real error (revoked/expired-past-refresh): prompting "run login" would loop,
 * so we report it plainly. Non-auth failures (ECONNREFUSED, DNS, timeouts) are
 * always plain errors.
 */
export function classifyConnectFailure(
	serverName: string,
	error: Error,
	ctx: ConnectFailureContext,
): ConnectFailureVerdict {
	const message = error.message;
	const auth = analyzeAuthError(error);

	if (auth.requiresAuth && isOAuthProtected(error, auth.authType) && !ctx.hasCredential) {
		return {
			kind: "oauth-required",
			message,
			hint: `OAuth required — run /mcp login ${serverName}`,
		};
	}

	return { kind: "error", message };
}

/**
 * Detect whether an auth failure is OAuth-based. Two signals:
 *  - `analyzeAuthError` already resolved inline OAuth endpoints (authType oauth); or
 *  - the response advertises RFC 9728 OAuth protected-resource discovery via a
 *    `WWW-Authenticate: Bearer` challenge with `realm="OAuth"` and/or a
 *    `resource_metadata=` pointer (how hosted servers like Notion respond — no
 *    inline endpoints, discovered from the resource metadata well-known doc).
 */
function isOAuthProtected(error: Error, authType: string | undefined): boolean {
	if (authType === "oauth") return true;
	const msg = error.message;
	if (!/WWW-Authenticate:\s*Bearer/i.test(msg)) return false;
	return /resource_metadata\s*=/i.test(msg) || /realm\s*=\s*"?OAuth"?/i.test(msg);
}
