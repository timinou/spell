/**
 * Runtime scheme registration helpers for MCP-advertised schemes + canvas.
 *
 * Per PLAN-310 W6: each MCP server registers ITS native scheme(s) via
 * `registerSchemeCallback`. Server name is the default schemePrefix when
 * the server doesn't declare one. Collisions with reserved native schemes
 * or with already-registered dynamic schemes are rejected with a clear
 * diagnostic.
 *
 * Reserved native schemes (kernel-owned, see `crates/pi-natives/src/code_path/uri/`):
 *   skill, rule, memory, agent, artifact, jobs, org, pi, local
 */

import {
	listRegisteredSchemes,
	registerSchemeCallback,
	unregisterSchemeCallback,
} from "@oh-my-pi/pi-natives";

/**
 * Schemes the kernel reserves (declarative profiles in
 * crates/pi-natives/src/code_path/uri/). Dynamic registration via
 * `registerScheme` rejects these names; MCP servers and runtime
 * helpers must pick a non-conflicting schemePrefix.
 *
 * PLAN-310 cutover moved rule, skill, jobs to dynamic registration
 * (callback profiles); they're no longer in this list.
 */
export const RESERVED_NATIVE_SCHEMES = [
	"memory",
	"agent",
	"artifact",
	"org",
	"pi",
	"local",
] as const;
// Note: artifact remains a kernel-declarative scheme post-BUG-396 (uses
// IndexLookup + cross-session scan, not callback). It stays in RESERVED
// because runtime registrations should not shadow it.

/**
 * Sanitize an MCP server name into a URL-scheme-safe kebab token.
 * Lowercase ASCII alphanumeric + hyphens; runs of non-alphanumeric collapse to one hyphen.
 *
 * Throws if the sanitized result is empty (caller must provide a fallback schemePrefix).
 */
export function deriveSchemeFromServerName(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!sanitized) {
		throw new Error(`Cannot derive URL scheme from server name: '${name}' (sanitization yielded empty string)`);
	}
	if (!/^[a-z]/.test(sanitized)) {
		// schemes must start with a letter
		throw new Error(`Derived scheme '${sanitized}' must start with [a-z]`);
	}
	return sanitized;
}

export interface SchemeRegistrationOptions {
	/** Treat as fs-backed (codepath suffix forwarding). Default: false. */
	fsBacked?: boolean;
	/** `<uri>::<codepath-suffix>` supported. Implies fsBacked. Default: false. */
	codepathCompatible?: boolean;
	/** MIME type hint. */
	mimeHint?: string;
	/** Whether brush should expand this scheme inside bash commands. Default: false. */
	bashExpandable?: boolean;
	/** Sync callback budget in milliseconds. Default 5000. */
	budgetMs?: number;
	/**
	 * Canonical URI form shown to users in error diagnostics, e.g. `"rule://<name>"`.
	 * When the kernel emits a parse/lookup error for this scheme it appends
	 * `(usage: <this>)` so users see the exact shape they should have typed.
	 * Default: `<scheme>://<body>`.
	 */
	usage?: string;
}

export interface SchemeResolveResult {
	url: string;
	content: string;
	mime?: string;
	notes?: string[];
	/**
	 * Absolute filesystem path backing this resolution, when applicable. Set
	 * when a callback resolves to on-disk content (e.g. skill:// after looking
	 * up the skill's baseDir + sub-path). Enables codepath suffix forwarding
	 * and brush bash expansion. Leave undefined for purely in-memory data
	 * (jobs://, swarm task://, virtual MCP resources).
	 */
	sourcePath?: string;
}

export interface AdvertiseError {
	scheme: string;
	reason: string;
}

/**
 * Register a scheme handler. Validates against reserved native names and
 * already-registered dynamic schemes. Returns null on success, AdvertiseError
 * on rejection (callers can collect to surface diagnostics in batch).
 *
 * The resolver MUST return synchronously (or be wrapped to do so). The
 * underlying napi ThreadsafeFunction expects a direct SchemeResolveResult; a
 * Promise return value is treated as the value itself and fails field
 * deserialization on the kernel side. For naturally-async work, do the I/O
 * synchronously via fs.readFileSync or maintain a JS-side cache.
 */
export function registerScheme(
	scheme: string,
	resolve: (body: string) => SchemeResolveResult,
	options?: SchemeRegistrationOptions,
): AdvertiseError | null {
	if (RESERVED_NATIVE_SCHEMES.includes(scheme as (typeof RESERVED_NATIVE_SCHEMES)[number])) {
		return {
			scheme,
			reason: `scheme '${scheme}' is reserved by the kernel; choose a non-conflicting schemePrefix`,
		};
	}
	const existing = listRegisteredSchemes();
	if (existing.includes(scheme)) {
		return { scheme, reason: `scheme '${scheme}' is already registered` };
	}
	try {
		registerSchemeCallback(scheme, resolve, options);
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { scheme, reason: message };
	}
}

/** Convenience: unregister a scheme. Returns true if removed. */
export function unregisterScheme(scheme: string): boolean {
	return unregisterSchemeCallback(scheme);
}
