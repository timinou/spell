import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EmacsSession {
	/** Absolute path to the Unix socket the Emacs MCP server is listening on. */
	socketPath: string;
	/** Send kill-emacs to the daemon and remove the socket. */
	stop(): Promise<void>;
	/** True when the socket file still exists. */
	isAlive(): boolean;
}

/**
 * Start (or return an existing) Emacs daemon for the given project + session.
 *
 * Sessions are identified by `hash(projectRoot + sessionId)`. Two calls with
 * the same inputs return the cached session without launching a second daemon.
 * Different project roots always get separate daemons.
 *
 * @param emacsPath   - Absolute path to the emacs binary.
 * @param projectRoot - Absolute path to the project root (used for hashing).
 * @param sessionId   - Opaque session identifier (e.g. Pi session UUID).
 * @param orgElispDir - Path to packages/org/elisp/ for MCP server infrastructure.
 * @param elispDir    - Path to packages/emacs/elisp/ for pi-emacs tools.
 */
export async function startEmacsSession(
	emacsPath: string,
	projectRoot: string,
	sessionId: string,
	elispDir: string,
): Promise<EmacsSession> {
	const key = sessionKey(projectRoot, sessionId);

	const cached = sessions.get(key);
	if (cached?.isAlive()) {
		logger.debug("[emacs-daemon] Returning cached session", { key, socketPath: cached.socketPath });
		return cached;
	}
	// Stale entry — remove before relaunching.
	if (cached) sessions.delete(key);

	const session = await launchDaemon(emacsPath, projectRoot, sessionId, elispDir, key);
	sessions.set(key, session);
	return session;
}

// ---------------------------------------------------------------------------
// Internal session cache
// ---------------------------------------------------------------------------

/** Module-level cache: sessionKey → live EmacsSession. */
const sessions = new Map<string, EmacsSession>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;
// First-run startup compiles all tree-sitter grammars (git clone + cc per language).
// At ~3-5s per grammar × 15 languages = ~75s worst case on a slow connection.
// Subsequent starts use cached .so files and take ~900ms.
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5_000;
// Show a first-run warning after this many ms so users know kika is compiling
// tree-sitter grammars rather than hanging.
const FIRST_RUN_WARN_MS = 8_000;

/** Stable hash key derived from project root + session ID. */
function sessionKey(projectRoot: string, sessionId: string): string {
	// Bun.hash returns a 64-bit unsigned integer (as a number or bigint depending on runtime).
	// We stringify it and take the first 12 hex chars.
	const raw = Bun.hash(projectRoot + sessionId);
	return BigInt(raw).toString(16).slice(0, 12).padStart(12, "0");
}

/** Absolute path to the Unix socket for a given hash key. */
function socketPath(hashHex: string): string {
	const dir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	return path.join(dir, `omp-emacs-${hashHex}.sock`);
}

/** Returns true when the socket file is present on disk. */
async function socketExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		// Permission errors or other unexpected errors: treat as absent to avoid hanging.
		return false;
	}
}

/** Poll until the socket appears or the deadline passes. */
/** Poll until the socket appears or the deadline passes.
 *
 * Emits a one-time progress line to stderr after FIRST_RUN_WARN_MS so users
 * know kika is compiling tree-sitter grammars, not hanging.
 */
async function waitForSocket(p: string, daemonName: string): Promise<void> {
	const start = Date.now();
	const deadline = start + STARTUP_TIMEOUT_MS;
	let warned = false;
	while (Date.now() < deadline) {
		if (await socketExists(p)) return;
		if (!warned && Date.now() - start >= FIRST_RUN_WARN_MS) {
			warned = true;
			process.stderr.write(
				`  Emacs (${daemonName}): installing tree-sitter grammars on first run, may take ~60s...\n`,
			);
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Emacs daemon did not create socket within ${STARTUP_TIMEOUT_MS}ms: ${p}`);
}

async function launchDaemon(
	emacsPath: string,
	projectRoot: string,
	_sessionId: string,
	elispDir: string,
	key: string,
): Promise<EmacsSession> {
	const daemonName = `omp-emacs-${key}`;
	const sock = socketPath(key);

	// Remove stale socket file if it was left by a previous crashed daemon.
	try {
		await fs.unlink(sock);
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("[emacs-daemon] Could not remove stale socket", { sock, err: String(err) });
		}
	}

	// -Q skips the user's init file and all site files.
	// pi-prelude.el bootstraps tree-sitter grammars into Pi's own directory,
	// compiling any that are missing (first run only, then instant).
	// pi-emacs-mcp.el is self-contained: it vendors the MCP infrastructure.
	const args = [
		"-Q",
		`--daemon=${daemonName}`,
		"--eval",
		`(add-to-list 'load-path "${elispDir}")`,
		"--eval",
		// pi-project-root is read by pi-prelude to locate per-project treesitter.json.
		`(setq pi-project-root "${projectRoot}")`,
		"--eval",
		`(require 'pi-prelude)`,
		"--eval",
		`(require 'pi-emacs-mcp)`,
		"--eval",
		`(mcp-server-start-unix nil "${sock}")`,
	];

	logger.debug("[emacs-daemon] Spawning daemon", { daemonName, sock, elispDir });

	// NOT detached: daemon is owned by this process and dies with it.
	const proc = Bun.spawn([emacsPath, ...args], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	// Consume stderr in a background task — logs each line, never blocks process exit.
	if (proc.stderr) {
		(async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
				for (const line of decoder.decode(chunk).split("\n")) {
					if (line.trim()) logger.debug(`[emacs-daemon] ${line.trim()}`, { daemonName });
				}
			}
		})().catch(() => {});
	}

	// Ensure daemon is killed when the parent process exits.
	const cleanup = () => {
		try {
			proc.kill();
		} catch {
			// Already dead — fine.
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// Wait for the daemon to signal readiness by writing the socket.
	try {
		await waitForSocket(sock, daemonName);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[emacs-daemon] Daemon startup timed out", { daemonName, sock, err: msg });
		throw err;
	}

	logger.debug("[emacs-daemon] Daemon ready", { daemonName, sock });

	// Health-check timer: if the socket disappears, evict the session from cache.
	let alive = true;
	const healthTimer = setInterval(async () => {
		if (!(await socketExists(sock))) {
			logger.warn("[emacs-daemon] Socket disappeared — daemon may have crashed", { daemonName, sock });
			alive = false;
			sessions.delete(key);
			clearInterval(healthTimer);
		}
	}, HEALTH_INTERVAL_MS);
	// Do not let the timer block process exit.
	healthTimer.unref();

	return {
		socketPath: sock,

		isAlive(): boolean {
			return alive;
		},

		async stop(): Promise<void> {
			clearInterval(healthTimer);
			alive = false;
			sessions.delete(key);
			process.removeListener("exit", cleanup);
			process.removeListener("SIGINT", cleanup);
			process.removeListener("SIGTERM", cleanup);

			logger.debug("[emacs-daemon] Stopping daemon", { daemonName });

			// Ask emacs to shut itself down gracefully.
			try {
				await Bun.$`emacsclient --socket-name=${daemonName} --eval "(kill-emacs)"`.quiet().nothrow();
			} catch (err) {
				logger.warn("[emacs-daemon] emacsclient kill failed", {
					daemonName,
					err: err instanceof Error ? err.message : String(err),
				});
			}

			// Force-kill if still running.
			try {
				proc.kill();
			} catch {
				// Already dead.
			}

			// Remove socket file if still present.
			try {
				await fs.unlink(sock);
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("[emacs-daemon] Could not remove socket after stop", { sock });
				}
			}
		},
	};
}
