/**
 * Pure path-math for local:// URLs. Mirrors the kernel local profile's
 * Direct layout under `<session_dir>/local/` but stays synchronous so
 * non-async callers (interactive mode, plan mode, agent session bootstrap,
 * mode guard) don't need a kernel round-trip just to compute a path.
 *
 * Content reads MUST go through the kernel via `executeCodePath` — this
 * helper only handles URL → absolute path translation.
 *
 * PLAN-310 cutover (Phase 3): replaces the `resolveLocalUrlToPath` import
 * from `../internal-urls`. When the internal-urls/ dir is eventually
 * deleted (Phase 4, after all 9 schemes are kernel-owned), this helper
 * stays as the canonical sync path-math for `local://`.
 */
import * as os from "node:os";
import * as path from "node:path";

const SAFE_RELATIVE_RE = /^[A-Za-z0-9._\-/]+$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface LocalPathOptions {
	/** Absolute path to the session artifacts directory, or null when there's no session. */
	getArtifactsDir?: () => string | null;
	/** Stable session identifier; used to construct a fallback root when no artifacts dir exists. */
	getSessionId?: () => string | null;
}

/**
 * Compute the absolute filesystem path for a `local://` URL.
 *
 * Rules (must mirror crates/pi-natives/src/code_path/uri/local.rs):
 *   - `local://<rel>` → `<sessionLocalRoot>/<rel>`
 *   - `local://` (no path) → `<sessionLocalRoot>` (caller decides read vs write semantics)
 *   - Relative paths are rejected if they contain `..`, are absolute, or have
 *     non-safe characters; mirrors `validateRelativePath` from the deleted
 *     skill-protocol helper.
 */
export function localUrlToPath(url: string, options: LocalPathOptions): string {
	const m = /^local:\/\/(.*)$/.exec(url);
	if (!m) throw new Error(`Not a local:// URL: ${url}`);
	const root = resolveSessionLocalRoot(options);

	const rawBody = m[1];
	if (!rawBody) {
		return root;
	}

	let body: string;
	try {
		body = decodeURIComponent(rawBody.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url}`);
	}

	if (path.isAbsolute(body)) {
		throw new Error("Absolute paths are not allowed in local:// URLs");
	}
	if (body.startsWith("../") || body === ".." || body.includes("/../") || body.endsWith("/..")) {
		throw new Error("Path traversal (..) is not allowed in local:// URLs");
	}
	if (!SAFE_RELATIVE_RE.test(body)) {
		throw new Error(`local:// path contains disallowed characters: ${body}`);
	}

	const resolved = path.resolve(root, body);
	const rootResolved = path.resolve(root);
	if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
	return resolved;
}

/**
 * Compute the session-scoped local root. Mirrors the TS handler's resolveLocalRoot.
 * When a session has artifacts, that wins; otherwise fall back to an OS tmp
 * subdir keyed on a sanitized session id.
 */
export function resolveSessionLocalRoot(options: LocalPathOptions): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		return path.resolve(artifactsDir, "local");
	}
	const sessionId = options.getSessionId?.() ?? "session";
	const safe = SAFE_SESSION_ID_RE.test(sessionId) ? sessionId : sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(os.tmpdir(), "spell-local", safe);
}
