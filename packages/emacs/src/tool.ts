import type { EmacsSession } from "./daemon";

export interface CodeWarmupResult {
	/** "ready"   — daemon started and socket is live.
	 *  "error"    — daemon was attempted but failed; details in `error`.
	 *  "unavailable" — Emacs / socat / treesit prerequisites are missing.
	 */
	status: "ready" | "error" | "unavailable";
	/** Human-readable failure detail (present when status !== "ready"). */
	error?: string;
	/** Detected Emacs version string, when known. */
	version?: string;
	/** The started session (present when status === "ready"). */
	session: EmacsSession | null;
}
