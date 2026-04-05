import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { createEmacsClient } from "./client";
import { type EmacsSession, startEmacsSession } from "./daemon";
import { detectEmacs } from "./detection";
import type { CodeEditOp, Resolution } from "./types";

// Path to elisp directory shipped with this package.
// Resolves relative to this file: packages/emacs/src/tool.ts
const EMACS_ELISP_DIR = path.resolve(import.meta.dir, "../elisp");

export interface CodeToolDependencies {
	getSession(): Promise<EmacsSession | null>;
}

export interface CodeToolDefinition {
	name: string;
	description: string;
	execute(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Factory that creates a code tool definition.
 * Takes projectRoot + optional session factory (for testing / custom config).
 */
export function createCodeTool(_projectRoot: string, deps: CodeToolDependencies): CodeToolDefinition {
	return {
		name: "code",
		description:
			"Structural code intelligence via Emacs treesit + combobulate. " +
			"Subcommands: read (resolution-aware), outline, edit, buffers, diff, navigate, languages, install_grammar.",
		async execute(args) {
			const command = args.command as string | undefined;
			if (!command) return { error: true, message: "Missing required field: command" };

			const session = await deps.getSession();
			if (!session || !session.isAlive()) return { error: true, message: "Emacs daemon unavailable" };

			const socatPath = Bun.which("socat") ?? undefined;
			const client = await createEmacsClient(session.socketPath, socatPath);
			if (!client) return { error: true, message: "socat not found — JSON-RPC transport unavailable" };

			try {
				switch (command) {
					case "read": {
						const file = args.file as string;
						const resolution = (args.resolution as Resolution | undefined) ?? 2;
						const offset = args.offset as number | undefined;
						const limit = args.limit as number | undefined;
						return await client.read(file, resolution, offset, limit);
					}
					case "outline": {
						const file = args.file as string;
						const depth = args.depth as number | undefined;
						return await client.outline(file, depth);
					}
					case "edit": {
						return await client.edit(args as unknown as CodeEditOp);
					}
					case "buffers": {
						return await client.buffers();
					}
					case "diff": {
						const file = args.file as string;
						return await client.bufferDiff(file);
					}
					case "navigate": {
						const file = args.file as string;
						const action = args.action as string;
						const line = args.line as number | undefined;
						const column = args.column as number | undefined;
						return await client.navigate(file, action, line, column);
					}
					case "languages": {
						const installedOnly = args.installed_only as boolean | undefined;
						return await client.languages(installedOnly);
					}
					case "install_grammar": {
						const lang = args.lang as string;
						const url = args.url as string | undefined;
						const revision = args.revision as string | undefined;
						const sourceDir = args.source_dir as string | undefined;
						if (!lang) return { error: true, message: "Missing required field: lang" };
						return await client.installGrammar(lang, url, revision, sourceDir);
					}
					default:
						return { error: true, message: `Unknown command: ${command}` };
				}
			} finally {
				await client.close();
			}
		},
	};
}

// =============================================================================
// Warmup pipeline — mirrors warmupLspServers in packages/coding-agent/src/lsp
// =============================================================================

export interface CodeWarmupOptions {
	/**
	 * Called immediately before the daemon is started, so the caller can display
	 * a progress message without waiting for the full startup.
	 */
	onConnecting?: (daemonName: string) => void;
	/** Explicit path to the emacs binary (falls back to PATH + common locations). */
	emacsPath?: string;
}

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

/**
 * Detect prerequisites, start the Emacs daemon, and return a structured result.
 *
 * Mirrors warmupLspServers: fires `onConnecting` before blocking on startup,
 * always resolves (never rejects), and returns a typed status so callers can
 * surface diagnostics to the UI.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId   - Opaque session identifier (e.g. Pi session UUID).
 * @param options     - Optional callbacks and overrides.
 */
export async function warmupCode(
	projectRoot: string,
	sessionId: string,
	options?: CodeWarmupOptions,
): Promise<CodeWarmupResult> {
	const detection = await detectEmacs(options?.emacsPath);

	// Surface detection failures as "unavailable" — these are environment issues,
	// not daemon crashes, so they should not be logged as warnings.
	if (!detection.found || !detection.meetsMinimum || !detection.socatFound || !detection.treesitAvailable) {
		const reasons = detection.errors.length > 0 ? detection.errors : ["Emacs or treesit unavailable"];
		if (!detection.treesitAvailable && detection.found && detection.meetsMinimum) {
			reasons.push(`Emacs ${detection.version} is missing treesit support (built without --with-tree-sitter)`);
		}
		logger.debug("[code-warmup] prerequisites not met", { reasons });
		return {
			status: "unavailable",
			error: reasons.join("; "),
			version: detection.version ?? undefined,
			session: null,
		};
	}

	// Notify caller before blocking — same contract as warmupLspServers onConnecting.
	options?.onConnecting?.("code");

	try {
		const session = await startEmacsSession(detection.path!, projectRoot, sessionId, EMACS_ELISP_DIR);
		logger.debug("[code-warmup] daemon ready", { version: detection.version, projectRoot });
		return { status: "ready", version: detection.version ?? undefined, session };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("[code-warmup] daemon startup failed", { error: msg, projectRoot });
		return { status: "error", error: msg, version: detection.version ?? undefined, session: null };
	}
}
