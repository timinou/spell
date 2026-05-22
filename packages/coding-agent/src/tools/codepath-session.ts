/**
 * Helper to add SessionContext fields (home, sessionDir) to executeCodePath
 * options. PLAN-310: the kernel's SchemeRegistry uses these to resolve URI
 * schemes against the right roots.
 *
 * Tools should call this once per executeCodePath invocation when URI
 * targets might appear. Pure-fs targets are unaffected.
 */
import * as os from "node:os";

export interface SessionContextSource {
	getArtifactsDir?: () => string | null;
}

export interface SessionContextOptions {
	home?: string;
	sessionDir?: string;
}

/**
 * Build the kernel-facing SessionContext fields from a tool's session-bearing
 * context. Safe to spread into `executeCodePath({ ..., ...sessionContextOpts(this) })`.
 */
export function sessionContextOpts(src?: SessionContextSource | null): SessionContextOptions {
	const home = os.homedir();
	const sessionDir = src?.getArtifactsDir?.() ?? undefined;
	return sessionDir ? { home, sessionDir } : { home };
}
