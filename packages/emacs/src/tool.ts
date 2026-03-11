import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { createEmacsClient } from "./client";
import { type EmacsSession, startEmacsSession } from "./daemon";
import { detectEmacs } from "./detection";
import type { CodeEditOp, Resolution } from "./types";

// Path to elisp directory shipped with this package.
// Resolves relative to this file: packages/emacs/src/tool.ts
const EMACS_ELISP_DIR = path.resolve(import.meta.dir, "../elisp");

export interface EmacsToolDependencies {
	getSession(): Promise<EmacsSession | null>;
}

export interface EmacsToolDefinition {
	name: string;
	description: string;
	execute(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Factory that creates an emacs_code tool definition.
 * Takes projectRoot + optional session factory (for testing / custom config).
 */
export function createEmacsTool(_projectRoot: string, deps: EmacsToolDependencies): EmacsToolDefinition {
	return {
		name: "emacs_code",
		description:
			"Structural code intelligence via Emacs treesit + combobulate. " +
			"Subcommands: read (resolution-aware), outline, edit, buffers, diff, navigate.",
		async execute(args) {
			const command = args.command as string | undefined;
			if (!command) return { error: true, message: "Missing required field: command" };

			const session = await deps.getSession();
			if (!session) return { error: true, message: "Emacs daemon unavailable" };

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
					default:
						return { error: true, message: `Unknown command: ${command}` };
				}
			} finally {
				await client.close();
			}
		},
	};
}

/**
 * Detect Emacs and start a managed daemon for the given session.
 * Returns null if Emacs is unavailable, below minimum version,
 * treesit is not compiled in, or socat is missing.
 *
 * Intended to be called once at Pi session init — the returned EmacsSession
 * is cached at module level by startEmacsSession and reused across calls.
 */
export async function startEmacsDaemon(
	emacsPath: string | undefined,
	projectRoot: string,
	sessionId: string,
): Promise<EmacsSession | null> {
	const detection = await detectEmacs(emacsPath);
	if (!detection.found || !detection.meetsMinimum || !detection.socatFound) {
		if (detection.errors.length > 0) {
			logger.debug("emacs: Emacs not available", { errors: detection.errors });
		}
		return null;
	}
	if (!detection.treesitAvailable) {
		logger.warn("emacs: treesit not available in this Emacs build — code intelligence disabled");
		return null;
	}
	try {
		return await startEmacsSession(detection.path!, projectRoot, sessionId, EMACS_ELISP_DIR);
	} catch (err) {
		logger.warn("emacs: Failed to start Emacs session", { error: String(err) });
		return null;
	}
}

/**
 * Build the EmacsToolDependencies from config — starts an Emacs daemon on demand.
 * @deprecated Use startEmacsDaemon at session init and pass session.emacsSession to EmacsTool.
 */
export function makeEmacsSessionFactory(
	emacsPath: string | undefined,
	projectRoot: string,
	sessionId: string,
): () => Promise<EmacsSession | null> {
	return () => startEmacsDaemon(emacsPath, projectRoot, sessionId);
}
