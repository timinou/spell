import * as crypto from "node:crypto";
import { logger } from "@spell/pi-utils";
import type { WebConfig } from "../config/types";
import type { ServerConfig, WebIdentity } from "./types";

function decodeBasicCredentials(value: string): string | null {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return null;
	}
}

export function verifyBasicAuth(request: Request, config: ServerConfig): boolean {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Basic ")) {
		return false;
	}

	const decoded = decodeBasicCredentials(header.slice(6));
	if (!decoded) {
		return false;
	}

	const separatorIndex = decoded.indexOf(":");
	if (separatorIndex === -1) {
		return false;
	}

	const user = decoded.slice(0, separatorIndex);
	const pass = decoded.slice(separatorIndex + 1);
	return user === config.auth.username && pass === config.auth.password;
}

export async function verifyHmac(request: Request, body: string, secret: string): Promise<boolean> {
	const signature = request.headers.get("X-Signature-256");
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const mac = crypto.createHmac("sha256", secret).update(body).digest("hex");
	const expected = `sha256=${mac}`;
	const receivedBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (receivedBuffer.length !== expectedBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function verifyBearerToken(request: Request, goalName: string, goalTokens: Record<string, string>): boolean {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return false;
	}

	const token = header.slice(7);
	return goalTokens[goalName] === token;
}

function extractPresentedToken(request: Request): { token: string; source: "header" | "query" } | null {
	const header = request.headers.get("Authorization");
	if (header?.startsWith("Bearer ")) {
		const token = header.slice(7).trim();
		if (token.length > 0) return { token, source: "header" };
	}
	try {
		const url = new URL(request.url);
		const token = (url.searchParams.get("token") ?? "").trim();
		if (token.length > 0) return { token, source: "query" };
	} catch {
		// fall through
	}
	return null;
}

function constantTimeStringEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	// timingSafeEqual requires equal-length inputs; we still want timing parity
	// across length mismatches by performing a dummy compare against a same-length copy.
	if (aBuf.length !== bBuf.length) {
		crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
		return false;
	}
	return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify a /web/* request against the configured token set.
 *
 * Token can be presented in two ways:
 *   - `Authorization: Bearer <secret>` (preferred for XHR/fetch).
 *   - `?token=<secret>` query string (used on the WebSocket upgrade because
 *     browsers cannot set custom headers on `new WebSocket()`).
 *
 * On match returns `{ name }`. Identical secrets across two names: both kept;
 * verifyWebToken returns the first match in alphabetical name order to keep
 * behavior deterministic.
 */
export function verifyWebToken(request: Request, web: WebConfig | undefined): WebIdentity | null {
	const presented = extractPresentedToken(request);
	if (!presented) return null;
	if (!web) {
		logger.debug("web token presented but subsystem disabled", { source: presented.source });
		return null;
	}
	const names = [...web.tokens.keys()].sort();
	let match: WebIdentity | null = null;
	for (const name of names) {
		const secret = web.tokens.get(name);
		if (secret === undefined) continue;
		if (constantTimeStringEqual(presented.token, secret)) {
			if (match === null) match = { name };
		}
	}
	if (match) {
		logger.debug("web token accepted", { name: match.name, source: presented.source });
		return match;
	}
	logger.warn("web token rejected", { source: presented.source });
	return null;
}
