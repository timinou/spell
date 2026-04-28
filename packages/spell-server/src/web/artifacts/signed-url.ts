import * as crypto from "node:crypto";

const SIG_PARAM = "sig";
const EXP_PARAM = "exp";

function toBase64Url(bytes: Buffer): string {
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Buffer {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
	return Buffer.from(padded, "base64");
}

function computeSignature(uri: string, exp: number, key: Buffer): Buffer {
	return crypto.createHmac("sha256", key).update(`${uri}\n${exp}`).digest();
}

export interface MintOptions {
	/** Base origin like `http://localhost:8787`. Used to build the absolute URL. */
	origin?: string;
}

/**
 * Build a signed URL for an artifact. `uri` is the path portion the router
 * expects, e.g. `/web/artifacts/<sessionId>/<agent>/<tool>/<file>`. The exp
 * value is unix seconds; signature covers `<uri>\n<exp>` so any tamper of
 * either the path or the exp invalidates the URL.
 */
export function mintSignedArtifactUrl(uri: string, ttlSec: number, key: Buffer, opts: MintOptions = {}): string {
	const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSec));
	const sig = toBase64Url(computeSignature(uri, exp, key));
	const url = new URL(uri, opts.origin ?? "http://internal.invalid");
	url.searchParams.set(EXP_PARAM, String(exp));
	url.searchParams.set(SIG_PARAM, sig);
	return opts.origin ? url.toString() : `${url.pathname}${url.search}`;
}

export interface VerifyResult {
	valid: boolean;
	reason?: "missing" | "expired" | "tampered";
}

/**
 * Verify an inbound request's signed URL. The HMAC compare is constant-time.
 */
export function verifySignedUrl(request: Request, key: Buffer, now: () => number = () => Date.now()): VerifyResult {
	const url = new URL(request.url);
	const sig = url.searchParams.get(SIG_PARAM);
	const expRaw = url.searchParams.get(EXP_PARAM);
	if (!sig || !expRaw) return { valid: false, reason: "missing" };
	const exp = Number(expRaw);
	if (!Number.isFinite(exp)) return { valid: false, reason: "tampered" };
	if (exp * 1000 < now()) return { valid: false, reason: "expired" };

	// Reconstruct the canonical signed URI: path only, query stripped.
	const canonicalUri = url.pathname;
	const expected = computeSignature(canonicalUri, exp, key);
	let provided: Buffer;
	try {
		provided = fromBase64Url(sig);
	} catch {
		return { valid: false, reason: "tampered" };
	}
	if (provided.length !== expected.length) {
		// Constant-time-ish: hash a dummy buffer to keep comparable cycles.
		crypto.timingSafeEqual(expected, expected);
		return { valid: false, reason: "tampered" };
	}
	const eq = crypto.timingSafeEqual(provided, expected);
	return eq ? { valid: true } : { valid: false, reason: "tampered" };
}
