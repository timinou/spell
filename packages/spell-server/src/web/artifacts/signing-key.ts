import * as crypto from "node:crypto";
import type { SpellServerConfig } from "../../config/types";

/**
 * Derive a stable HMAC key for signing artifact URLs. Order:
 *   1. `webhookSecret` if configured (already a strong shared secret)
 *   2. SHA-256 of sorted `web.tokens.values()` joined with NUL separators
 *      (deterministic per deployment, never sent to client)
 *
 * Throws when neither is available so signed URLs cannot be silently disabled.
 */
export function deriveSigningKey(server: SpellServerConfig): Buffer {
	if (server.http.webhookSecret) {
		return crypto.createHash("sha256").update(server.http.webhookSecret).digest();
	}
	if (server.web && server.web.tokens.size > 0) {
		const sorted = [...server.web.tokens.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const hasher = crypto.createHash("sha256");
		for (const [name, value] of sorted) {
			hasher.update(name);
			hasher.update("\0");
			hasher.update(value);
			hasher.update("\0");
		}
		return hasher.digest();
	}
	throw new Error(
		"deriveSigningKey: configure either http.webhookSecret or web.tokens to enable signed artifact URLs",
	);
}
